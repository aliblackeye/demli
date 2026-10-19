/**
 * GET /voice/occupancy — the authoritative voice-occupancy snapshot (STATE
 * RESYNC). Mock repos + an injected fake reader, so no DB and no live LiveKit
 * server are needed. Proves the snapshot shape, screen-share reporting, the
 * visibility boundary (a restricted voice channel never leaks — nor is it even
 * queried against the SFU), and honest failure (503, never a fabricated empty).
 *
 * The LiveKit → occupant mapping itself is unit-tested separately below against
 * the real TrackSource/ParticipantInfo_State enums.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ParticipantInfo_State,
  TrackSource,
  type ParticipantInfo,
  type Room,
} from "livekit-server-sdk";
import type { Channel, ChannelId, User } from "@demli/types";
import type { VoiceOccupant } from "@demli/protocol";
import type { Repositories } from "@demli/db";
import { hashSessionToken } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import {
  createLiveKitVoiceOccupancyReader,
  participantsToOccupants,
  VoiceOccupancyUnavailableError,
  type VoiceOccupancyReader,
} from "../modules/voice/occupancy.js";

const SESSION_TOKEN = "voice-occupancy-session-token";
const GROUP_ID = "55555555-5555-4555-8555-555555555555";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "occ_tester",
  displayName: "Occ Tester",
  avatarUrl: null,
  createdAt: new Date().toISOString(),
};

const voiceVisibleId = "22222222-2222-4222-8222-222222222222";
const voiceRestrictedId = "33333333-3333-4333-8333-333333333333";
const textChannelId = "44444444-4444-4444-8444-444444444444";

function makeChannel(id: string, kind: Channel["kind"]): Channel {
  return {
    id,
    groupId: GROUP_ID,
    kind,
    name: kind === "voice" ? "lobby" : "general",
    position: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Channel → LiveKit room overrides the repo reports (an upgraded call's channel). */
let roomOverrides = new Map<ChannelId, string>();
/** Set to make the repo's override lookup fail (a broken query, a DB blip). */
let overridesError: Error | null = null;

/** Only the methods this endpoint touches; any other repo call fails loudly. */
const repos = {
  sessions: {
    findActiveByTokenHash: async (tokenHash: string) =>
      tokenHash === hashSessionToken(SESSION_TOKEN) ? { session: {}, user } : null,
  },
  channels: {
    // Member of one group with a public voice channel, a RESTRICTED voice
    // channel, and a text channel.
    listForUser: async (userId: string): Promise<Channel[]> =>
      userId === user.id
        ? [
            makeChannel(voiceVisibleId, "voice"),
            makeChannel(voiceRestrictedId, "voice"),
            makeChannel(textChannelId, "text"),
          ]
        : [],
    livekitRoomOverrides: async (ids: readonly ChannelId[]) => {
      if (overridesError) throw overridesError;
      return new Map([...roomOverrides].filter(([id]) => ids.includes(id)));
    },
  },
  channelAccess: {
    // The restricted voice channel is NOT visible to this user.
    visibleChannelIdsForUser: async (groupId: string, userId: string): Promise<ChannelId[]> =>
      groupId === GROUP_ID && userId === user.id ? [voiceVisibleId, textChannelId] : [],
  },
} as unknown as Repositories;

// A fake reader whose behavior each test reconfigures; it records the exact
// channel-id lists the endpoint asks the media plane about (leak assertion).
const readCalls: ChannelId[][] = [];
const overrideCalls: Array<ReadonlyMap<ChannelId, string> | undefined> = [];
let readImpl: (ids: ChannelId[]) => Promise<Map<ChannelId, VoiceOccupant[]>> = async () =>
  new Map();
const fakeReader: VoiceOccupancyReader = {
  read: (ids, overrides) => {
    readCalls.push(ids);
    overrideCalls.push(overrides);
    return readImpl(ids);
  },
};

