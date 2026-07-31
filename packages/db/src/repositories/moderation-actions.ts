import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  GroupId,
  ModerationAction,
  ModerationActionEntry,
  ModerationActionType,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toModerationAction, toUser } from "../mappers.js";
import {
  buildMessagesPage,
  decodeMessageCursor,
  type MessagesPage,
} from "../pagination.js";
import { moderationActions, users } from "../schema.js";

/** Audit-log page sizing — a settings screen list, not a hot path. */
export const MODERATION_LOG_DEFAULT_LIMIT = 25;
export const MODERATION_LOG_MAX_LIMIT = 100;

/**
 * Moderation AUDIT LOG (M18). Append-only history of every kick / ban / unban /
 * voice-disconnect, written by the moderation endpoints alongside their real
 * effect. `group_bans` holds the CURRENT ban state; this holds what happened —
 * including the actions (kick, unban, voice-disconnect) that leave no state at
 * all, which is exactly why a bans list is not an audit log.
 *
 * Reads are newest-first and keyset-paged on the SAME `(createdAt, id)` cursor
 * shape the message pages use, so pages stay disjoint under concurrent writes.
 */
export function moderationActionsRepo(db: Db) {
  return {
    /**
     * Record one action. Callers treat this as BEST-EFFORT: the moderation effect
     * (the membership removal, the ban row) is the source of truth, so a failed
     * log write must never fail or roll back the action itself — the endpoints
     * wrap this in a try/catch and log.
     */
    async record(input: {
      groupId: GroupId;
      actorId: UserId | null;
      targetId: UserId;
      action: ModerationActionType;
      reason?: string | null;
      /** `timeout` only (migration 0020): when the mute was set to expire. */
      expiresAt?: Date | null;
    }): Promise<ModerationAction> {
      const [row] = await db
        .insert(moderationActions)
        .values({
          groupId: input.groupId,
          actorId: input.actorId,
          targetId: input.targetId,
          action: input.action,
          reason: input.reason ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error("insert moderation_actions returned no row");
      return toModerationAction(row);
    },

    /**
     * One server's log, newest first, keyset-paged. Each entry is hydrated with
     * the actor and target user records in ONE batched `WHERE id IN (…)` lookup
     * (no N+1). `actor` is null for a purged moderator (the FK went SET NULL);
     * `target` is null only if the row's user vanished, which the cascade makes
     * impossible in practice — the field stays nullable so a partial read is
     * still renderable.
     *
     * Authorization (owner ∨ KICK_MEMBERS) is the caller's job — this layer only
     * runs the query for an already-authorized group.
     */
    async listForGroup(
      groupId: GroupId,
      options: { limit?: number; before?: string | null } = {},
    ): Promise<MessagesPage<ModerationActionEntry>> {
      const limit = Math.min(
        Math.max(options.limit ?? MODERATION_LOG_DEFAULT_LIMIT, 1),
        MODERATION_LOG_MAX_LIMIT,
      );
      const cursor = options.before ? decodeMessageCursor(options.before) : null;

      const conditions = [eq(moderationActions.groupId, groupId)];
      if (cursor) {
        conditions.push(
          sql`(${moderationActions.createdAt}, ${moderationActions.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select()
        .from(moderationActions)
        .where(and(...conditions))
        .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
        .limit(limit + 1);

      const actions = rows.map(toModerationAction);
      // `buildMessagesPage` keys the cursor off `{ id, createdAt }`, which the
      // action DTO already carries — so the page is built on the ACTION rows and
      // hydration happens after, only for the rows that made the cut.
      const page = buildMessagesPage(actions, limit);

      const userIds = [
        ...new Set(
          page.items.flatMap((a) => (a.actorId ? [a.actorId, a.targetId] : [a.targetId])),
        ),
      ];
      const byId = new Map<UserId, ReturnType<typeof toUser>>();
      if (userIds.length > 0) {
        const userRows = await db.select().from(users).where(inArray(users.id, userIds));
        for (const row of userRows) byId.set(row.id, toUser(row));
      }

      return {
        items: page.items.map(
          (action): ModerationActionEntry => ({
            action,
            actor: action.actorId ? (byId.get(action.actorId) ?? null) : null,
            target: byId.get(action.targetId) ?? null,
          }),
        ),
        nextCursor: page.nextCursor,
      };
    },
  };
}

export type ModerationActionsRepo = ReturnType<typeof moderationActionsRepo>;
