/**
 * Handshake-abuse limits WIRED INTO the gateway: the per-address handshake rate
 * limit (refused at the HTTP upgrade, before any database work) and the
 * per-account concurrent-socket cap with its stale-first eviction.
 *
 * Stub repositories rather than Postgres, deliberately: everything asserted here
 * is transport-layer behavior, so the suite must run everywhere — including where
 * the DB-backed suites skip. The stub also makes the "no database work" claim
 * checkable, by COUNTING the session lookups a refused handshake causes.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSessionToken, type Repositories } from "@demli/db";
import { clientEvent, SERVER_EVENT, serverEnvelopeSchema } from "@demli/protocol";
import type { ServerEnvelope } from "@demli/protocol";
import type {
  AppLifecycleState,
  PresencePayload,
} from "@demli/protocol";
import type { ChannelId, GroupId, PresencePlatform, PresenceStatus, UserId } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { CLOSE_TOO_MANY_CONNECTIONS } from "../connection-limits.js";
import type { PresenceStore } from "../presence.js";

const GROUP_ID = "group-1" as GroupId;
const CHANNEL_ID = "channel-1" as ChannelId;
const USER_A = "user-a" as UserId;
const USER_B = "user-b" as UserId;
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

class StubPresenceStore implements PresenceStore {
  private readonly connections = new Map<UserId, Set<string>>();

  async connect(userId: UserId, connectionId: string): Promise<boolean> {
    let conns = this.connections.get(userId);
    if (!conns) {
      conns = new Set();
      this.connections.set(userId, conns);
    }
    const cameOnline = conns.size === 0;
    conns.add(connectionId);
    return cameOnline;
  }
  async disconnect(userId: UserId, connectionId: string): Promise<boolean> {
    const conns = this.connections.get(userId);
    if (!conns) return false;
    conns.delete(connectionId);
    return conns.size === 0;
  }
  /** Live socket count for this user — the invariant the cap is about. */
  count(userId: UserId): number {
    return this.connections.get(userId)?.size ?? 0;
  }
  async setStatus(): Promise<void> {}
  async getStatus(userId: UserId): Promise<PresenceStatus> {
    return this.count(userId) > 0 ? "online" : "offline";
  }
  async setAppState(_userId: UserId, _connectionId: string, _state: AppLifecycleState) {}
  async getPlatform(): Promise<PresencePlatform | undefined> {
    return undefined;
  }
  async snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]> {
    return [...userIds].map((userId) => ({
      userId,
      status: this.count(userId) > 0 ? ("online" as const) : ("offline" as const),
    }));
  }
}

interface Stubs {
  repos: Repositories;
  /** How many times a handshake reached the session table. */
  sessionLookups: () => number;
}

function makeStubs(): Stubs {
  const byHash = new Map<string, UserId>([
    [hashSessionToken(TOKEN_A), USER_A],
    [hashSessionToken(TOKEN_B), USER_B],
  ]);
  let lookups = 0;

  const repos = {
    sessions: {
      findActiveByTokenHash: async (hash: string) => {
        lookups += 1;
        const userId = byHash.get(hash);
        if (!userId) return null;
        return { session: { id: `session-${userId}` }, user: { id: userId } };
      },
    },
    channels: {
      listForUser: async () => [
        { id: CHANNEL_ID, groupId: GROUP_ID, kind: "text", name: "general" },
      ],
    },
    channelAccess: {
      visibleChannelIdsForUser: async () => [CHANNEL_ID],
      canUserSeeChannel: async () => true,
    },
    groups: {
      listMemberGroupIds: async () => [GROUP_ID],
      listCoMemberUserIds: async (userId: UserId) =>
        [USER_A, USER_B].filter((id) => id !== userId),
    },
    friendships: { listAcceptedFriendIds: async () => [] },
    userBlocks: { relatedIds: async () => new Set<UserId>() },
    users: {
      customStatusesFor: async () => new Map<UserId, string>(),
      findById: async (id: UserId) => ({ id, customStatus: null }),
    },
  } as unknown as Repositories;

  return { repos, sessionLookups: () => lookups };
}

