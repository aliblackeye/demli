/**
 * Server moderation — kick / ban / unban / voice-disconnect (migration 0017).
 *
 * These are the server side of the voice-participant / member right-click menu.
 * Every action is PERMISSION-GATED and SERVER-AUTHORITATIVE (§28) — the client is
 * never trusted, permissions are re-checked here, and the owner is immune.
 *
 * Routes:
 *   POST   /groups/:groupId/members/:userId/kick   remove a member (rejoin allowed)
 *   POST   /groups/:groupId/bans      { userId, reason? }   ban (kick + block rejoin)
 *   DELETE /groups/:groupId/bans/:userId                    lift a ban
 *   GET    /groups/:groupId/bans                            the ban list
 *   POST   /channels/:channelId/voice/:userId/disconnect    boot from a voice room
 *   GET    /groups/:groupId/moderation-log                  the audit log (M18)
 *
 * Audit log (M18, migration 0019): EVERY successful action above also appends a
 * `moderation_actions` row. `group_bans` records the CURRENT ban state; the log
 * records the HISTORY — including kick, unban, and voice-disconnect, which leave
 * no lasting state at all, which is exactly why a ban list is not an audit log.
 * The write is BEST-EFFORT and happens after the real effect: the membership
 * removal is the source of truth, so a failed log write must never roll back or
 * fail a moderation action (it is logged instead).
 *
 * Permission model (ADR 0007 — the MVP has no role HIERARCHY, so "higher role"
 * reduces to owner-immunity):
 *   - kick / ban / unban / list bans / disconnect → owner ∨ KICK_MEMBERS
 *   - the owner can never be kicked/banned/disconnected by anyone else
 *   - you cannot kick/ban YOURSELF here (leave the server instead)
 *
 * Realtime: kick and ban both publish the group-scoped `member.left` (the gateway
 * already unsubscribes the removed member, forces them out of any of the server's
 * voice rooms, and refreshes every roster) PLUS a user-scoped `member.kicked` /
 * `member.banned` notice to the target's own devices. Voice-disconnect force-
 * removes the SFU participant (`RoomServiceClient.removeParticipant`) and publishes
 * a user-scoped `voice.disconnected` — media teardown is the SFU's job, the event
 * is only the clean-leave/notice signal (§10/§35).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  MODERATION_LOG_MAX_LIMIT,
  type RealtimeMutationPublisher,
} from "@demli/db";
import { serverEvent, timeoutMemberBodySchema } from "@demli/protocol";
import type { GroupId, ModerationActionType, UserId } from "@demli/types";
import { PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { loadServer, loadVisibleChannel, requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { livekitHttpUrl } from "../media/voice-session.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/** Max length of the optional moderator ban note. */
const BAN_REASON_MAX_LENGTH = 512;

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const memberParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
  userId: z.string().uuid("Invalid user id."),
});

const banBodySchema = z.object({
  userId: z.string().uuid("Invalid user id."),
  reason: z.string().trim().max(BAN_REASON_MAX_LENGTH).optional(),
});

const voiceDisconnectParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
  userId: z.string().uuid("Invalid user id."),
});

/**
 * Audit-log query (M18). `limit` is coerced from the query string and clamped
 * (the repo re-clamps authoritatively); `before` is the opaque keyset cursor from
 * a previous page's `nextCursor` — the SAME cursor shape the message pages use.
 */
const moderationLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MODERATION_LOG_MAX_LIMIT).optional(),
  before: z.string().min(1).max(512).optional(),
});

/**
 * The SFU capability the voice-disconnect endpoint needs: force-remove one
 * participant from a room. Deliberately the exact `RoomServiceClient` method
 * signature so the production wiring is a bare `RoomServiceClient` and tests
 * inject a `{ removeParticipant: vi.fn() }` with no live LiveKit.
 */
export type VoiceModerator = Pick<RoomServiceClient, "removeParticipant">;

/**
 * Build the LiveKit-backed voice moderator from env — mirrors
 * {@link createVoiceSessions} / {@link createVoiceOccupancyReader}: the admin
 * client reuses the token-minting creds and the http(s) form of the ws(s) client
 * URL. Always constructible (env carries dev defaults); an unreachable host simply
 * makes the force-remove a best-effort no-op at request time, never a boot failure.
 */
