/**
 * Gateway voice occupancy + the DM → group upgrade ordering — over STUB
 * repositories, so it runs where the DB-backed integration suites skip.
 *
 * 1. Occupancy is counted per CONNECTION. A user present on two sockets (a
 *    reconnect whose old socket is reaped late, or a second device in the same
 *    room) must not vanish from the room when one of them goes away.
 * 2. `voice.resync` asks the media plane for the room an upgraded call's voice
 *    channel REALLY runs in (`dmcall:<id>`), not its channel id.
 * 3. `call.upgraded` can be handled before the new group's `member.joined`
 *    (bus handlers run concurrently and member.joined awaits the DB). The
 *    original participants' `voice.join` must still be accepted.
 */

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  hashSessionToken,
  type RealtimeMutation,
  type RealtimeMutationBus,
  type Repositories,
} from "@demli/db";
import {
  clientEvent,
  SERVER_EVENT,
  serverEnvelopeSchema,
  serverEvent,
  type PresencePayload,
  type ServerEnvelope,
  type VoiceOccupant,
} from "@demli/protocol";
import type {
  Channel,
  ChannelId,
  GroupId,
  PresencePlatform,
  PresenceStatus,
  UserId,
} from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import type { PresenceStore } from "../presence.js";
import type { VoiceOccupancyReader } from "../voice-occupancy.js";

const SERVER = "server-1" as GroupId;
const LOBBY = "lobby-1" as ChannelId;
const UPGRADED_GROUP = "group-2" as GroupId;
const UPGRADED_STREAM = "stream-2" as ChannelId;
const UPGRADED_VOICE = "voice-2" as ChannelId;
const CALL_ROOM = "dmcall:call-2";

const ALI = "user-ali" as UserId;
const BURAK = "user-burak" as UserId;
const CAN = "user-can" as UserId;
const TOKENS: Record<string, string> = { [ALI]: "t-ali", [BURAK]: "t-burak", [CAN]: "t-can" };

class StubPresenceStore implements PresenceStore {
  private readonly conns = new Map<UserId, number>();
  async connect(userId: UserId): Promise<boolean> {
    const n = this.conns.get(userId) ?? 0;
    this.conns.set(userId, n + 1);
    return n === 0;
  }
  async disconnect(userId: UserId): Promise<boolean> {
    const n = (this.conns.get(userId) ?? 1) - 1;
    if (n <= 0) this.conns.delete(userId);
    else this.conns.set(userId, n);
    return n <= 0;
  }
  async setStatus(): Promise<void> {}
  async getStatus(userId: UserId): Promise<PresenceStatus> {
    return this.conns.has(userId) ? "online" : "offline";
  }
  async setAppState(): Promise<void> {}
  async getPlatform(): Promise<PresencePlatform | undefined> {
    return undefined;
  }
  async snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]> {
    return [...userIds].map((userId) => ({ userId, status: "online" as const }));
  }
}

/** A synchronous in-process bus: `publish` runs the gateway's handler at once. */
class LoopbackBus implements RealtimeMutationBus {
  private handler: ((m: RealtimeMutation) => void) | null = null;
  async publish(mutation: RealtimeMutation): Promise<void> {
    this.handler?.(mutation);
  }
  async subscribe(handler: (m: RealtimeMutation) => void): Promise<void> {
    this.handler = handler;
  }
  async close(): Promise<void> {}
}

interface World {
  /** groupId → member userIds */
  members: Map<GroupId, Set<UserId>>;
  channels: Channel[];
  livekitRooms: Map<ChannelId, string>;
  /** Delay applied to `listForGroup` — the DB latency behind the race. */
  listForGroupDelayMs: number;
  /** Delay applied to `findWithMembership` — voice.join's authority read. */
  findWithMembershipDelayMs: number;
}

function makeWorld(): World {
  return {
    members: new Map([[SERVER, new Set([ALI, BURAK, CAN])]]),
    channels: [{ id: LOBBY, groupId: SERVER, kind: "voice", name: "lobby" } as Channel],
    livekitRooms: new Map(),
    listForGroupDelayMs: 0,
    findWithMembershipDelayMs: 0,
  };
}

