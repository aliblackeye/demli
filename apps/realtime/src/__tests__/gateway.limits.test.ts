/**
 * Resource-limit / DoS-hardening tests for the gateway.
 *
 * These cover the guards that keep ONE hostile (or broken) socket from taking
 * the whole gateway down: the inbound frame cap, the outbound backpressure
 * reaper, and the per-event-class rate limits. They deliberately run against
 * STUB repositories rather than Postgres — every behavior asserted here lives in
 * the transport layer, so the suite must run everywhere, including where the
 * DB-backed integration suites skip.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSessionToken, type Repositories } from "@demli/db";
import {
  clientEvent,
  SERVER_EVENT,
  type PresencePayload,
  type ServerEnvelope,
} from "@demli/protocol";
import { serverEnvelopeSchema } from "@demli/protocol";
import type { AppLifecycleState } from "@demli/protocol";
import type {
  ChannelId,
  GroupId,
  PresencePlatform,
  PresenceStatus,
  UserId,
} from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import type { PresenceStore } from "../presence.js";

const GROUP_ID = "group-1" as GroupId;
const CHANNEL_ID = "channel-1" as ChannelId;

const USER_A = "user-a" as UserId;
const USER_B = "user-b" as UserId;
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Minimal presence store. Not InMemoryPresenceStore: the backpressure test asks
 * for a snapshot of tens of thousands of users, and this returns it in one pass
 * instead of two awaits per user.
 */
class StubPresenceStore implements PresenceStore {
  private readonly online = new Set<UserId>();
  /** Extra users the snapshot should report, to inflate `auth.succeeded`. */
  padding: UserId[] = [];

  async connect(userId: UserId): Promise<boolean> {
    const cameOnline = !this.online.has(userId);
    this.online.add(userId);
    return cameOnline;
  }
  async disconnect(userId: UserId): Promise<boolean> {
    return this.online.delete(userId);
  }
  async setStatus(): Promise<void> {}
  async getStatus(userId: UserId): Promise<PresenceStatus> {
    return this.online.has(userId) ? "online" : "offline";
  }
  async setAppState(_userId: UserId, _connectionId: string, _state: AppLifecycleState) {}
  async getPlatform(): Promise<PresencePlatform | undefined> {
    return undefined;
  }
  async snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]> {
    const own = [...userIds].map((userId) => ({
      userId,
      status: this.online.has(userId) ? ("online" as const) : ("offline" as const),
    }));
    return [...own, ...this.padding.map((userId) => ({ userId, status: "online" as const }))];
  }
}

interface StubOptions {
  /** userId → session token. Every listed user can authenticate. */
  users: Record<string, string>;
}

function makeRepos(options: StubOptions): Repositories {
  const byHash = new Map<string, UserId>();
  for (const [userId, token] of Object.entries(options.users)) {
    byHash.set(hashSessionToken(token), userId as UserId);
  }
  const allUsers = Object.keys(options.users) as UserId[];

  return {
    sessions: {
      findActiveByTokenHash: async (hash: string) => {
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
    },
    groups: {
      listMemberGroupIds: async () => [GROUP_ID],
      // Everyone shares the one group, so each user's presence audience is
      // "everybody else" — self excluded, exactly like the real repository.
      listCoMemberUserIds: async (userId: UserId) => allUsers.filter((id) => id !== userId),
    },
    friendships: {
      listAcceptedFriendIds: async () => [],
    },
    userBlocks: {
      relatedIds: async () => new Set<UserId>(),
    },
    users: {
      customStatusesFor: async () => new Map<UserId, string>(),
      findById: async (id: UserId) => ({ id, customStatus: null }),
    },
  } as unknown as Repositories;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gateway: Gateway | null = null;
const openSockets: Array<{ destroy: () => void }> = [];

async function startGatewayWith(
  repos: Repositories,
  presence: PresenceStore,
  options: { heartbeatIntervalMs?: number; maxBufferedBytes?: number } = {},
): Promise<number> {
  gateway = createGateway({ repos, presence }, { port: 0, host: "127.0.0.1", ...options });
  return gateway.ready;
}

async function startGateway(
  repos: Repositories,
  presence: PresenceStore,
  heartbeatIntervalMs?: number,
): Promise<number> {
  return startGatewayWith(
    repos,
    presence,
    heartbeatIntervalMs ? { heartbeatIntervalMs } : {},
  );
}

/** A `ws` client that records every enveloped frame it receives. */
class Client {
  readonly envelopes: ServerEnvelope[] = [];
  readonly closed: Promise<number>;

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => socket.on("close", (code) => resolve(code)));
    socket.on("message", (raw) => {
      this.envelopes.push(serverEnvelopeSchema.parse(JSON.parse(String(raw))));
    });
    socket.on("error", () => undefined);
  }

  static async connect(
    port: number,
    token: string,
    options: { awaitAuth?: boolean } = {},
  ): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const client = new Client(socket);
    openSockets.push({ destroy: () => socket.terminate() });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    if (options.awaitAuth !== false) await client.waitFor(SERVER_EVENT.authSucceeded);
    return client;
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  count(type: string): number {
    return this.envelopes.filter((e) => e.event.type === type).length;
  }

  async waitFor(type: string, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (this.count(type) === 0) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await sleep(10);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await gateway?.close();
  gateway = null;
});