export function createVoiceModerator(server: FastifyInstance): VoiceModerator {
  return new RoomServiceClient(
    livekitHttpUrl(server.apiEnv.livekitUrl),
    server.apiEnv.livekitApiKey,
    server.apiEnv.livekitApiSecret,
  );
}

export interface ModerationModuleOptions {
  mutationBus?: RealtimeMutationPublisher;
  /**
   * SFU admin used by the voice-disconnect endpoint. Built from env in `buildApp`
   * via {@link createVoiceModerator}; tests inject a fake. Null/omitted ⇒ the
   * endpoint skips the SFU force-remove and relies on the `voice.disconnected`
   * event alone (degraded, but the client still leaves cleanly).
   */
  voiceModerator?: VoiceModerator | null;
}

export async function registerModerationModule(
  server: FastifyInstance,
  options: ModerationModuleOptions = {},
): Promise<void> {
  const mutationBus = options.mutationBus;
  const voiceModerator = options.voiceModerator ?? null;

  // --- Kick: remove a member; rejoin via a new invite stays allowed ----------
  server.post(
    "/groups/:groupId/members/:userId/kick",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);

      // 404 (not 403) for non-members / non-servers — membership + kind are never
      // leaked. Returns the server row + the actor's membership role.
      const { group, role } = await loadServer(server, groupId, actor.id);

      assertModeratableTarget(actor.id, userId, group.ownerId, "kicked");
      const target = await server.repos.groups.getMembership(groupId, userId);
      if (!target) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to remove members.",
      );

      const removed = await server.repos.groups.removeMember(groupId, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: userId,
        action: "kick",
      });
      await publishMemberRemoved(mutationBus, group.id, group.name, userId, "kicked");
      return reply.status(204).send();
    },
  );

  // --- Ban: kick + permanent block (records a group_bans row) ----------------
  server.post(
    "/groups/:groupId/bans",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(banBodySchema, request.body);

      const { group, role } = await loadServer(server, groupId, actor.id);
      assertModeratableTarget(actor.id, body.userId, group.ownerId, "banned");
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to ban members.",
      );

      // Record the durable ban (idempotent upsert). Banning a non-member (a
      // pre-emptive ban by id) is allowed — it just records the row.
      const ban = await server.repos.groupBans.ban({
        groupId,
        userId: body.userId,
        bannedBy: actor.id,
        reason: body.reason ?? null,
      });

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: body.userId,
        action: "ban",
        reason: body.reason ?? null,
      });

      // If the target was in the server, remove them and broadcast, exactly like a
      // kick — plus the ban-specific notice.
      const removed = await server.repos.groups.removeMember(groupId, body.userId);
      if (removed) {
        await publishMemberRemoved(mutationBus, group.id, group.name, body.userId, "banned");
      }

      return reply.status(201).send({ ban });
    },
  );

  // --- Unban: lift a ban -----------------------------------------------------
  server.delete(
    "/groups/:groupId/bans/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);

      const { role } = await loadServer(server, groupId, actor.id);
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to manage bans.",
      );

      const removed = await server.repos.groupBans.unban(groupId, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "That user is not banned.");

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: userId,
        action: "unban",
      });
      return reply.status(204).send();
    },
  );

  // --- List bans -------------------------------------------------------------
  server.get(
    "/groups/:groupId/bans",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const actor = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);

      const { role } = await loadServer(server, groupId, actor.id);
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to view the ban list.",
      );

      return { bans: await server.repos.groupBans.listForGroup(groupId) };
    },
  );

  // --- Voice disconnect: boot a user from a voice room (stays in the server) --
  server.post(
    "/channels/:channelId/voice/:userId/disconnect",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { channelId, userId } = parseWith(voiceDisconnectParamsSchema, request.params);

      // Existence + membership + M9 visibility: a channel the actor cannot see is
      // a 404 (no existence leak). `livekitRoom` is the explicit room override
      // (ADR 0012 §6) — the room the participant is actually in.
      const found = await loadVisibleChannel(server, channelId, actor.id);
      if (found.channel.kind !== "voice") {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "You can only disconnect users from voice channels.",
        );
      }
      const groupId = found.channel.groupId;

      // The owner can only be disconnected by themselves.
      const group = await server.repos.groups.findById(groupId);
      if (group && userId === group.ownerId && actor.id !== group.ownerId) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "You cannot disconnect the server owner.",
        );
      }

      await requirePerm(
        server,
        groupId,
        found.role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to disconnect members from voice.",
      );

      // The target must be a member of the channel's group (a non-member cannot be
      // in its voice room). 404 keeps it consistent with the kick path.
      const target = await server.repos.groups.getMembership(groupId, userId);
      if (!target) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      // Room resolution mirrors the media-token endpoint: `livekitRoom ?? id`.
      const roomName = found.livekitRoom ?? channelId;

      // Force-remove the SFU participant — the AUTHORITATIVE teardown. Best-effort:
      // the participant may already be gone (LiveKit then throws), which is fine;
      // the `voice.disconnected` event below still drives a clean client leave. A
      // failure here (e.g. SFU unreachable) never fails the request — consistent
      // with the single-session eviction path (voice-session.ts).
      if (voiceModerator) {
        try {
          await voiceModerator.removeParticipant(roomName, userId);
        } catch (err) {
          request.log.info(
            `voice disconnect removeParticipant(${roomName}) failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // User-scoped notice: the target's own devices leave the room cleanly and
      // show a localized message; a device NOT in `roomId` ignores it.
      await mutationBus?.publish({
        userId,
        event: serverEvent.voiceDisconnected({
          roomId: roomName,
          channelId,
          reason: "moderator",
        }),
      });

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: userId,
        action: "voice_disconnect",
      });

      return reply.status(204).send();
    },
  );

  // --- Timeout: mute a member for N minutes (they stay in the server) --------
  //
  // Permission: owner ∨ KICK_MEMBERS — the SAME bit as kick, reused deliberately.
  // A timeout is strictly LESS severe than a kick (temporary, reversible, keeps
  // membership and history), so gating it behind the kick bit grants no new
  // authority to anyone who does not already have it: everyone who can time
  // someone out could already have removed them outright. A separate bit would
  // only let an owner grant "may mute but may not kick", which is a distinction
  // this MVP has no hierarchy to make sense of (ADR 0007).
  //
  // Contrast `MANAGE_NICKNAMES`, which IS a new bit — because a nickname edit is
  // cosmetic and gating it behind kick would force the opposite trade.
  server.post(
    "/groups/:groupId/members/:userId/timeout",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);
      const body = parseWith(timeoutMemberBodySchema, request.body);

      const { group, role } = await loadServer(server, groupId, actor.id);
      assertModeratableTarget(actor.id, userId, group.ownerId, "timed out");
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to time out members.",
      );

      // SERVER clock, always. The body carries a DURATION, and the expiry is
      // computed here — a client that sent an absolute instant could shorten its
      // own mute (or lengthen someone else's) just by being wrong about the time.
      const timedOutUntil = new Date(Date.now() + body.minutes * 60 * 1000);

      const updated = await server.repos.groups.setMemberTimeout(
        groupId,
        userId,
        timedOutUntil,
      );
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: userId,
        action: "timeout",
        reason: body.reason ?? null,
        expiresAt: timedOutUntil,
      });
      await publishTimeout(mutationBus, groupId, userId, timedOutUntil.toISOString(), actor.id);

      return reply.status(200).send({ member: updated });
    },
  );

  // --- Lift a timeout early --------------------------------------------------
  //
  // Needed even though timeouts self-expire: "let them back in now" is a real
  // moderation decision, and it is logged as its own action so the audit trail
  // can explain why a 24-hour mute ended after ten minutes.
  server.delete(
    "/groups/:groupId/members/:userId/timeout",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const actor = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);

      const { role } = await loadServer(server, groupId, actor.id);
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to manage timeouts.",
      );

      const updated = await server.repos.groups.setMemberTimeout(groupId, userId, null);
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      await recordModerationAction(server, request, {
        groupId,
        actorId: actor.id,
        targetId: userId,
        action: "timeout_remove",
      });
      await publishTimeout(mutationBus, groupId, userId, null, actor.id);

      return reply.status(204).send();
    },
  );

  // --- Audit log: what has been done in this server, newest first ------------
  //
  // Same authority as the ban list (owner ∨ KICK_MEMBERS): whoever may moderate
  // may see what has been moderated. Keyset-paged on the standard
  // `(createdAt, id)` cursor, so pages stay disjoint under concurrent writes.
  server.get(
    "/groups/:groupId/moderation-log",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const actor = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const query = parseWith(moderationLogQuerySchema, request.query);

      const { role } = await loadServer(server, groupId, actor.id);
      await requirePerm(
        server,
        groupId,
        role,
        actor.id,
        PERMISSIONS.KICK_MEMBERS,
        "You do not have permission to view the moderation log.",
      );

      const page = await server.repos.moderationActions.listForGroup(groupId, {
        limit: query.limit,
        before: query.before ?? null,
      });
      return { entries: page.items, nextCursor: page.nextCursor };
    },
  );
}

/**
 * Append one audit-log row (M18). BEST-EFFORT by contract: the moderation effect
 * is already committed and IS the source of truth, so a failed log write is
 * logged and swallowed rather than failing the request — losing a history line
 * must never leave a member half-kicked.
 */
async function recordModerationAction(
  server: FastifyInstance,
  request: FastifyRequest,
  input: {
    groupId: GroupId;
    actorId: UserId;
    targetId: UserId;
    action: ModerationActionType;
    reason?: string | null;
    /** `timeout` only: when the mute expires, so the log line can say how long. */
    expiresAt?: Date | null;
  },
): Promise<void> {
  try {
    await server.repos.moderationActions.record(input);
  } catch (err) {
    request.log.error(
      { err, groupId: input.groupId, action: input.action },
      "moderation audit log write failed",
    );
  }
}

/**
 * Guard the target of a kick/ban: never yourself (leave instead), never the
 * owner. `verb` shapes the error copy ("kicked" / "banned").
 */
function assertModeratableTarget(
  actorId: string,
  targetId: string,
  ownerId: string,
  verb: "kicked" | "banned" | "timed out",
): void {
  if (targetId === actorId) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      verb === "timed out"
        ? "You cannot time yourself out."
        : `You cannot ${verb === "kicked" ? "kick" : "ban"} yourself. Leave the server instead.`,
    );
  }
  if (targetId === ownerId) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `The server owner cannot be ${verb}.`,
    );
  }
}

/**
 * Publish a timeout change. GROUP-scoped, which INCLUDES the target (they are a
 * member, so the group fan-out already reaches their devices) — that is why
 * there is no separate user-scoped "you were timed out" notice the way a kick
 * needs one. A kick needs it because the group membership is gone by the time
 * the event lands; a timeout leaves membership intact, so the ordinary group
 * audience is exactly right.
 *
 * Best-effort, like every other publish here: the column is the source of truth,
 * and enforcement re-reads it on every write attempt regardless of this event.
 */
async function publishTimeout(
  bus: RealtimeMutationPublisher | undefined,
  groupId: string,
  userId: string,
  timedOutUntil: string | null,
  actorId: string,
): Promise<void> {
  await bus?.publish({
    groupId,
    event: serverEvent.memberTimeoutUpdated({ groupId, userId, timedOutUntil, actorId }),
  });
}

/**
 * Publish the two realtime signals a kick/ban emits: the group-scoped
 * `member.left` (the gateway does the roster refresh + subscription/voice
 * teardown of the removed member) and the user-scoped `member.kicked` /
 * `member.banned` notice to the target's own devices. Best-effort — the DB write
 * is already the source of truth (the publisher swallows its own errors).
 */
async function publishMemberRemoved(
  mutationBus: RealtimeMutationPublisher | undefined,
  groupId: string,
  groupName: string,
  userId: string,
  kind: "kicked" | "banned",
): Promise<void> {
  if (!mutationBus) return;
  await mutationBus.publish({
    groupId,
    event: serverEvent.memberLeft({ groupId, userId }),
  });
  await mutationBus.publish({
    userId,
    event:
      kind === "kicked"
        ? serverEvent.memberKicked({ groupId, groupName })
        : serverEvent.memberBanned({ groupId, groupName }),
  });
}
