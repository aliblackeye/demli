/**
 * Media module — mints LiveKit room access tokens (Milestone 3).
 *
 * POST /media/token { channelId }
 *   → 200 { url, token, roomName, identity, expiresAt }
 *
 * Contract (consumed by the voice engine in packages/media):
 *   - room     = the voice channel id (rooms are 1:1 with voice channels)
 *   - identity = the authenticated user's id
 *   - grants   = roomJoin + canPublish + canSubscribe, TTL 10 min (see below)
 *
 * The server never trusts client-claimed membership (§28): the channel must
 * exist, be a voice channel, and the user must be a member of its group.
 * Media frames themselves flow over WebRTC/LiveKit only — never WebSocket.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type { RealtimeMutationPublisher, RedisClient } from "@demli/db";
import { ApiError, parseWith } from "../../errors.js";
import { loadVisibleChannel } from "../../lib/permissions.js";
import { assertNotTimedOut } from "../../lib/timeout.js";
import { requireUser } from "../../plugins/auth.js";
import {
  createVoiceSessionRegistry,
  livekitHttpUrl,
  type VoiceSessionRegistry,
} from "./voice-session.js";
import { userRateLimit } from "../../lib/rate-limit.js";

const tokenBodySchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

/**
 * How long a minted media token admits a JOIN. A LiveKit token is checked only
 * when a connection is made — never again for a session already in the room —
 * and the SFU refreshes every connected participant's token itself (a fresh
 * 10-minute token at session start and every 5 minutes; livekit-client uses the
 * latest one for every resume/reconnect). So the TTL does not bound call length;
 * it bounds how long a token that leaked, or was kept by someone since kicked,
 * banned or timed out, can still be replayed to walk back in. Ten minutes matches
 * the SFU's own refresh lifetime: a minted token is never worth more than a
 * refreshed one.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * How long the single-active-session record (Redis) lives. Deliberately NOT the
 * token TTL: the record is "which room is this user's voice session in", which
 * must outlive a 10-minute token for as long as a call can plausibly run, or the
 * cross-device eviction would silently stop working mid-call.
 */
export const VOICE_SESSION_TTL_SECONDS = 6 * 60 * 60;

export interface MediaTokenResponse {
  /** LiveKit websocket URL the client should connect to. */
  url: string;
  /** LiveKit access token (JWT). */
  token: string;
  /** LiveKit room name — always the voice channel id. */
  roomName: string;
  /** Token identity — always the authenticated user id. */
  identity: string;
  /** ISO timestamp after which the token is no longer valid. */
  expiresAt: string;
}

/**
 * Build the single-active-voice-session registry, or null when Redis is not
 * wired (tests that only assert token minting). Shared by BOTH the media token
 * endpoint and the DM-calls module (ADR 0012) so a voice-channel join and a
 * call-room join enforce ONE session per user against the SAME Redis key — the
 * registry is stateless beyond Redis, so a single instance keeps the two paths
 * consistent. The LiveKit admin client reuses the token-minting creds; its host
 * is the http(s) form of the ws(s) client URL.
 */
export function createVoiceSessions(
  server: FastifyInstance,
  redis: RedisClient | undefined,
  mutationBus: RealtimeMutationPublisher | undefined,
): VoiceSessionRegistry | null {
  if (!redis) return null;
  return createVoiceSessionRegistry({
    redis,
    roomService: new RoomServiceClient(
      livekitHttpUrl(server.apiEnv.livekitUrl),
      server.apiEnv.livekitApiKey,
      server.apiEnv.livekitApiSecret,
    ),
    mutationBus,
    ttlSeconds: VOICE_SESSION_TTL_SECONDS,
    log: (message) => server.log.info(message),
  });
}

export interface MediaModuleOptions {
  /**
   * The single-active-voice-session registry (built once in `buildApp` via
   * {@link createVoiceSessions} and shared with the DM-calls module). When
   * present, issuing a media token records the user's active room and evicts any
   * session in a DIFFERENT room (cross-device single-session).
   * Null/omitted in tests that only assert token minting — the endpoint then
   * just mints tokens, exactly as before.
   */
  voiceSessions?: VoiceSessionRegistry | null;
}

export async function registerMediaModule(
  server: FastifyInstance,
  options: MediaModuleOptions = {},
): Promise<void> {
  const voiceSessions = options.voiceSessions ?? null;

  server.post(
    "/media/token",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request): Promise<MediaTokenResponse> => {
      const user = requireUser(request);
      const { channelId } = parseWith(tokenBodySchema, request.body);

      // Existence + membership + M9 visibility: non-members AND members who
      // cannot see a restricted voice channel get the same 404 as a missing
      // channel, so group structure is not leaked.
      const found = await loadVisibleChannel(server, channelId, user.id);
      if (found.channel.kind !== "voice") {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "Voice tokens are only issued for voice channels.",
        );
      }

      // Timeout gate (migration 0020, ADR 0019). This is the AUTHORITATIVE voice
      // block, not a UI hint: the SFU only admits a participant holding a token
      // signed here, so refusing to mint one is refusing the join outright — a
      // client that skips the check simply has nothing to connect with. The same
      // reasoning as the moderator voice-disconnect path, which relies on the
      // server-side force-remove rather than on the client leaving politely.
      assertNotTimedOut(found.timedOutUntil);

      // Room resolution (ADR 0012 §6): a voice channel's LiveKit room is its
      // explicit `livekitRoom` override when set, else its id. Null for every
      // ordinary channel (room = id, unchanged), but an upgraded group's voice
      // channel carries the ongoing call's room (`dmcall:<id>`) — so joining it,
      // and any reconnect, lands in the live call room rather than a fresh one.
      const roomName = found.livekitRoom ?? channelId;

      const accessToken = new AccessToken(
        server.apiEnv.livekitApiKey,
        server.apiEnv.livekitApiSecret,
        {
          identity: user.id,
          name: user.displayName,
          ttl: MEDIA_TOKEN_TTL_SECONDS,
        },
      );
      accessToken.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      });

      // Single-active-session: record THIS room as the user's active voice session
      // and evict any session in a DIFFERENT room (another device). Fire-and-forget
      // — the LiveKit admin RPC + realtime publish must never delay or fail the
      // join (recordAndEvict already swallows every error internally). The evicted
      // device is force-removed a moment later; its LiveKit disconnect drives the
      // clean leave regardless. Keyed on the RESOLVED room so a reconnect into a
      // call room does not self-evict the ongoing call.
      if (voiceSessions) {
        void voiceSessions.recordAndEvict(user.id, roomName);
      }

      return {
        url: server.apiEnv.livekitUrl,
        token: await accessToken.toJwt(),
        roomName,
        identity: user.id,
        expiresAt: new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString(),
      };
    },
  );
}