// ---------------------------------------------------------------------------
// 1. Inbound frame cap (maxPayload)
// ---------------------------------------------------------------------------

describe("gateway — inbound frame cap", () => {
  it("closes the connection with 1009 when a frame exceeds the cap", async () => {
    const port = await startGateway(makeRepos({ users: { [USER_A]: TOKEN_A } }), new StubPresenceStore());
    const client = await Client.connect(port, TOKEN_A);

    // 96 KiB — comfortably over the 64 KiB ceiling, and ~4x the largest frame
    // the protocol can legitimately produce.
    client.sendRaw("x".repeat(96 * 1024));

    await expect(client.closed).resolves.toBe(1009);
  });

  it("still accepts (and rejects on content, not size) a large but in-cap frame", async () => {
    const port = await startGateway(makeRepos({ users: { [USER_A]: TOKEN_A } }), new StubPresenceStore());
    const client = await Client.connect(port, TOKEN_A);

    // 60 KiB: under the cap, so the size guard must NOT fire — the frame reaches
    // the JSON parser and is refused as malformed (1003), proving the cap is a
    // size ceiling and not a blanket "large frames are hostile" rule.
    client.sendRaw("x".repeat(60 * 1024));

    await expect(client.closed).resolves.toBe(1003);
  });

  it("survives an oversized frame — the server keeps serving other clients", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
    );
    const attacker = await Client.connect(port, TOKEN_A);
    attacker.sendRaw("x".repeat(96 * 1024));
    await attacker.closed;

    const victim = await Client.connect(port, TOKEN_B);
    expect(victim.count(SERVER_EVENT.authSucceeded)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Outbound backpressure
// ---------------------------------------------------------------------------

describe("gateway — outbound backpressure", () => {
  /**
   * Wiring proof for the guard whose POLICY is covered exhaustively (and
   * deterministically) in `backpressure.test.ts`.
   *
   * The ceiling is injected BELOW zero so that every write attempt is over
   * budget regardless of what the kernel happens to have flushed. That is
   * deliberate: `bufferedAmount` only grows once the OS refuses bytes, so any
   * traffic-shaped assertion here would be a race against socket-buffer
   * autotuning rather than a test of our code. What this pins down is the part
   * that can actually regress — that `sendEvent` consults the guard BEFORE
   * writing, and that tripping it terminates the connection instead of queueing.
   *
   * The heartbeat stays at its 30 s default, so the ping reaper cannot be what
   * closes the socket.
   */
  it("terminates a connection instead of writing when the guard trips", async () => {
    const port = await startGatewayWith(
      makeRepos({ users: { [USER_A]: TOKEN_A } }),
      new StubPresenceStore(),
      { maxBufferedBytes: -1 },
    );
    const victim = await Client.connect(port, TOKEN_A, { awaitAuth: false });

    await expect(
      Promise.race([
        victim.closed,
        sleep(4000).then(() => Promise.reject(new Error("victim was not dropped"))),
      ]),
    ).resolves.toBeTypeOf("number");
    // Dropped BEFORE the write: not even the handshake frame was delivered.
    expect(victim.count(SERVER_EVENT.authSucceeded)).toBe(0);
  });

  it("leaves a healthy client connected across several heartbeats", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A } }),
      new StubPresenceStore(),
      50,
    );
    const client = await Client.connect(port, TOKEN_A);

    let closedEarly = false;
    void client.closed.then(() => {
      closedEarly = true;
    });

    await sleep(400); // ~8 heartbeat ticks
    expect(closedEarly).toBe(false);
  });

  it("does not drop a client whose queue stays under the default ceiling", async () => {
    // Same traffic shape as the drop test, but with the production ceiling: a
    // burst of broadcasts nowhere near 1 MiB must leave the connection alone.
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
      50,
    );
    const victim = await Client.connect(port, TOKEN_A);
    const sender = await Client.connect(port, TOKEN_B);

    let closedEarly = false;
    void victim.closed.then(() => {
      closedEarly = true;
    });
    for (let i = 0; i < 10; i++) {
      sender.send(clientEvent.typingStart({ channelId: CHANNEL_ID, userId: USER_B }));
    }
    await sleep(300);

    expect(closedEarly).toBe(false);
    expect(victim.count(SERVER_EVENT.typingStarted)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-event rate limits
// ---------------------------------------------------------------------------

describe("gateway — typing rate limit", () => {
  it("passes a normal composer burst untouched", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
    );
    const sender = await Client.connect(port, TOKEN_A);
    const watcher = await Client.connect(port, TOKEN_B);

    // 10 frames is already ~40 s of real typing (clients throttle typing.start
    // to one per 4 s per channel) and must pass in full.
    for (let i = 0; i < 10; i++) {
      sender.send(clientEvent.typingStart({ channelId: CHANNEL_ID, userId: USER_A }));
    }
    await sleep(200);

    expect(watcher.count(SERVER_EVENT.typingStarted)).toBe(10);
  });

  it("caps a flood at the bucket instead of fanning it out", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
    );
    const sender = await Client.connect(port, TOKEN_A);
    const watcher = await Client.connect(port, TOKEN_B);

    for (let i = 0; i < 200; i++) {
      sender.send(clientEvent.typingStart({ channelId: CHANNEL_ID, userId: USER_A }));
    }
    await sleep(200);

    const seen = watcher.count(SERVER_EVENT.typingStarted);
    // Capacity is 20; the small refill during delivery may add a couple more.
    expect(seen).toBeGreaterThanOrEqual(20);
    expect(seen).toBeLessThan(40);
  });
});