let gateway: Gateway | null = null;
const openSockets: WebSocket[] = [];

interface Started {
  port: number;
  presence: StubPresenceStore;
  stubs: Stubs;
}

async function startGateway(
  options: {
    maxConnectionsPerUser?: number;
    handshakeLimit?: { capacity: number; refillPerSecond: number };
  } = {},
): Promise<Started> {
  const stubs = makeStubs();
  const presence = new StubPresenceStore();
  gateway = createGateway(
    { repos: stubs.repos, presence },
    { port: 0, host: "127.0.0.1", ...options },
  );
  return { port: await gateway.ready, presence, stubs };
}

/** Outcome of one handshake attempt: the close code, or `"open"`. */
class Attempt {
  readonly envelopes: ServerEnvelope[] = [];
  closeCode: number | null = null;
  /** Set when the UPGRADE itself was refused (an HTTP status, not a close code). */
  httpStatus: number | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.envelopes.push(serverEnvelopeSchema.parse(JSON.parse(String(raw))));
    });
    socket.on("close", (code) => {
      this.closeCode = code;
    });
    socket.on("unexpected-response", (_req, res) => {
      this.httpStatus = res.statusCode ?? null;
    });
    socket.on("error", () => undefined);
  }

  static async open(port: number, token: string, forwardedFor?: string): Promise<Attempt> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
      forwardedFor === undefined
        ? undefined
        : { headers: { "x-forwarded-for": forwardedFor } },
    );
    openSockets.push(socket);
    const attempt = new Attempt(socket);
    await new Promise<void>((resolve) => {
      socket.once("open", () => resolve());
      socket.once("close", () => resolve());
      socket.once("unexpected-response", () => resolve());
      socket.once("error", () => resolve());
    });
    return attempt;
  }

  get authed(): boolean {
    return this.envelopes.some((e) => e.event.type === SERVER_EVENT.authSucceeded);
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  async waitForAuth(timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (!this.authed) {
      if (Date.now() - started > timeoutMs) throw new Error("no auth.succeeded");
      await sleep(10);
    }
  }

  async waitForClose(timeoutMs = 4000): Promise<number> {
    const started = Date.now();
    while (this.closeCode === null) {
      if (Date.now() - started > timeoutMs) throw new Error("socket never closed");
      await sleep(10);
    }
    return this.closeCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await gateway?.close();
  gateway = null;
});

// ---------------------------------------------------------------------------
// 1. Handshake rate limit
// ---------------------------------------------------------------------------

