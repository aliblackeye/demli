/**
 * POST /media/token — unit tests with mocked repos (no DB, no LiveKit
 * server needed). The minted JWT is verified with livekit-server-sdk's
 * TokenVerifier against the same dev keys, so signature + grants are
 * checked for real. Live-server behavior is covered by scripts/smoke-m3.mjs.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { TokenVerifier } from "livekit-server-sdk";
import type { Channel, User } from "@demli/types";
import type { Repositories } from "@demli/db";
import { hashSessionToken } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { MEDIA_TOKEN_TTL_SECONDS } from "../modules/media/index.js";

const LIVEKIT_API_KEY = "devkey";
const LIVEKIT_API_SECRET = "devsecret";
const LIVEKIT_URL = "ws://localhost:7880";

const SESSION_TOKEN = "media-test-session-token";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "media_tester",
  displayName: "Media Tester",
  avatarUrl: null,
  createdAt: new Date().toISOString(),
};

const voiceChannelId = "22222222-2222-4222-8222-222222222222";
const textChannelId = "33333333-3333-4333-8333-333333333333";
const foreignChannelId = "44444444-4444-4444-8444-444444444444";

function makeChannel(id: string, kind: Channel["kind"]): Channel {
  return {
    id,
    groupId: "55555555-5555-4555-8555-555555555555",
    kind,
    name: kind === "voice" ? "lobby" : "general",
    position: 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Only the methods this test path touches are implemented; the cast is
 * contained here and any unexpected repo call fails loudly.
 */
const repos = {
  sessions: {
    findActiveByTokenHash: async (tokenHash: string) =>
      tokenHash === hashSessionToken(SESSION_TOKEN)
        ? { session: {}, user }
        : null,
  },
  channels: {
    findWithMembership: async (channelId: string, userId: string) => {
      if (userId !== user.id) return null;
      if (channelId === voiceChannelId) {
        return { channel: makeChannel(channelId, "voice"), role: "member" as const };
      }
      if (channelId === textChannelId) {
        return { channel: makeChannel(channelId, "text"), role: "member" as const };
      }
      return null; // unknown channel OR not a member — same 404
    },
  },
  // M9 visibility guard: the mock's channels carry no access rows → public.
  channelAccess: {
    canUserSeeChannel: async () => true,
  },
} as unknown as Repositories;

describe("POST /media/token", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      repos,
      env: loadEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/demli",
        LIVEKIT_URL,
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
      }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const inject = (payload: unknown, token: string | null = SESSION_TOKEN) =>
    app.inject({
      method: "POST",
      url: "/media/token",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as Record<string, unknown>,
    });

  it("requires authentication", async () => {
    const res = await inject({ channelId: voiceChannelId }, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an expired/forged session", async () => {
    const res = await inject({ channelId: voiceChannelId }, "forged-token");
    expect(res.statusCode).toBe(401);
  });

  it("validates the body at the boundary", async () => {
    const bad = await inject({ channelId: "not-a-uuid" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");

    const missing = await inject({});
    expect(missing.statusCode).toBe(400);
  });

  it("returns 404 for unknown channels and channels in foreign groups", async () => {
    const res = await inject({ channelId: foreignChannelId });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses to mint tokens for text channels", async () => {
    const res = await inject({ channelId: textChannelId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CHANNEL");
  });

  it("mints a verifiable LiveKit token scoped to the channel and user", async () => {
    const res = await inject({ channelId: voiceChannelId });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      url: string;
      token: string;
      roomName: string;
      identity: string;
      expiresAt: string;
    };

    expect(body.url).toBe(LIVEKIT_URL);
    expect(body.roomName).toBe(voiceChannelId);
    expect(body.identity).toBe(user.id);

    // Verify the JWT signature + grants with the server SDK itself.
    const grants = await new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).verify(
      body.token,
    );
    expect(grants.video).toMatchObject({
      room: voiceChannelId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    // Identity + TTL from the raw claims.
    const [, payloadB64] = body.token.split(".");
    const claims = JSON.parse(
      Buffer.from(String(payloadB64), "base64url").toString("utf8"),
    ) as { sub: string; iss: string; exp: number; nbf?: number; iat?: number };
    expect(claims.sub).toBe(user.id);
    expect(claims.iss).toBe(LIVEKIT_API_KEY);
    const lifetime = claims.exp - Math.floor(Date.now() / 1000);
    expect(lifetime).toBeGreaterThan(MEDIA_TOKEN_TTL_SECONDS - 120);
    expect(lifetime).toBeLessThanOrEqual(MEDIA_TOKEN_TTL_SECONDS + 120);

    // expiresAt matches the token's exp within a minute.
    expect(
      Math.abs(new Date(body.expiresAt).getTime() - claims.exp * 1000),
    ).toBeLessThan(60_000);
  });

  it("never leaks stack traces from this route", async () => {
    const res = await inject({ channelId: "not-a-uuid" });
    expect(JSON.stringify(res.json())).not.toMatch(/\bat\s+.*:\d+:\d+/);
  });
});
