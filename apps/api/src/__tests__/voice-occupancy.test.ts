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
} from "livekit-server-sdk";
import type { Channel, ChannelId, User } from "@demli/types";
import type { VoiceOccupant } from "@demli/protocol";
import type { Repositories } from "@demli/db";
import { hashSessionToken } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import {
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
let readImpl: (ids: ChannelId[]) => Promise<Map<ChannelId, VoiceOccupant[]>> = async () =>
  new Map();
const fakeReader: VoiceOccupancyReader = {
  read: (ids) => {
    readCalls.push(ids);
    return readImpl(ids);
  },
};

describe("GET /voice/occupancy", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await app?.close();
    readCalls.length = 0;
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

  it("answers 503 (not an empty snapshot) when the media plane is unreachable", async () => {
    app = await makeApp(fakeReader);
    readImpl = async () => {
      throw new VoiceOccupancyUnavailableError(new Error("connect ECONNREFUSED"));
    };
    const res = await inject(app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("VOICE_OCCUPANCY_UNAVAILABLE");
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