describe("GET /voice/occupancy", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await app?.close();
    readCalls.length = 0;
    overrideCalls.length = 0;
    roomOverrides = new Map();
    overridesError = null;
    readImpl = async () => new Map();
  });

  async function makeApp(reader: VoiceOccupancyReader | null): Promise<FastifyInstance> {
    return buildApp({
      repos,
      env: loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
      voiceOccupancy: reader,
      logger: false,
    });
  }

  const inject = (a: FastifyInstance, token: string | null = SESSION_TOKEN) =>
    a.inject({
      method: "GET",
      url: "/voice/occupancy",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  afterAll(async () => {
    await app?.close();
  });

  it("requires authentication", async () => {
    app = await makeApp(fakeReader);
    const res = await inject(app, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("returns the visible occupied channels with screen-share state", async () => {
    app = await makeApp(fakeReader);
    readImpl = async () =>
      new Map<ChannelId, VoiceOccupant[]>([
        [voiceVisibleId, [{ userId: "peer-1", muted: false, screenSharing: true, camera: false }]],
      ]);

    const res = await inject(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      channels: [
        {
          channelId: voiceVisibleId,
          occupants: [{ userId: "peer-1", muted: false, screenSharing: true, camera: false }],
        },
      ],
    });
  });

  it("never queries nor returns a restricted voice channel (visibility, §28)", async () => {
    app = await makeApp(fakeReader);
    // Even if the SFU HAD occupancy for the restricted room, it is filtered out
    // BEFORE the media-plane query, so it can never leak.
    readImpl = async () =>
      new Map<ChannelId, VoiceOccupant[]>([
        [voiceVisibleId, [{ userId: "peer-1", muted: false, screenSharing: false, camera: false }]],
        [voiceRestrictedId, [{ userId: "spy", muted: false, screenSharing: true, camera: false }]],
      ]);

    const res = await inject(app);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { channels: Array<{ channelId: string }> };
    const ids = body.channels.map((c) => c.channelId);
    expect(ids).toContain(voiceVisibleId);
    expect(ids).not.toContain(voiceRestrictedId);
    // The text channel is excluded by kind, the restricted voice channel by
    // visibility — the reader is asked ONLY about the visible voice channel.
    expect(readCalls).toEqual([[voiceVisibleId]]);
  });

  it("returns an empty snapshot without touching the media plane when nothing is visible", async () => {
    // Dedicated repos: the user sees only a text channel — no visible voice
    // channel — so the endpoint must short-circuit to `{ channels: [] }` and
    // never call the reader (no wasted SFU round-trip).
    const textOnlyRepos = {
      sessions: repos.sessions,
      channels: {
        listForUser: async (): Promise<Channel[]> => [makeChannel(textChannelId, "text")],
      },
      channelAccess: {
        visibleChannelIdsForUser: async (): Promise<ChannelId[]> => [textChannelId],
      },
    } as unknown as Repositories;

    const textApp = await buildApp({
      repos: textOnlyRepos,
      env: loadEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli" }),
      voiceOccupancy: fakeReader,
      logger: false,
    });
    try {
      const res = await textApp.inject({
        method: "GET",
        url: "/voice/occupancy",
        headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ channels: [] });
      expect(readCalls).toEqual([]); // reader never invoked
    } finally {
      await textApp.close();
    }
  });

  it("hands the reader the room an upgraded call's voice channel really runs in", async () => {
    app = await makeApp(fakeReader);
    roomOverrides = new Map([[voiceVisibleId, "dmcall:call-1"]]);
    const res = await inject(app);
    expect(res.statusCode).toBe(200);
    expect(overrideCalls).toHaveLength(1);
    expect([...(overrideCalls[0] ?? new Map())]).toEqual([[voiceVisibleId, "dmcall:call-1"]]);
  });

  it("answers 503 (not an empty snapshot) when the media plane is unreachable", async () => {
    app = await makeApp(fakeReader);
    readImpl = async () => {
      throw new VoiceOccupancyUnavailableError(new Error("connect ECONNREFUSED"));
    };
    const res = await inject(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("VOICE_OCCUPANCY_UNAVAILABLE");
  });

  it("answers 503 (not a 500, not an empty snapshot) when the room-override lookup fails", async () => {
    app = await makeApp(fakeReader);
    overridesError = new Error('relation "channels" does not exist');
    const res = await inject(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("VOICE_OCCUPANCY_UNAVAILABLE");
    expect(readCalls).toHaveLength(0);
  });

  it("answers 503 when the occupancy feature is disabled (no reader)", async () => {
    app = await makeApp(null);
    const res = await inject(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("VOICE_OCCUPANCY_UNAVAILABLE");
  });

  it("never leaks stack traces from this route", async () => {
    app = await makeApp(fakeReader);
    readImpl = async () => {
      throw new VoiceOccupancyUnavailableError(new Error("boom at internal:1:1"));
    };
    const res = await inject(app);
    expect(JSON.stringify(res.json())).not.toMatch(/\bat\s+.*:\d+:\d+/);
  });
});

// ---------------------------------------------------------------------------
// participantsToOccupants — the pure LiveKit → occupant mapping (screen-share
// truth from published tracks). Cast plain objects to the protobuf types; the
// mapper only reads state / identity / tracks[].source / tracks[].muted.
// ---------------------------------------------------------------------------

function participant(
  identity: string,
  state: ParticipantInfo_State,
  tracks: Array<{ source: TrackSource; muted: boolean }>,
): ParticipantInfo {
  return { identity, state, tracks } as unknown as ParticipantInfo;
}

describe("participantsToOccupants", () => {
  it("derives screenSharing/camera/muted from published tracks", () => {
    const occupants = participantsToOccupants([
      participant("sharer", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.MICROPHONE, muted: false },
        { source: TrackSource.SCREEN_SHARE, muted: false },
      ]),
      participant("camera-muted-mic", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.MICROPHONE, muted: true },
        { source: TrackSource.CAMERA, muted: false },
      ]),
      participant("listener", ParticipantInfo_State.JOINED, []),
    ]);

    expect(occupants).toEqual<VoiceOccupant[]>([
      { userId: "sharer", muted: false, screenSharing: true, camera: false },
      { userId: "camera-muted-mic", muted: true, screenSharing: false, camera: true },
      // No microphone track at all ⇒ treated as muted.
      { userId: "listener", muted: true, screenSharing: false, camera: false },
    ]);
  });

  it("treats a muted screen-share track as NOT sharing", () => {
    const [occ] = participantsToOccupants([
      participant("paused", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.SCREEN_SHARE, muted: true },
      ]),
    ]);
    expect(occ?.screenSharing).toBe(false);
  });

  it("skips DISCONNECTED participants (SFU still listing a leaver)", () => {
    const occupants = participantsToOccupants([
      participant("gone", ParticipantInfo_State.DISCONNECTED, [
        { source: TrackSource.MICROPHONE, muted: false },
      ]),
      participant("here", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.MICROPHONE, muted: false },
      ]),
    ]);
    expect(occupants.map((o) => o.userId)).toEqual(["here"]);
  });
});