describe("gateway — handshake rate limit", () => {
  it("refuses handshakes over the per-address budget WITHOUT touching the database", async () => {
    const { port, stubs } = await startGateway({
      handshakeLimit: { capacity: 2, refillPerSecond: 0 },
    });

    const first = await Attempt.open(port, TOKEN_A, "203.0.113.1");
    await first.waitForAuth();
    const second = await Attempt.open(port, TOKEN_A, "203.0.113.1");
    await second.waitForAuth();
    const lookupsAfterAccepted = stubs.sessionLookups();

    const refused = await Attempt.open(port, TOKEN_A, "203.0.113.1");
    expect(refused.authed).toBe(false);
    // Refused at the upgrade, so the client gets an HTTP 429 rather than a
    // WebSocket close — and can tell "slow down" from "your session is dead".
    expect(refused.httpStatus).toBe(429);
    // The whole point of doing this in `verifyClient`: a refused handshake costs
    // ZERO database round trips, where an accepted one costs ~10.
    expect(stubs.sessionLookups()).toBe(lookupsAfterAccepted);
  });

  it("keys the budget on the forwarded client address, not on the proxy's", async () => {
    // Every socket here arrives from 127.0.0.1 (the test process). If the limit
    // were keyed on the transport address, the second household would be refused
    // by the first household's spending — which is exactly what would happen in
    // production, where every client arrives from Caddy's container address.
    const { port } = await startGateway({
      handshakeLimit: { capacity: 1, refillPerSecond: 0 },
    });

    const household = await Attempt.open(port, TOKEN_A, "203.0.113.10");
    await household.waitForAuth();
    const sameHousehold = await Attempt.open(port, TOKEN_A, "203.0.113.10");
    expect(sameHousehold.httpStatus).toBe(429);

    const elsewhere = await Attempt.open(port, TOKEN_B, "203.0.113.11");
    await elsewhere.waitForAuth();
    expect(elsewhere.authed).toBe(true);
  });

  it("lets a normal multi-device burst through untouched", async () => {
    // Desktop + phone + a few tabs, all reconnecting at once after a deploy. The
    // production budget is 60; this asserts the shape with the default in place.
    const { port } = await startGateway();
    for (let i = 0; i < 8; i++) {
      const attempt = await Attempt.open(port, TOKEN_A, "203.0.113.20");
      await attempt.waitForAuth();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per-account concurrent connection cap
// ---------------------------------------------------------------------------

describe("gateway — per-account connection cap", () => {
  it("admits the new socket and evicts one, holding the account at the cap", async () => {
    const { port, presence } = await startGateway({ maxConnectionsPerUser: 2 });

    const first = await Attempt.open(port, TOKEN_A, "203.0.113.30");
    await first.waitForAuth();
    const second = await Attempt.open(port, TOKEN_A, "203.0.113.31");
    await second.waitForAuth();
    expect(presence.count(USER_A)).toBe(2);

    const third = await Attempt.open(port, TOKEN_A, "203.0.113.32");
    // The NEW connection always wins — a user must never be locked out of their
    // own account by sockets the server has not reaped yet.
    await third.waitForAuth();
    expect(await first.waitForClose()).toBe(CLOSE_TOO_MANY_CONNECTIONS);
    expect(presence.count(USER_A)).toBe(2);
  });

  it("caps each account separately", async () => {
    const { port, presence } = await startGateway({ maxConnectionsPerUser: 1 });

    const a1 = await Attempt.open(port, TOKEN_A, "203.0.113.40");
    await a1.waitForAuth();
    const b1 = await Attempt.open(port, TOKEN_B, "203.0.113.41");
    await b1.waitForAuth();

    const a2 = await Attempt.open(port, TOKEN_A, "203.0.113.42");
    await a2.waitForAuth();
    expect(await a1.waitForClose()).toBe(CLOSE_TOO_MANY_CONNECTIONS);

    // User B's single socket was never touched by user A hitting their cap.
    expect(b1.closeCode).toBeNull();
    expect(presence.count(USER_B)).toBe(1);
  });

  it("evicts the LEAST RECENTLY ACTIVE socket, not the oldest", async () => {
    // The distinction is the whole design: the oldest socket is typically the
    // desktop app opened first thing in the morning, while the stalest is the
    // half-dead one. Here the OLDER socket is the active one.
    const { port } = await startGateway({ maxConnectionsPerUser: 2 });

    const oldButActive = await Attempt.open(port, TOKEN_A, "203.0.113.50");
    await oldButActive.waitForAuth();
    const newerButIdle = await Attempt.open(port, TOKEN_A, "203.0.113.51");
    await newerButIdle.waitForAuth();

    await sleep(20);
    // One frame is all it takes to prove liveness.
    oldButActive.send(clientEvent.typingStart({ channelId: CHANNEL_ID, userId: USER_A }));
    await sleep(50);

    const third = await Attempt.open(port, TOKEN_A, "203.0.113.52");
    await third.waitForAuth();

    expect(await newerButIdle.waitForClose()).toBe(CLOSE_TOO_MANY_CONNECTIONS);
    expect(oldButActive.closeCode).toBeNull();
  });

  it("leaves an account BELOW the cap completely alone", async () => {
    // Multi-device is normal in this product: desktop + phone + tabs must all
    // stay connected at once.
    const { port, presence } = await startGateway({ maxConnectionsPerUser: 5 });
    const attempts: Attempt[] = [];
    for (let i = 0; i < 5; i++) {
      const attempt = await Attempt.open(port, TOKEN_A, `203.0.113.6${i}`);
      await attempt.waitForAuth();
      attempts.push(attempt);
    }
    await sleep(100);
    expect(attempts.every((a) => a.closeCode === null)).toBe(true);
    expect(presence.count(USER_A)).toBe(5);
  });
});
