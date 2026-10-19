/**
 * LiveKit webhook receiver — the SERVER-SIDE JOIN CHECK.
 *
 * POST /hooks/livekit   (called by the SFU, never by a client)
 *
 * A LiveKit token cannot be revoked. A member who is kicked, banned or timed
 * out is force-removed from every room at that moment (lib/voice-eviction.ts),
 * but the token they were holding — or the one the SFU refreshed for them a
 * minute earlier — still verifies for up to ten minutes, and a modified client
 * can simply connect again with it. The token gate (`POST /media/token`,
 * `/dm-calls/*`) cannot see that join: no request reaches us.
 *
 * The SFU can, so it tells us. On every `participant_joined` this re-runs the
 * SAME authorization the token endpoints apply, against the database as it is
 * NOW, and force-removes a participant who no longer passes it:
 *   - a voice-channel room (`<channelId>`): member of the channel's group, the
 *     channel is a voice channel that really runs in this room, the member can
 *     see it, and is not timed out;
 *   - a call room (`dmcall:<callId>`): one of the two participants of the LIVE
 *     call, or — after an upgrade — a member allowed into the group voice
 *     channel bound to that room.
 *
 * Fail-OPEN on our own errors: a database hiccup must never boot a legitimate
 * participant out of a call, so "could not decide" leaves them in and logs. A
 * room name of neither shape is not ours to judge and is ignored the same way.
 *
 * Authenticity: the request is signed by the SFU with the API secret (JWT in
 * `Authorization` carrying the body's sha256) and verified with
 * `WebhookReceiver` over the RAW body — anything else is a 401. The SFU only
 * calls this endpoint when `webhook:` is configured in its livekit.yaml.
 */

import type { FastifyInstance } from "fastify";
import { WebhookReceiver, type WebhookEvent, type RoomServiceClient } from "livekit-server-sdk";
import { DM_CALL_ROOM_PREFIX } from "@demli/db";
import type { ChannelId, UserId } from "@demli/types";
import { errorBody } from "../../errors.js";
import { isTimedOut } from "../../lib/timeout.js";

/**
 * Under `/hooks/` on purpose: that prefix is exempt from the client-identity
 * gate (plugins/client-gate.ts), which would otherwise refuse the SFU — a
 * machine caller that never sends a client mark — the moment the gate is armed.
 */
export const LIVEKIT_WEBHOOK_ROUTE = "/hooks/livekit";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RoomJoinVerdict = "allowed" | "denied" | "not_ours";

/** The SFU capability the join check needs — the exact `RoomServiceClient` method. */
export type RoomJoinEjector = Pick<RoomServiceClient, "removeParticipant">;

export interface LivekitWebhookModuleOptions {
  /** SFU admin used to remove a participant who fails the check. Null ⇒ check only logs. */
  ejector: RoomJoinEjector | null;
}

/**
 * May `userId` be in LiveKit room `room` right now? The authorization the token
 * endpoints apply at mint time, re-read from the database. Throws only when the
 * database does — the caller treats that as "could not decide".
 */
export async function authorizeRoomJoin(
  server: FastifyInstance,
  room: string,
  userId: UserId,
): Promise<RoomJoinVerdict> {
  // Every participant we admit carries a user id as its identity; anything else
  // (an egress/agent worker) was not admitted by us and is not ours to remove.
  if (!UUID_PATTERN.test(userId)) return "not_ours";

  if (room.startsWith(DM_CALL_ROOM_PREFIX)) {
    const callId = room.slice(DM_CALL_ROOM_PREFIX.length);
    if (!UUID_PATTERN.test(callId)) return "not_ours";
    const call = await server.repos.calls.findById(callId);
    if (
      call &&
      (call.status === "ringing" || call.status === "active") &&
      (call.callerId === userId || call.calleeId === userId)
    ) {
      return "allowed";
    }
    const bound = await server.repos.channels.findByLivekitRoom(room);
    if (!bound) return call ? "denied" : "not_ours";
    return (await mayEnterVoiceChannel(server, bound.id, room, userId)) ? "allowed" : "denied";
  }

  if (!UUID_PATTERN.test(room)) return "not_ours";
  return (await mayEnterVoiceChannel(server, room, room, userId)) ? "allowed" : "denied";
}

/**
 * The voice-channel half: exactly `loadVisibleChannel` + the timeout gate of
 * `POST /media/token`, plus "this channel really runs in `room`" so a token for
 * one room can never be argued into another.
 */
async function mayEnterVoiceChannel(
  server: FastifyInstance,
  channelId: ChannelId,
  room: string,
  userId: UserId,
): Promise<boolean> {
  const access = await server.repos.channels.findWithMembership(channelId, userId);
  if (!access) return false;
  if (access.channel.kind !== "voice") return false;
  if ((access.livekitRoom ?? access.channel.id) !== room) return false;
  if (isTimedOut(access.timedOutUntil)) return false;
  return server.repos.channelAccess.canUserSeeChannel(access.channel.groupId, channelId, userId);
}

export async function registerLivekitWebhookModule(
  server: FastifyInstance,
  options: LivekitWebhookModuleOptions,
): Promise<void> {
  const receiver = new WebhookReceiver(server.apiEnv.livekitApiKey, server.apiEnv.livekitApiSecret);
  const { ejector } = options;

  async function enforce(event: WebhookEvent): Promise<void> {
    if (event.event !== "participant_joined") return;
    const room = event.room?.name;
    const identity = event.participant?.identity;
    if (!room || !identity) return;

    let verdict: RoomJoinVerdict;
    try {
      verdict = await authorizeRoomJoin(server, room, identity);
    } catch (err) {
      server.log.warn({ err, room }, "[livekit-webhook] join check failed — participant left in");
      return;
    }
    if (verdict !== "denied") return;

    server.log.info(`[livekit-webhook] removing unauthorized participant from ${room}`);
    if (!ejector) return;
    try {
      await ejector.removeParticipant(room, identity);
    } catch (err) {
      server.log.warn({ err, room }, "[livekit-webhook] removeParticipant failed");
    }
  }

  // Encapsulated scope: the raw-string parsers apply to this route only, so the
  // signature is checked over the exact bytes the SFU signed while every other
  // route keeps parsed JSON. LiveKit posts `application/webhook+json`; plain JSON
  // is accepted too so a proxy that rewrites the type cannot break the check.
  await server.register(async (scope) => {
    for (const type of ["application/webhook+json", "application/json"]) {
      scope.addContentTypeParser(type, { parseAs: "string" }, (_req, body, done) =>
        done(null, body),
      );
    }

    scope.post(LIVEKIT_WEBHOOK_ROUTE, { bodyLimit: 64 * 1024 }, async (request, reply) => {
      const body = typeof request.body === "string" ? request.body : "";
      let event: WebhookEvent;
      try {
        event = await receiver.receive(body, request.headers.authorization);
      } catch {
        return reply.status(401).send(errorBody("UNAUTHORIZED", "Invalid webhook signature."));
      }
      await enforce(event);
      return reply.status(200).send({ ok: true });
    });
  });
}