describe("createLiveKitVoiceOccupancyReader — rooms that are not the channel id", () => {
  const plainId = "66666666-6666-4666-8666-666666666666" as ChannelId;
  const upgradedId = "77777777-7777-4777-8777-777777777777" as ChannelId;
  const callRoom = "dmcall:88888888-8888-4888-8888-888888888888";

  it("queries the override room and reports its occupants under the channel id", async () => {
    const asked: string[][] = [];
    const reader = createLiveKitVoiceOccupancyReader({
      roomService: {
        listRooms: async (names?: string[]) => {
          asked.push(names ?? []);
          return [
            { name: plainId, numParticipants: 1 },
            { name: callRoom, numParticipants: 3 },
          ] as unknown as Room[];
        },
        listParticipants: async (room: string) =>
          (room === callRoom ? ["a", "b", "c"] : ["d"]).map((identity) =>
            participant(identity, ParticipantInfo_State.ACTIVE, [
              { source: TrackSource.MICROPHONE, muted: false },
            ]),
          ),
      },
    });

    const occupancy = await reader.read([plainId, upgradedId], new Map([[upgradedId, callRoom]]));
    expect(asked).toEqual([[plainId, callRoom]]);
    expect(occupancy.get(upgradedId)?.map((o) => o.userId)).toEqual(["a", "b", "c"]);
    expect(occupancy.get(plainId)?.map((o) => o.userId)).toEqual(["d"]);
    // The raw room name is never a key — the client only knows channel ids.
    expect(occupancy.has(callRoom as ChannelId)).toBe(false);
  });
});
