/**
 * Client-identity gate — WebSocket half.
 *
 * The HTTP gate alone is not enough: chat, presence and voice signalling all
 * live on this socket, so an old client refused by the API but still connected
 * here would keep RECEIVING messages it can no longer send. Both doors close or
 * neither does.
 *
 * Runs against STUB repositories, like gateway.limits.test.ts: everything
 * asserted here happens in the handshake, before the session lookup, so the suite
 * must run everywhere — including where the DB-backed integration suites skip.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashSessionToken, type Repositories } from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import type { AppLifecycleState, PresencePayload } from "@demli/protocol";
import type {
  ChannelId,
  GroupId,
  PresencePlatform,
  PresenceStatus,
  UserId,
} from "@demli/types";
import { createGateway, CLOSE_CLIENT_UPDATE_REQUIRED, type Gateway } from "../gateway.js";
import type { PresenceStore } from "../presence.js";

const GROUP_ID = "group-1" as GroupId;
const CHANNEL_ID = "channel-1" as ChannelId;
const USER_A = "user-a" as UserId;
const TOKEN_A = "token-a";

/** The value a current build actually puts on the wire. */
const VALID_MARK = "demli-desktop/0.0.81";

class StubPresenceStore implements PresenceStore {
  private readonly online = new Set<UserId>();

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
    return [...userIds].map((userId) => ({
      userId,
      status: this.online.has(userId) ? ("online" as const) : ("offline" as const),
    }));
  }
}

function makeRepos(): Repositories {
  const byHash = new Map<string, UserId>([[hashSessionToken(TOKEN_A), USER_A]]);
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
      listCoMemberUserIds: async () => [],
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

let gateway: Gateway | null = null;
const openSockets: WebSocket[] = [];

async function startGateway(clientGate?: boolean): Promise<number> {
  gateway = createGateway(
    { repos: makeRepos(), presence: new StubPresenceStore() },
    {
      port: 0,
      host: "127.0.0.1",
      ...(clientGate === undefined ? {} : { clientGate }),
    },
  );
  return gateway.ready;
}

/**
 * Connect and report what happened: either the close code, or `"auth.succeeded"`
 * when the handshake completed normally. One helper for both outcomes so a test
 * cannot accidentally assert "did not close" while the socket was never accepted.
 */
async function connectAndSettle(port: number, query: string): Promise<number | "auth.succeeded"> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
  openSockets.push(socket);
  socket.on("error", () => undefined);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake never settled")), 4000);
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame?.event?.type === SERVER_EVENT.authSucceeded) {
        clearTimeout(timer);
        resolve("auth.succeeded");
      }
    });
  });
}

const authed = (mark?: string): string =>
  `?token=${encodeURIComponent(TOKEN_A)}${mark === undefined ? "" : `&client=${encodeURIComponent(mark)}`}`;

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await gateway?.close();
  gateway = null;
});

describe("gateway client gate — disarmed by default", () => {
  it("accepts an unmarked handshake when the option is omitted", async () => {
    const port = await startGateway();
    await expect(connectAndSettle(port, authed())).resolves.toBe("auth.succeeded");
  });

  it("accepts an unmarked handshake when explicitly disarmed", async () => {
    const port = await startGateway(false);
    await expect(connectAndSettle(port, authed())).resolves.toBe("auth.succeeded");
  });
});

describe("gateway client gate — armed", () => {
  it("closes an unmarked handshake with 4426", async () => {
    const port = await startGateway(true);
    await expect(connectAndSettle(port, authed())).resolves.toBe(CLOSE_CLIENT_UPDATE_REQUIRED);
    expect(CLOSE_CLIENT_UPDATE_REQUIRED).toBe(4426);
  });

  it("closes with 4426 BEFORE the token is even looked at", async () => {
    const port = await startGateway(true);
    // No token at all. Un-gated this is 4401 (missing token); armed, identity is
    // decided first, so a retired client never costs a session lookup.
    await expect(connectAndSettle(port, "")).resolves.toBe(CLOSE_CLIENT_UPDATE_REQUIRED);
  });

  it("admits a marked handshake", async () => {
    const port = await startGateway(true);
    await expect(connectAndSettle(port, authed(VALID_MARK))).resolves.toBe("auth.succeeded");
  });

  it.each(["demli-mobile/2.0.0", "demli-web/1", "demli-desktop/0.0.81"])(
    "admits the mark %s",
    async (mark) => {
      const port = await startGateway(true);
      await expect(connectAndSettle(port, authed(mark))).resolves.toBe("auth.succeeded");
    },
  );

  it.each(["", "demli-desktop", "other-desktop/1.0.0", "Demli-Desktop/1", "demli/1.0"])(
    "closes the malformed mark %j with 4426",
    async (mark) => {
      const port = await startGateway(true);
      await expect(connectAndSettle(port, authed(mark))).resolves.toBe(
        CLOSE_CLIENT_UPDATE_REQUIRED,
      );
    },
  );

  it("still rejects a marked handshake carrying a bad token, with 4401", async () => {
    const port = await startGateway(true);
    // The gate replaces nothing: a NEW client with a dead session must still get
    // the ordinary auth refusal, not the "go install another app" one.
    const settled = await connectAndSettle(
      port,
      `?token=not-a-real-token&client=${encodeURIComponent(VALID_MARK)}`,
    );
    expect(settled).toBe(4401);
  });
});
