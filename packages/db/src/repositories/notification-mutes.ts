import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  NotificationMute,
  NotificationMuteMode,
  NotificationMuteScope,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toNotificationMute } from "../mappers.js";
import { notificationMutes } from "../schema.js";

/**
 * The slim, active-only projection the push filter reads (a subset of the full
 * {@link NotificationMute}). Deliberately narrower than the DTO — the filter only
 * needs to know, per user, WHICH target is muted and HOW hard — so the query
 * ships four columns, never the timestamps. Mirrors the `PushTokenStore` /
 * notifications-package split: the store returns rows, a pure function decides.
 */
export interface ActiveNotificationMute {
  userId: UserId;
  scope: NotificationMuteScope;
  targetId: string;
  mode: NotificationMuteMode;
}

/**
 * Notification-mute query layer (migration 0013). Backs "Kanalı Sustur" /
 * "Sunucuyu Sustur": one row per (user, scope, target), so {@link setMute} upserts
 * on the composite PK and {@link clearMute} deletes.
 *
 * The push path never reads the full list — it calls {@link listActiveForRecipients}
 * with the ONE message's (channelId, groupId) and the candidate recipients, and
 * gets back only the currently-active (non-expired) rows that bear on that
 * message. The notifications package folds those into a keep/drop decision.
 */
export function notificationMutesRepo(db: Db) {
  return {
    /**
     * Create or replace the caller's mute on a target. Idempotent on the PK
     * (user, scope, target): re-muting the same target updates `mode`/`until`
     * and bumps `updated_at` instead of inserting a duplicate. `until` is the
     * auto-expiry instant (null ⇒ indefinite). Returns the resulting row.
     */
    async setMute(input: {
      userId: UserId;
      scope: NotificationMuteScope;
      targetId: string;
      mode: NotificationMuteMode;
      until: Date | null;
    }): Promise<NotificationMute> {
      const [row] = await db
        .insert(notificationMutes)
        .values({
          userId: input.userId,
          scope: input.scope,
          targetId: input.targetId,
          mode: input.mode,
          until: input.until,
        })
        .onConflictDoUpdate({
          target: [
            notificationMutes.userId,
            notificationMutes.scope,
            notificationMutes.targetId,
          ],
          set: {
            mode: input.mode,
            until: input.until,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (!row) throw new Error("upsert notification_mutes returned no row");
      return toNotificationMute(row);
    },

    /**
     * Remove the caller's mute on a target (unmute). Scoped to `userId` so one
     * user can never clear another's mute. Idempotent — returns false when there
     * was nothing to clear.
     */
    async clearMute(
      userId: UserId,
      scope: NotificationMuteScope,
      targetId: string,
    ): Promise<boolean> {
      const removed = await db
        .delete(notificationMutes)
        .where(
          and(
            eq(notificationMutes.userId, userId),
            eq(notificationMutes.scope, scope),
            eq(notificationMutes.targetId, targetId),
          ),
        )
        .returning({ userId: notificationMutes.userId });
      return removed.length > 0;
    },

    /**
     * Every mute the caller has set, newest first. Includes expired rows (the
     * client shows them until it re-syncs and can offer a one-tap re-mute); an
     * elapsed `until` is treated as unmuted by the push filter regardless.
     */
    async listForUser(userId: UserId): Promise<NotificationMute[]> {
      const rows = await db
        .select()
        .from(notificationMutes)
        .where(eq(notificationMutes.userId, userId))
        .orderBy(sql`${notificationMutes.createdAt} desc`);
      return rows.map(toNotificationMute);
    },

    /**
     * The push-filter primitive: for a single message's (channelId, groupId),
     * the currently-active mute rows among `userIds` that bear on it — i.e. a
     * channel-scope row on `channelId` or a group-scope row on `groupId`, whose
     * `until` is null or still in the future. Empty `userIds` short-circuits.
     *
     * `now` (default: request time) drives the expiry predicate so tests can
     * assert an elapsed mute reads as unmuted without touching the row.
     */
    async listActiveForRecipients(input: {
      userIds: readonly UserId[];
      channelId?: string;
      groupId?: string;
      now?: Date;
    }): Promise<ActiveNotificationMute[]> {
      const { userIds, channelId, groupId } = input;
      if (userIds.length === 0) return [];

      const targetPredicates = [
        channelId
          ? and(eq(notificationMutes.scope, "channel"), eq(notificationMutes.targetId, channelId))
          : undefined,
        groupId
          ? and(eq(notificationMutes.scope, "group"), eq(notificationMutes.targetId, groupId))
          : undefined,
      ].filter((p): p is NonNullable<typeof p> => p !== undefined);
      // No target to match ⇒ nothing can be muted.
      if (targetPredicates.length === 0) return [];

      const now = input.now ?? new Date();
      const rows = await db
        .select({
          userId: notificationMutes.userId,
          scope: notificationMutes.scope,
          targetId: notificationMutes.targetId,
          mode: notificationMutes.mode,
        })
        .from(notificationMutes)
        .where(
          and(
            inArray(notificationMutes.userId, [...userIds]),
            or(isNull(notificationMutes.until), gt(notificationMutes.until, now)),
            or(...targetPredicates),
          ),
        );
      return rows.map((r) => ({
        userId: r.userId,
        scope: r.scope as NotificationMuteScope,
        targetId: r.targetId,
        mode: r.mode as NotificationMuteMode,
      }));
    },
  };
}

export type NotificationMutesRepo = ReturnType<typeof notificationMutesRepo>;
