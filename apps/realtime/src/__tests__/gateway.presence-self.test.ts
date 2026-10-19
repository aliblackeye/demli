/**
 * M16 — presence about the user THEMSELVES (stub repos, no database).
 *
 * The bug this pins, found by the first run of the integration suites against a
 * real Postgres: `groups.listCoMemberUserIds` includes the user (they are a
 * member of their own groups), the gateway used it as the presence audience
 * as-is, and so every broadcast sent the user their own PEER-FACING presence —
 * masked. Someone who picked "invisible" was told "offline" about themselves,
 * live and in every handshake snapshot, and both clients painted that on their
 * own dot. Every unit-test stub at the time EXCLUDED self ("exactly like the real
 * repository" — it was not), which is why only a real database surfaced it.
 *
 * So the stubs below deliberately INCLUDE self, like the real repository, and
 * the presence store is the real `InMemoryPresenceStore` (real ADR 0020
 * derivation). The contract under test (packages/protocol `PresencePayload`):
 *  - peers get the masked status (`invisible` → `offline`);
 *  - the user's OWN sockets get the REAL status — never `offline` — so a status
 *    picked on one device reaches the other devices;
 *  - the socket whose handshake triggered a broadcast is left out of it;
 *  - the handshake snapshot holds peers only.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  hashSessionToken,
  InMemoryMutationBus,
  type Repositories,
} from "@demli/db";
import {
  clientEvent,
  serverEnvelopeSchema,
  serverEvent,
  SERVER_EVENT,
  type PresencePayload,
  type ServerEnvelope,
} from "@demli/protocol";
import type { ChannelId, GroupId, PresencePlatform, PresenceStatus, UserId } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore, type PresenceStore } from "../presence.js";

const GROUP_ID = "group-self" as GroupId;
const CHANNEL_ID = "channel-self" as ChannelId;

const ME = "user-me" as UserId;
const PEER = "user-peer" as UserId;
const TOKEN_ME = "token-me";
const TOKEN_PEER = "token-peer";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface World {
  /** Delay (ms) applied to the NEXT co-member query only, then reset to 0. */
  delayNextCoMemberQueryMs: number;
}

function makeRepos(world: World): Repositories {
  const users: Record<string, UserId> = { [TOKEN_ME]: ME, [TOKEN_PEER]: PEER };
  const byHash = new Map<string, UserId>();
  for (const [token, userId] of Object.entries(users)) byHash.set(hashSessionToken(token), userId);
  const members = [ME, PEER];

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
      canUserSeeChannel: async () => true,
    },
    groups: {
      listMemberGroupIds: async () => [GROUP_ID],
      // INCLUDES the user, exactly like the real `listCoMemberUserIds` (a user is
      // a member of their own group). The gateway must not rely on a stub that
      // happens to leave them out.
      listCoMemberUserIds: async () => {
        const delay = world.delayNextCoMemberQueryMs;
        world.delayNextCoMemberQueryMs = 0;
        if (delay > 0) await sleep(delay);
        return [...members];
      },
    },
    friendships: { listAcceptedFriendIds: async () => [] },
    userBlocks: { relatedIds: async () => new Set<UserId>() },
    users: {
      customStatusesFor: async () => new Map<UserId, string>(),
      findById: async (id: UserId) => ({ id, customStatus: null }),
    },
  } as unknown as Repositories;
}

/**
 * The real store, with an optional gate on `connect` so a test can hold a socket
 * in the window where the gateway has registered it but the store has not.
 */
class GatedPresenceStore extends InMemoryPresenceStore {
  gate: Promise<void> | null = null;

