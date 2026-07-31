import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { NotificationMute } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { loadVisibleChannel } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Notification-mute endpoints (migration 0013) — "Kanalı Sustur" /
 * "Sunucuyu Sustur", applied to the offline mobile-push path and the clients' unread
 * badges.
 *
 * - `PUT /notification-mutes`                     — mute (or re-mute) a target
 * - `DELETE /notification-mutes/:scope/:targetId` — unmute
 * - `GET /notification-mutes`                     — the caller's own mutes
 *
 * A mute is PRIVATE to the caller: every route is session-authenticated and
 * touches only the caller's rows (§28). Muting is gated on VISIBILITY — you can
 * only mute a channel you can see, or a group/server/DM you belong to — so a
 * mute never confirms the existence of something you cannot access. The push
 * filter (packages/notifications) reads these rows directly; a set/clear ALSO
 * fans out a user-scoped `notification_mute.updated` so the caller's OTHER
 * devices update their badges live. DM-call rings are never filtered — a call
 * always rings (that path does not consult mutes at all).
 */

/** ISO instant, must be in the future — the auto-expiry deadline (15m/1h/8h). */
const untilSchema = z
  .string()
  .datetime({ offset: true, message: "until must be an ISO-8601 timestamp." })
  .refine((value) => new Date(value).getTime() > Date.now(), {
    message: "until must be in the future.",
  });

const setMuteSchema = z.object({
  scope: z.enum(["channel", "group"]),
  targetId: z.string().uuid("Invalid target id."),
  mode: z.enum(["all", "mentions"]),
  // Omitted / null ⇒ indefinite; a value is the auto-expiry instant.
  until: untilSchema.nullish(),
});

const clearMuteParamsSchema = z.object({
  scope: z.enum(["channel", "group"]),
  targetId: z.string().uuid("Invalid target id."),
});

/** The `notification_mute.updated` payload for a still-active mute. */
function muteEvent(mute: NotificationMute) {
  return serverEvent.notificationMuteUpdated({
    scope: mute.scope,
    targetId: mute.targetId,
    mute: { mode: mute.mode, until: mute.until },
  });
}

export async function registerNotificationMutesModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // Mute (or re-mute) a target. Idempotent on (user, scope, target): re-muting
  // updates mode/until. Gated on visibility so you cannot mute — and thereby
  // probe the existence of — a channel/group you cannot access.
  server.put(
    "/notification-mutes",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { scope, targetId, mode, until } = parseWith(setMuteSchema, request.body);

      await assertCanSeeTarget(server, scope, targetId, user.id);

      const mute = await server.repos.notificationMutes.setMute({
        userId: user.id,
        scope,
        targetId,
        mode,
        until: until ? new Date(until) : null,
      });

      // Cross-device sync (best-effort): the caller's OTHER connections dim the
      // target and drop its unread badge at once. Never fails the request.
      await mutationBus?.publish({ userId: user.id, event: muteEvent(mute) });

      return { mute };
    },
  );

  // Unmute. Idempotent — a missing row is still a success (nothing to reveal).
  // No visibility check: clearing your own row is always safe, and a target you
  // can no longer see (left the server) must still be un-muteable.
  server.delete(
    "/notification-mutes/:scope/:targetId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { scope, targetId } = parseWith(clearMuteParamsSchema, request.params);

      const removed = await server.repos.notificationMutes.clearMute(user.id, scope, targetId);

      // Only fan out when something actually changed — a no-op clear needs no
      // event. `mute: null` tells the other devices to drop the local entry.
      if (removed) {
        await mutationBus?.publish({
          userId: user.id,
          event: serverEvent.notificationMuteUpdated({ scope, targetId, mute: null }),
        });
      }

      return reply.status(204).send();
    },
  );

  // The caller's own mutes (newest first). Includes expired rows so the client
  // can show and one-tap re-mute them; the push filter ignores expired ones.
  server.get(
    "/notification-mutes",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const mutes = await server.repos.notificationMutes.listForUser(user.id);
      return { mutes };
    },
  );
}

/**
 * Throw 404 unless the caller may mute this target:
 * - `channel` → the channel must be VISIBLE (member + M9 role filter), reusing
 *   the same guard every channel-scoped endpoint uses.
 * - `group`   → the caller must be a member of the friend_group (server, flat
 *   group chat, or DM — all uniform via `getMembership`).
 * Both answer the same "not found" as every other visibility guard, so a mute
 * never leaks the existence of an inaccessible target (§28).
 */
async function assertCanSeeTarget(
  server: FastifyInstance,
  scope: "channel" | "group",
  targetId: string,
  userId: string,
): Promise<void> {
  if (scope === "channel") {
    // Throws 404 "Channel not found." for a non-member or a restricted channel
    // the caller's roles do not grant.
    await loadVisibleChannel(server, targetId, userId);
    return;
  }
  const membership = await server.repos.groups.getMembership(targetId, userId);
  if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
}