describe("gateway — presence.update rate limit", () => {
  it("caps a flood at the bucket, and the connection survives it", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
    );
    const watcher = await Client.connect(port, TOKEN_B);
    const sender = await Client.connect(port, TOKEN_A);
    // The connect itself broadcasts one presence.updated to the watcher.
    await watcher.waitFor(SERVER_EVENT.presenceUpdated);
    const baseline = watcher.count(SERVER_EVENT.presenceUpdated);

    for (let i = 0; i < 100; i++) {
      sender.send(
        clientEvent.presenceUpdate({ userId: USER_A, status: i % 2 === 0 ? "idle" : "online" }),
      );
    }
    await sleep(300);

    const delivered = watcher.count(SERVER_EVENT.presenceUpdated) - baseline;
    // Capacity is 10, refilling at 1/s — a couple of extra tokens may land
    // during delivery, but nothing close to the 100 frames sent.
    expect(delivered).toBeGreaterThanOrEqual(10);
    expect(delivered).toBeLessThan(20);

    // Rate limiting must SHED load, never kill an otherwise valid session.
    let closedEarly = false;
    void sender.closed.then(() => {
      closedEarly = true;
    });
    await sleep(50);
    expect(closedEarly).toBe(false);
  });
});

describe("gateway — voice control rate limit", () => {
  it("caps join/leave churn without dropping the session", async () => {
    const port = await startGateway(
      makeRepos({ users: { [USER_A]: TOKEN_A, [USER_B]: TOKEN_B } }),
      new StubPresenceStore(),
    );
    const sender = await Client.connect(port, TOKEN_A);
    const watcher = await Client.connect(port, TOKEN_B);

    // CHANNEL_ID is a text channel, so every join is refused — the point is that
    // the ERROR replies are bounded too, since an unbounded 1:1 reply is itself
    // an amplification channel.
    for (let i = 0; i < 200; i++) {
      sender.send(clientEvent.voiceJoin({ channelId: CHANNEL_ID }));
    }
    await sleep(200);

    const errors = sender.count(SERVER_EVENT.errorRaised);
    expect(errors).toBeGreaterThanOrEqual(30);
    expect(errors).toBeLessThan(60);
    expect(watcher.count(SERVER_EVENT.voiceParticipantJoined)).toBe(0);
  });
});
