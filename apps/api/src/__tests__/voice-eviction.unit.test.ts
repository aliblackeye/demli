/**
 * Kick / ban / timeout / owner-removal end the target's MEDIA session, not just
 * their membership — unit tests over mocked repos (no DB, no LiveKit).
 *
 * The bug: these paths published `member.left` and stopped. The gateway's
 * "voice teardown" is an occupancy-map edit, so a removed member's SFU session
 * kept running and they could keep hearing and talking. The fake SFU here plays
 * LiveKit's real contract: `removeParticipant` THROWS NotFound for a room the
 * user is not in, so the assertions also prove a not-present room neither fails
 * the request nor produces a bogus `voice.disconnected`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  hashSessionToken,
  InMemoryMutationBus,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import type { FriendGroup, User } from "@demli/types";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const OWNER_TOKEN = "eviction-owner-token";
const SERVER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOBBY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GAMES_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHAT_VOICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CALL_ROOM = "dmcall:ffffffff-ffff-4fff-8fff-ffffffffffff";

const owner: User = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "owner",
  displayName: "Owner",
  avatarUrl: null,
  createdAt: new Date().toISOString(),
};
const targetId = "22222222-2222-4222-8222-222222222222";

function group(id: string, kind: FriendGroup["kind"]): FriendGroup {
  return {
    id,
    name: kind === "server" ? "Server" : "Chat",
    ownerId: owner.id,
    kind,
    createdAt: new Date().toISOString(),
  } as FriendGroup;
}

/** The rooms each group's voice channels run in — the call room is the upgrade case. */
const voiceRooms: Record<string, Array<{ channelId: string; room: string }>> = {
  [SERVER_ID]: [
    { channelId: LOBBY_ID, room: LOBBY_ID },
    { channelId: GAMES_ID, room: GAMES_ID },
  ],
  [CHAT_ID]: [{ channelId: CHAT_VOICE_ID, room: CALL_ROOM }],
};

/** Which room the target's SFU session is in right now. */
let targetRoom: string | null = null;

const removeParticipant = vi.fn(async (room: string, identity: string) => {
  if (identity !== targetId || room !== targetRoom) {
    throw Object.assign(new Error("participant not found"), { status: 404, code: "not_found" });
  }
  targetRoom = null;
});

const repos = {
  sessions: {
    findActiveByTokenHash: async (hash: string) =>
      hash === hashSessionToken(OWNER_TOKEN) ? { session: { id: "s-owner" }, user: owner } : null,
    touchLastSeen: async () => undefined,
  },
  groups: {
    getMembership: async (groupId: string, userId: string) => {
      if (userId === owner.id) return { groupId, userId, role: "owner" as const };
      if (userId === targetId) return { groupId, userId, role: "member" as const };
      return null;
    },
    findById: async (groupId: string) =>
      groupId === SERVER_ID ? group(SERVER_ID, "server") : groupId === CHAT_ID ? group(CHAT_ID, "group") : null,
    removeMember: async () => true,
    removeMemberAndPruneIfEmpty: async () => ({ removed: true, groupDeleted: false }),
    setMemberTimeout: async (groupId: string, userId: string, until: Date | null) => ({
      groupId,
      userId,
      role: "member",
      timedOutUntil: until?.toISOString() ?? null,
    }),
    countMembers: async () => 3,
  },
  groupChats: {
    findById: async (id: string) => (id === CHAT_ID ? group(CHAT_ID, "group") : null),
  },
  groupBans: {
    ban: async (input: { groupId: string; userId: string }) => ({ ...input, createdAt: new Date().toISOString() }),
  },
  moderationActions: { record: async () => undefined },
  users: {
    findById: async (id: string) => ({ ...owner, id, username: "target", displayName: "Target" }),
  },
  channels: {
    listVoiceRoomsForGroup: async (groupId: string) => voiceRooms[groupId] ?? [],
  },
  messages: {},
} as unknown as Repositories;

describe("moderation ends the target's SFU session", () => {
  let app: FastifyInstance;
  const published: RealtimeMutation[] = [];

  beforeAll(async () => {
    const bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
      mutationBus: bus,
      voiceModerator: { removeParticipant },
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    published.length = 0;
    removeParticipant.mockClear();
  });

  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      ...(payload ? { payload } : {}),
    });

  function disconnectedEvents(): RealtimeMutation[] {
    return published.filter(
      (m) => m.userId === targetId && m.event.type === SERVER_EVENT.voiceDisconnected,
    );
  }

  it("kick removes the target from every voice room of the server and notices only the one they were in", async () => {
    targetRoom = GAMES_ID;
    const res = await post(`/groups/${SERVER_ID}/members/${targetId}/kick`);
    expect(res.statusCode).toBe(204);

    const rooms = removeParticipant.mock.calls.map(([room, identity]) => [room, identity]);
    expect(rooms).toEqual(
      expect.arrayContaining([
        [LOBBY_ID, targetId],
        [GAMES_ID, targetId],
      ]),
    );
    expect(targetRoom).toBeNull();

    const notices = disconnectedEvents();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.event.payload).toEqual({
      roomId: GAMES_ID,
      channelId: GAMES_ID,
      reason: "moderator",
    });
  });

  it("kick of a member who is in no voice room succeeds and sends no voice notice", async () => {
    targetRoom = null;
    const res = await post(`/groups/${SERVER_ID}/members/${targetId}/kick`);
    expect(res.statusCode).toBe(204);
    expect(removeParticipant).toHaveBeenCalledTimes(2);
    expect(disconnectedEvents()).toHaveLength(0);
  });

  it("ban removes the target from the SFU", async () => {
    targetRoom = LOBBY_ID;
    const res = await post(`/groups/${SERVER_ID}/bans`, { userId: targetId });
    expect(res.statusCode).toBe(201);
    expect(targetRoom).toBeNull();
    expect(disconnectedEvents().map((m) => m.event.payload)).toEqual([
      { roomId: LOBBY_ID, channelId: LOBBY_ID, reason: "moderator" },
    ]);
  });

  it("timeout removes a member who is already talking", async () => {
    targetRoom = LOBBY_ID;
    const res = await post(`/groups/${SERVER_ID}/members/${targetId}/timeout`, { minutes: 10 });
    expect(res.statusCode).toBe(200);
    expect(targetRoom).toBeNull();
    expect(disconnectedEvents()).toHaveLength(1);
  });

  it("an unreachable SFU never fails the kick", async () => {
    removeParticipant.mockImplementationOnce(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { status: 503 });
    });
    targetRoom = null;
    const res = await post(`/groups/${SERVER_ID}/members/${targetId}/kick`);
    expect(res.statusCode).toBe(204);
  });

  it("the owner removing a member of an upgraded group chat ends their session in the CALL room", async () => {
    targetRoom = CALL_ROOM;
    const res = await app.inject({
      method: "DELETE",
      url: `/group-chats/${CHAT_ID}/members/${targetId}`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(204);
    expect(removeParticipant).toHaveBeenCalledWith(CALL_ROOM, targetId);
    expect(targetRoom).toBeNull();
    expect(disconnectedEvents().map((m) => m.event.payload)).toEqual([
      { roomId: CALL_ROOM, channelId: CHAT_VOICE_ID, reason: "moderator" },
    ]);
  });
});