  override async connect(
    userId: UserId,
    connectionId: string,
    platform?: PresencePlatform,
  ): Promise<boolean> {
    if (this.gate) await this.gate;
    return super.connect(userId, connectionId, platform);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gateway: Gateway | null = null;
const openSockets: WebSocket[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start(
  presence: PresenceStore,
  world: World = { delayNextCoMemberQueryMs: 0 },
  mutationBus?: InMemoryMutationBus,
): Promise<number> {
  gateway = createGateway(
    { repos: makeRepos(world), presence, ...(mutationBus ? { mutationBus } : {}) },
    { port: 0, host: "127.0.0.1" },
  );
  return gateway.ready;
}

class Client {
  readonly envelopes: ServerEnvelope[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.envelopes.push(serverEnvelopeSchema.parse(JSON.parse(String(raw))));
    });
    socket.on("error", () => undefined);
  }

  static async open(port: number, token: string, platform?: PresencePlatform): Promise<Client> {
    const query = `?token=${encodeURIComponent(token)}${platform ? `&platform=${platform}` : ""}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    openSockets.push(socket);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  static async connect(port: number, token: string, platform?: PresencePlatform): Promise<Client> {
    const client = await Client.open(port, token, platform);
    await client.until(() => client.authSnapshot() !== null);
    return client;
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  /** The `auth.succeeded` presence snapshot, once received. */
  authSnapshot(): PresencePayload[] | null {
    for (const { event } of this.envelopes) {
      if (event.type === SERVER_EVENT.authSucceeded) return event.payload.presence;
    }
    return null;
  }

  /** Every `presence.updated` payload about `userId`, in arrival order. */
  presenceAbout(userId: UserId, from = 0): PresencePayload[] {
    return this.envelopes.slice(from).flatMap(({ event }) =>
      event.type === SERVER_EVENT.presenceUpdated && event.payload.userId === userId
        ? [event.payload]
        : [],
    );
  }

  /** Statuses only — the shape most assertions want. */
  statusesAbout(userId: UserId, from = 0): PresenceStatus[] {
    return this.presenceAbout(userId, from).map((p) => p.status);
  }

  lastStatusAbout(userId: UserId, from = 0): PresenceStatus | undefined {
    return this.statusesAbout(userId, from).at(-1);
  }

  get mark(): number {
    return this.envelopes.length;
  }

  async until(predicate: () => boolean, label = "condition", timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `timed out waiting for ${label}; saw [${this.envelopes.map((e) => e.event.type).join(", ")}]`,
        );
      }
      await sleep(10);
    }
  }
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await gateway?.close();
  gateway = null;
});

/** Send a declaration from `client` for ME. */
function declare(client: Client, status: PresenceStatus): void {
  client.send(clientEvent.presenceUpdate({ userId: ME, status }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway — presence about the user themselves (M16)", () => {
  it("an invisible user is never told they are offline; co-members are", async () => {
    const port = await start(new InMemoryPresenceStore());
    const peer = await Client.connect(port, TOKEN_PEER);
    const me = await Client.connect(port, TOKEN_ME, "desktop");
    await peer.until(() => peer.lastStatusAbout(ME) === "online", "ME's connect broadcast");

    const peerMark = peer.mark;
    const meMark = me.mark;
    declare(me, "invisible");

    await peer.until(() => peer.lastStatusAbout(ME, peerMark) === "offline", "peer sees offline");
    await me.until(() => me.lastStatusAbout(ME, meMark) === "invisible", "self sees invisible");

    // Self: the REAL status, and never the peer mask — at any point of the run.
    expect(me.statusesAbout(ME)).not.toContain("offline");
    expect(me.presenceAbout(ME, meMark).at(-1)).toEqual({
      userId: ME,
      status: "invisible",
      platform: "desktop",
    });
    // Peer: masked, and an offline user carries no platform.
    expect(peer.presenceAbout(ME, peerMark).at(-1)).toEqual({ userId: ME, status: "offline" });
  });

  it("the handshake snapshot holds peers only — never the connecting user", async () => {
    const port = await start(new InMemoryPresenceStore());
    const peer = await Client.connect(port, TOKEN_PEER);
    // ME's first device goes invisible, so a masked self entry would read "offline".
    const first = await Client.connect(port, TOKEN_ME, "desktop");
    declare(first, "invisible");
    await peer.until(() => peer.lastStatusAbout(ME) === "offline", "ME invisible");

    const second = await Client.connect(port, TOKEN_ME, "mobile");
    const snapshot = second.authSnapshot() ?? [];
    expect(snapshot.map((p) => p.userId)).toEqual([PEER]);
    expect(snapshot.find((p) => p.userId === ME)).toBeUndefined();
    // And the peer's snapshot does carry ME — masked.
    const peerAgain = await Client.connect(port, TOKEN_PEER);
    expect(peerAgain.authSnapshot()).toContainEqual({ userId: ME, status: "offline" });
  });

  it("a status picked on one device reaches the user's OTHER device, unmasked", async () => {
    const port = await start(new InMemoryPresenceStore());
    const peer = await Client.connect(port, TOKEN_PEER);
    const desktop = await Client.connect(port, TOKEN_ME, "desktop");
    await peer.until(() => peer.lastStatusAbout(ME) === "online", "ME online");
    const phone = await Client.connect(port, TOKEN_ME, "mobile");

    // Phone goes invisible → the desktop's own dot must show invisible, not offline.
    let deskMark = desktop.mark;
    let peerMark = peer.mark;
    declare(phone, "invisible");
    await desktop.until(() => desktop.lastStatusAbout(ME, deskMark) === "invisible", "desk invisible");
    await peer.until(() => peer.lastStatusAbout(ME, peerMark) === "offline", "peer offline");

    // Phone switches to dnd → the desktop follows, and so do peers (dnd is not masked).
    deskMark = desktop.mark;
    peerMark = peer.mark;
    declare(phone, "dnd");
    await desktop.until(() => desktop.lastStatusAbout(ME, deskMark) === "dnd", "desk dnd");
    await peer.until(() => peer.lastStatusAbout(ME, peerMark) === "dnd", "peer dnd");

    // The desktop itself picks "online": the ORIGINATING device gets the derived
    // answer back — the phone's dnd still holds for the account (ADR 0020).
    deskMark = desktop.mark;
    const phoneMark = phone.mark;
    declare(desktop, "online");
    await desktop.until(() => desktop.statusesAbout(ME, deskMark).length > 0, "desk echo");
    expect(desktop.lastStatusAbout(ME, deskMark)).toBe("dnd");
    await phone.until(() => phone.statusesAbout(ME, phoneMark).length > 0, "phone echo");
    expect(phone.lastStatusAbout(ME, phoneMark)).toBe("dnd");

    // Releasing dnd on the phone releases both devices to online.
    deskMark = desktop.mark;
    declare(phone, "online");
    await desktop.until(() => desktop.lastStatusAbout(ME, deskMark) === "online", "desk online");

    for (const client of [desktop, phone]) expect(client.statusesAbout(ME)).not.toContain("offline");
  });

  it("the connecting socket gets no connect-time echo of itself; the user's other device does", async () => {
    const port = await start(new InMemoryPresenceStore());
    const peer = await Client.connect(port, TOKEN_PEER);
    const desktop = await Client.connect(port, TOKEN_ME, "desktop");
    // The desktop goes idle; it is the only device, so the account is idle.
    declare(desktop, "idle");
    await peer.until(() => peer.lastStatusAbout(ME) === "idle", "ME idle");

    // A phone connects: its default declaration makes the account online again,
    // so the connect path re-derives and broadcasts.
    const deskMark = desktop.mark;
    const phone = await Client.connect(port, TOKEN_ME, "mobile");
    await desktop.until(() => desktop.lastStatusAbout(ME, deskMark) === "online", "desk sees online");
    await peer.until(() => peer.lastStatusAbout(ME) === "online", "peer sees online");
    // Give any stray self frame for the phone time to arrive before asserting none did.
    await sleep(100);
    expect(phone.presenceAbout(ME)).toEqual([]);

    // Its own re-assert is what brings the phone its real status.
    declare(phone, "invisible");
    await phone.until(() => phone.lastStatusAbout(ME) === "invisible", "phone invisible");
    await desktop.until(() => desktop.lastStatusAbout(ME) === "invisible", "desk invisible");
    await peer.until(() => peer.lastStatusAbout(ME) === "offline", "peer offline");
    expect(peer.statusesAbout(ME)).not.toContain("invisible");
  });

  it("never sends a user 'offline' about themselves, even while the store has not registered the socket", async () => {
    const presence = new GatedPresenceStore();
    const bus = new InMemoryMutationBus();
    const port = await start(presence, { delayNextCoMemberQueryMs: 0 }, bus);
    const peer = await Client.connect(port, TOKEN_PEER);

    // Hold ME's handshake inside `presence.connect`: the gateway has registered
    // the socket for delivery, the store does not know it yet ⇒ status "offline".
    let release!: () => void;
    presence.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const me = await Client.open(port, TOKEN_ME, "desktop");
    await sleep(100);

    // A presence re-broadcast fires in that window (a custom-status change does).
    const peerMark = peer.mark;
    await bus.publish({
      userId: ME,
      event: serverEvent.customStatusUpdated({ userId: ME, text: "afk", expiresAt: null }),
    });
    await me.until(
      () => me.envelopes.some((e) => e.event.type === SERVER_EVENT.customStatusUpdated),
      "custom status event",
    );
    await peer.until(() => peer.statusesAbout(ME, peerMark).length > 0, "peer re-broadcast");
    expect(peer.lastStatusAbout(ME, peerMark)).toBe("offline"); // peers: truthful for the store
    await sleep(50);
    expect(me.statusesAbout(ME)).not.toContain("offline");

    presence.gate = null;
    release();
    await me.until(() => me.authSnapshot() !== null, "auth.succeeded");
  });

  it("a later status never loses to an earlier broadcast stuck on a slow audience query", async () => {
    const world: World = { delayNextCoMemberQueryMs: 0 };
    const port = await start(new InMemoryPresenceStore(), world);
    const peer = await Client.connect(port, TOKEN_PEER);
    const me = await Client.connect(port, TOKEN_ME, "desktop");
    await peer.until(() => peer.lastStatusAbout(ME) === "online", "ME online");

    // The first broadcast's audience query is slow; the second one's is not. Two
    // quick picks: dnd, then online. Pre-fix the slow broadcast had already read
    // "dnd" before its query and delivered it LAST, leaving everyone — the user
    // included — on a status nobody had declared for a while.
    const peerMark = peer.mark;
    const meMark = me.mark;
    world.delayNextCoMemberQueryMs = 200;
    declare(me, "dnd");
    await sleep(30);
    declare(me, "online");

    await sleep(400);
    expect(peer.statusesAbout(ME, peerMark).length).toBeGreaterThanOrEqual(2);
    expect(peer.lastStatusAbout(ME, peerMark)).toBe("online");
    expect(me.lastStatusAbout(ME, meMark)).toBe("online");
  });
});
