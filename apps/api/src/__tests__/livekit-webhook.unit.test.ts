/**
 * The server-side join check (`POST /hooks/livekit`) — unit tests over mocked
 * repos. Webhooks are SIGNED FOR REAL with the dev API key/secret the same way
 * the SFU signs them (JWT carrying the body's sha256), so the signature path is
 * exercised, not bypassed.
 *
 * The attack: a member is kicked (or banned / timed out) and force-removed from
 * the room, but still holds a LiveKit token that verifies for minutes. They
 * connect again with it. No request reaches our token endpoints; only the SFU's
 * `participant_joined` webhook does — and that is what removes them.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { AccessToken } from "livekit-server-sdk";
import type { Repositories } from "@demli/db";
import type { Channel, DmCall } from "@demli/types";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { isGateExempt } from "../plugins/client-gate.js";
import { LIVEKIT_WEBHOOK_ROUTE } from "../modules/livekit-webhook/index.js";

const KEY = "devkey";
const SECRET = "devsecret";

const GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOBBY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEXT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UPGRADED_VOICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RESTRICTED = "abababab-abab-4bab-8bab-abababababab";
const LIVE_CALL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const UPGRADED_CALL = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const MEMBER = "11111111-1111-4111-8111-111111111111";
const KICKED = "22222222-2222-4222-8222-222222222222";
const TIMED_OUT = "33333333-3333-4333-8333-333333333333";
const CALLER = "44444444-4444-4444-8444-444444444444";
const CALLEE = "55555555-5555-4555-8555-555555555555";
const STRANGER = "66666666-6666-4666-8666-666666666666";

function channel(id: string, kind: Channel["kind"]): Channel {
  return { id, groupId: GROUP, kind, name: id.slice(0, 4), position: 0, createdAt: "" } as Channel;
}

const livekitRoomOf: Record<string, string | null> = {
  [LOBBY]: null,
  [TEXT]: null,
  [RESTRICTED]: null,
  [UPGRADED_VOICE]: `dmcall:${UPGRADED_CALL}`,
};

const members = new Set([MEMBER, TIMED_OUT, CALLER, CALLEE]);

const calls: Record<string, Partial<DmCall>> = {
  [LIVE_CALL]: { id: LIVE_CALL, status: "active", callerId: CALLER, calleeId: CALLEE },
  [UPGRADED_CALL]: { id: UPGRADED_CALL, status: "upgraded", callerId: CALLER, calleeId: CALLEE },
};

const repos = {
  calls: { findById: async (id: string) => calls[id] ?? null },
  channels: {
    findByLivekitRoom: async (room: string) =>
      room === `dmcall:${UPGRADED_CALL}` ? channel(UPGRADED_VOICE, "voice") : null,
    findWithMembership: async (channelId: string, userId: string) => {
      if (!(channelId in livekitRoomOf) || !members.has(userId)) return null;
      return {
        channel: channel(channelId, channelId === TEXT ? "text" : "voice"),
        role: "member" as const,
        livekitRoom: livekitRoomOf[channelId] ?? null,
        timedOutUntil: userId === TIMED_OUT ? new Date(Date.now() + 60_000) : null,
      };
    },
  },
  channelAccess: {
    canUserSeeChannel: async (_g: string, channelId: string) => channelId !== RESTRICTED,
  },
} as unknown as Repositories;

const removeParticipant = vi.fn(async () => undefined);

async function signed(body: string, secret = SECRET): Promise<string> {
  const token = new AccessToken(KEY, secret, { identity: "livekit-server" });
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return token.toJwt();
}

function joinedBody(room: string, identity: string): string {
  return JSON.stringify({
    event: "participant_joined",
    id: `EV_${room}_${identity}`,
    createdAt: Math.floor(Date.now() / 1000),
    room: { name: room, sid: "RM_x" },
    participant: { identity, sid: "PA_x" },
  });
}

describe("LiveKit join check webhook", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      repos,
      env: loadEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli",
        LIVEKIT_API_KEY: KEY,
        LIVEKIT_API_SECRET: SECRET,
      }),
      voiceModerator: { removeParticipant },
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => removeParticipant.mockClear());

  async function deliver(room: string, identity: string) {
    const body = joinedBody(room, identity);
    return app.inject({
      method: "POST",
      url: LIVEKIT_WEBHOOK_ROUTE,
      headers: { "content-type": "application/webhook+json", authorization: await signed(body) },
      payload: body,
    });
  }

  it("is exempt from the client-identity gate (a machine caller never sends the mark)", () => {
    expect(isGateExempt("POST", LIVEKIT_WEBHOOK_ROUTE)).toBe(true);
  });

  it("refuses an unsigned or wrongly signed delivery", async () => {
    const body = joinedBody(LOBBY, KICKED);
    const unsigned = await app.inject({
      method: "POST",
      url: LIVEKIT_WEBHOOK_ROUTE,
      headers: { "content-type": "application/webhook+json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: LIVEKIT_WEBHOOK_ROUTE,
      headers: {
        "content-type": "application/webhook+json",
        authorization: await signed(body, "not-the-secret"),
      },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);

    const tampered = await app.inject({
      method: "POST",
      url: LIVEKIT_WEBHOOK_ROUTE,
      headers: {
        "content-type": "application/webhook+json",
        authorization: await signed(joinedBody(LOBBY, MEMBER)),
      },
      payload: body,
    });
    expect(tampered.statusCode).toBe(401);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it("removes a kicked member who rejoins with a still-valid token", async () => {
    const res = await deliver(LOBBY, KICKED);
    expect(res.statusCode).toBe(200);
    expect(removeParticipant).toHaveBeenCalledWith(LOBBY, KICKED);
  });

  it("removes a timed-out member and one who lost sight of a restricted channel", async () => {
    await deliver(LOBBY, TIMED_OUT);
    await deliver(RESTRICTED, MEMBER);
    expect(removeParticipant.mock.calls).toEqual([
      [LOBBY, TIMED_OUT],
      [RESTRICTED, MEMBER],
    ]);
  });

  it("leaves a member who is allowed in alone", async () => {
    const res = await deliver(LOBBY, MEMBER);
    expect(res.statusCode).toBe(200);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it("a channel room must be the room the channel runs in", async () => {
    // The upgraded group's voice channel runs in the CALL room; its bare id is
    // not a room anyone was given a token for.
    await deliver(UPGRADED_VOICE, MEMBER);
    await deliver(TEXT, MEMBER);
    expect(removeParticipant.mock.calls).toEqual([
      [UPGRADED_VOICE, MEMBER],
      [TEXT, MEMBER],
    ]);
  });

  it("a live DM call admits its two participants and nobody else", async () => {
    await deliver(`dmcall:${LIVE_CALL}`, CALLER);
    await deliver(`dmcall:${LIVE_CALL}`, CALLEE);
    expect(removeParticipant).not.toHaveBeenCalled();
    await deliver(`dmcall:${LIVE_CALL}`, STRANGER);
    expect(removeParticipant).toHaveBeenCalledWith(`dmcall:${LIVE_CALL}`, STRANGER);
  });

  it("an upgraded call room admits members of the bound group voice channel only", async () => {
    await deliver(`dmcall:${UPGRADED_CALL}`, MEMBER);
    expect(removeParticipant).not.toHaveBeenCalled();
    await deliver(`dmcall:${UPGRADED_CALL}`, KICKED);
    await deliver(`dmcall:${UPGRADED_CALL}`, TIMED_OUT);
    expect(removeParticipant.mock.calls).toEqual([
      [`dmcall:${UPGRADED_CALL}`, KICKED],
      [`dmcall:${UPGRADED_CALL}`, TIMED_OUT],
    ]);
  });

  it("ignores rooms and identities that are not ours, and events other than a join", async () => {
    await deliver("egress-room", STRANGER);
    await deliver(LOBBY, "EG_worker");
    const left = JSON.stringify({
      event: "participant_left",
      room: { name: LOBBY },
      participant: { identity: KICKED },
    });
    const res = await app.inject({
      method: "POST",
      url: LIVEKIT_WEBHOOK_ROUTE,
      headers: { "content-type": "application/webhook+json", authorization: await signed(left) },
      payload: left,
    });
    expect(res.statusCode).toBe(200);
    expect(removeParticipant).not.toHaveBeenCalled();
  });

  it("fails open when the database cannot answer", async () => {
    const original = repos.channels.findWithMembership;
    repos.channels.findWithMembership = (async () => {
      throw new Error("connection terminated");
    }) as typeof original;
    try {
      const res = await deliver(LOBBY, MEMBER);
      expect(res.statusCode).toBe(200);
      expect(removeParticipant).not.toHaveBeenCalled();
    } finally {
      repos.channels.findWithMembership = original;
    }
  });
});