function makeRepos(world: World): Repositories {
  const byHash = new Map(Object.entries(TOKENS).map(([u, t]) => [hashSessionToken(t), u as UserId]));
  const groupsOf = (userId: UserId) =>
    [...world.members].filter(([, m]) => m.has(userId)).map(([g]) => g);
  const channelsOf = (userId: UserId) =>
    world.channels.filter((c) => groupsOf(userId).includes(c.groupId));
  return {
    sessions: {
      findActiveByTokenHash: async (hash: string) => {
        const userId = byHash.get(hash);
        return userId ? { session: { id: `s-${userId}-${Math.random()}` }, user: { id: userId } } : null;
      },
    },
    channels: {
      listForUser: async (userId: UserId) => channelsOf(userId),
      listForGroup: async (groupId: GroupId) => {
        if (world.listForGroupDelayMs > 0) await sleep(world.listForGroupDelayMs);
        return world.channels.filter((c) => c.groupId === groupId);
      },
      findWithMembership: async (channelId: ChannelId, userId: UserId) => {
        if (world.findWithMembershipDelayMs > 0) await sleep(world.findWithMembershipDelayMs);
        const channel = channelsOf(userId).find((c) => c.id === channelId);
        return channel
          ? {
              channel,
              role: "member",
              livekitRoom: world.livekitRooms.get(channelId) ?? null,
              timedOutUntil: null,
            }
          : null;
      },
      livekitRoomOverrides: async (ids: readonly ChannelId[]) =>
        new Map([...world.livekitRooms].filter(([id]) => ids.includes(id))),
    },
    channelAccess: {
      visibleChannelIdsForUser: async (groupId: GroupId, userId: UserId) =>
        world.members.get(groupId)?.has(userId)
          ? world.channels.filter((c) => c.groupId === groupId).map((c) => c.id)
          : [],
      canUserSeeChannel: async (groupId: GroupId, _channelId: ChannelId, userId: UserId) =>
        world.members.get(groupId)?.has(userId) ?? false,
    },
    groups: {
      listMemberGroupIds: async (userId: UserId) => groupsOf(userId),
      listCoMemberUserIds: async (userId: UserId) => {
        const co = new Set<UserId>();
        for (const groupId of groupsOf(userId)) {
          for (const m of world.members.get(groupId) ?? []) if (m !== userId) co.add(m);
        }
        return [...co];
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

let gateway: Gateway | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await gateway?.close();
  gateway = null;
});

async function start(
  world: World,
  extra: { mutationBus?: RealtimeMutationBus; voiceOccupancy?: VoiceOccupancyReader } = {},
): Promise<number> {
  gateway = createGateway(
    { repos: makeRepos(world), presence: new StubPresenceStore(), ...extra },
    { port: 0, host: "127.0.0.1" },
  );
  return gateway.ready;
}

class Client {
  readonly envelopes: ServerEnvelope[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.envelopes.push(serverEnvelopeSchema.parse(JSON.parse(String(raw))));
    });
    socket.on("error", () => undefined);
  }

  static async connect(port: number, userId: UserId): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKENS[userId]}`);
    sockets.push(socket);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await client.waitFor(SERVER_EVENT.authSucceeded);
    return client;
  }

  send(event: unknown): void {
    this.socket.send(JSON.stringify(event));
  }

  events(type: string) {
    return this.envelopes.filter((e) => e.event.type === type).map((e) => e.event);
  }

  async waitFor(type: string, count = 1, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (this.events(type).length < count) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await sleep(10);
    }
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leftEvents(client: Client, userId: UserId) {
  return client
    .events(SERVER_EVENT.voiceParticipantLeft)
    .filter((e) => (e.payload as { userId: string }).userId === userId);
}

describe("gateway voice occupancy is per connection", () => {
  it("a stale socket of a user still in the room does not remove them", async () => {
    const port = await start(makeWorld());
    const observer = await Client.connect(port, BURAK);
    const oldSocket = await Client.connect(port, ALI);
    oldSocket.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantJoined);

    // Reconnect: the new socket re-announces before the old one is reaped.
    const newSocket = await Client.connect(port, ALI);
    newSocket.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantJoined, 2);

    await oldSocket.close();
    await sleep(150);
    expect(leftEvents(observer, ALI)).toHaveLength(0);

    // A fresh connection still sees Ali in the room.
    const late = await Client.connect(port, CAN);
    const auth = late.events(SERVER_EVENT.authSucceeded)[0]!;
    expect((auth.payload as { voiceOccupancy: unknown }).voiceOccupancy).toEqual([
      { channelId: LOBBY, occupants: [{ userId: ALI, muted: false }] },
    ]);

    // The last connection leaving is the real leave.
    newSocket.send(clientEvent.voiceLeave({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantLeft);
    expect(leftEvents(observer, ALI)).toHaveLength(1);
  });

  it("a second device's leave does not remove the user from the room", async () => {
    const port = await start(makeWorld());
    const observer = await Client.connect(port, BURAK);
    const desktop = await Client.connect(port, ALI);
    const phone = await Client.connect(port, ALI);
    desktop.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    phone.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantJoined, 2);

    desktop.send(clientEvent.voiceLeave({ channelId: LOBBY }));
    await sleep(150);
    expect(leftEvents(observer, ALI)).toHaveLength(0);

    await phone.close();
    await observer.waitFor(SERVER_EVENT.voiceParticipantLeft);
    expect(leftEvents(observer, ALI)).toHaveLength(1);
  });

  it("a socket that closes while its voice.join is in flight is never counted", async () => {
    const world = makeWorld();
    world.findWithMembershipDelayMs = 300;
    const port = await start(world);
    const observer = await Client.connect(port, BURAK);

    const dying = await Client.connect(port, ALI);
    dying.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await sleep(20);
    dying.socket.terminate();
    await sleep(world.findWithMembershipDelayMs * 2);
    expect(observer.events(SERVER_EVENT.voiceParticipantJoined)).toHaveLength(0);

    world.findWithMembershipDelayMs = 0;
    const fresh = await Client.connect(port, ALI);
    fresh.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantJoined);
    fresh.send(clientEvent.voiceLeave({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantLeft);
    expect(leftEvents(observer, ALI)).toHaveLength(1);

    await fresh.close();
    await sleep(100);
    const late = await Client.connect(port, CAN);
    const auth = late.events(SERVER_EVENT.authSucceeded)[0]!;
    expect((auth.payload as { voiceOccupancy: unknown }).voiceOccupancy).toEqual([]);
  });

  it("two in-flight voice.join frames for one room count the socket once", async () => {
    const world = makeWorld();
    world.findWithMembershipDelayMs = 150;
    const port = await start(world);
    const observer = await Client.connect(port, BURAK);
    const ali = await Client.connect(port, ALI);
    ali.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    ali.send(clientEvent.voiceJoin({ channelId: LOBBY }));
    await sleep(world.findWithMembershipDelayMs * 3);
    expect(observer.events(SERVER_EVENT.voiceParticipantJoined)).toHaveLength(1);
    expect(leftEvents(observer, ALI)).toHaveLength(0);

    ali.send(clientEvent.voiceLeave({ channelId: LOBBY }));
    await observer.waitFor(SERVER_EVENT.voiceParticipantLeft);
    const late = await Client.connect(port, CAN);
    const auth = late.events(SERVER_EVENT.authSucceeded)[0]!;
    expect((auth.payload as { voiceOccupancy: unknown }).voiceOccupancy).toEqual([]);
  });
});

describe("voice.resync reads the room each channel really runs in", () => {
  it("passes the upgraded call's room override to the media-plane reader", async () => {
    const world = makeWorld();
    world.members.set(UPGRADED_GROUP, new Set([ALI, BURAK, CAN]));
    world.channels.push({ id: UPGRADED_VOICE, groupId: UPGRADED_GROUP, kind: "voice", name: "Voice" } as Channel);
    world.livekitRooms.set(UPGRADED_VOICE, CALL_ROOM);

    const reads: Array<[ChannelId[], ReadonlyMap<ChannelId, string> | undefined]> = [];
    const reader: VoiceOccupancyReader = {
      read: async (ids, overrides) => {
        reads.push([ids, overrides]);
        const occupants: VoiceOccupant[] = [ALI, BURAK, CAN].map((userId) => ({ userId, muted: false }));
        return new Map(overrides?.get(UPGRADED_VOICE) === CALL_ROOM ? [[UPGRADED_VOICE, occupants]] : []);
      },
    };
    const port = await start(world, { voiceOccupancy: reader });
    const client = await Client.connect(port, CAN);
    await client.waitFor(SERVER_EVENT.voiceResync);

    expect(reads[0]?.[1]?.get(UPGRADED_VOICE)).toBe(CALL_ROOM);
    const resync = client.events(SERVER_EVENT.voiceResync)[0]!;
    expect((resync.payload as { channels: Array<{ channelId: string }> }).channels.map((c) => c.channelId)).toEqual([
      UPGRADED_VOICE,
    ]);
  });
});

describe("DM → group upgrade: call.upgraded can win the race against member.joined", () => {
  it("the originals' voice.join for the new group voice channel is accepted", async () => {
    const world = makeWorld();
    const bus = new LoopbackBus();
    const port = await start(world, { mutationBus: bus });
    const ali = await Client.connect(port, ALI);
    const burak = await Client.connect(port, BURAK);

    // The upgrade transaction commits: new group + memberships + channels.
    world.members.set(UPGRADED_GROUP, new Set([ALI, BURAK, CAN]));
    world.channels.push(
      { id: UPGRADED_STREAM, groupId: UPGRADED_GROUP, kind: "text", name: "stream" } as Channel,
      { id: UPGRADED_VOICE, groupId: UPGRADED_GROUP, kind: "voice", name: "Voice" } as Channel,
    );
    world.livekitRooms.set(UPGRADED_VOICE, CALL_ROOM);
    // Slow DB: member.joined's subscription work lands long after call.upgraded.
    world.listForGroupDelayMs = 400;

    const group = {
      id: UPGRADED_GROUP,
      name: "Ali, Burak, Can",
      iconUrl: null,
      ownerId: ALI,
      streamId: UPGRADED_STREAM,
      createdAt: new Date().toISOString(),
    };
    for (const userId of [ALI, BURAK, CAN]) {
      await bus.publish({
        groupId: UPGRADED_GROUP,
        event: serverEvent.memberJoined({
          groupId: UPGRADED_GROUP,
          member: { groupId: UPGRADED_GROUP, userId, role: "member", joinedAt: new Date().toISOString() },
          user: { id: userId, username: userId, displayName: userId, avatarUrl: null, createdAt: "" },
        }),
      });
    }
    for (const userId of [ALI, BURAK]) {
      await bus.publish({
        userId,
        event: serverEvent.callUpgraded({ callId: "call-2", group, voiceChannelId: UPGRADED_VOICE }),
      });
    }

    // Exactly what the client does on call.upgraded: announce the new channel.
    await ali.waitFor(SERVER_EVENT.callUpgraded);
    ali.send(clientEvent.voiceJoin({ channelId: UPGRADED_VOICE }));
    await burak.waitFor(SERVER_EVENT.voiceParticipantJoined);

    const refusals = ali.events(SERVER_EVENT.errorRaised);
    expect(refusals).toEqual([]);
    const joined = burak.events(SERVER_EVENT.voiceParticipantJoined)[0]!;
    expect(joined.payload).toMatchObject({ channelId: UPGRADED_VOICE, userId: ALI });

    // Admitting Ali early must neither swallow nor duplicate her own
    // member.joined when its (slow) handler finally lands.
    await sleep(world.listForGroupDelayMs * 2);
    const own = ali
      .events(SERVER_EVENT.memberJoined)
      .filter((e) => (e.payload as { user: { id: string } }).user.id === ALI);
    expect(own).toHaveLength(1);
  });

  it("a refused voice.join names the channel it refused", async () => {
    const port = await start(makeWorld());
    const ali = await Client.connect(port, ALI);
    ali.send(clientEvent.voiceJoin({ channelId: "not-visible" as ChannelId }));
    await ali.waitFor(SERVER_EVENT.errorRaised);
    expect(ali.events(SERVER_EVENT.errorRaised)[0]?.payload).toMatchObject({
      code: "NOT_A_MEMBER",
      channelId: "not-visible",
    });
  });
});
