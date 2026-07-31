import { eq, inArray, sql } from "drizzle-orm";
import type { MessageId, MessageReactionSummary, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { messageReactions } from "../schema.js";

/**
 * Emoji-reaction persistence (ADR 0011 §1). One row per (message, user, emoji);
 * the composite PRIMARY KEY is the idempotency guard, so this layer needs no
 * dedupe logic and keeps no counter — the count is always `count(*)`. Palette
 * validation (`isReactionEmoji`) and channel-visibility authorization live at the
 * API boundary; this layer only persists and aggregates.
 */
export function messageReactionsRepo(db: Db) {
  return {
    /**
     * Add my reaction. `INSERT … ON CONFLICT (message_id,user_id,emoji) DO
     * NOTHING` — idempotent: a repeat is a no-op. `added` is true only when a new
     * row was written (false on a duplicate), so the API can skip re-broadcasting.
     */
    async add(
      messageId: MessageId,
      userId: UserId,
      emoji: string,
    ): Promise<{ added: boolean }> {
      const inserted = await db
        .insert(messageReactions)
        .values({ messageId, userId, emoji })
        .onConflictDoNothing({
          target: [messageReactions.messageId, messageReactions.userId, messageReactions.emoji],
        })
        .returning({ messageId: messageReactions.messageId });
      return { added: inserted.length > 0 };
    },

    /**
     * Remove my reaction — keyed `DELETE`. Idempotent: removing one that isn't
     * there returns `{ removed: false }` and never errors.
     */
    async remove(
      messageId: MessageId,
      userId: UserId,
      emoji: string,
    ): Promise<{ removed: boolean }> {
      const deleted = await db
        .delete(messageReactions)
        .where(
          sql`${messageReactions.messageId} = ${messageId}::uuid
            and ${messageReactions.userId} = ${userId}::uuid
            and ${messageReactions.emoji} = ${emoji}`,
        )
        .returning({ messageId: messageReactions.messageId });
      return { removed: deleted.length > 0 };
    },

    /**
     * Aggregate reactions for a page of messages in ONE grouped query (no N+1) —
     * mirrors `attachments.listForMessages`. Per (message, emoji): the `count`,
     * and `reactedByMe` via `bool_or(user = viewer)`. Ordered by each emoji's
     * FIRST occurrence (`min(created_at)`) so pills keep a stable position as
     * counts change (ADR 0011 §1). Messages with no reactions are simply absent
     * from the map; the caller reads `map.get(id) ?? []`.
     */
    async summariesForMessages(
      messageIds: MessageId[],
      viewerId: UserId,
    ): Promise<Map<MessageId, MessageReactionSummary[]>> {
      const grouped = new Map<MessageId, MessageReactionSummary[]>();
      const ids = [...new Set(messageIds)];
      if (ids.length === 0) return grouped;

      const rows = await db
        .select({
          messageId: messageReactions.messageId,
          emoji: messageReactions.emoji,
          count: sql<number>`count(*)::int`,
          reactedByMe: sql<boolean>`bool_or(${messageReactions.userId} = ${viewerId}::uuid)`,
        })
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, ids))
        .groupBy(messageReactions.messageId, messageReactions.emoji)
        .orderBy(sql`min(${messageReactions.createdAt}) asc`);

      for (const row of rows) {
        const summary: MessageReactionSummary = {
          emoji: row.emoji,
          count: Number(row.count),
          reactedByMe: row.reactedByMe === true,
        };
        const bucket = grouped.get(row.messageId);
        if (bucket) bucket.push(summary);
        else grouped.set(row.messageId, [summary]);
      }
      return grouped;
    },

    /**
     * Reap every reaction on a message. Called by `messagesRepo.softDelete` (a
     * soft-deleted message shows no reactions and reclaims the rows); a hard
     * delete already cascades them via the FK. Returns the number of rows removed.
     */
    async deleteForMessage(messageId: MessageId): Promise<number> {
      const deleted = await db
        .delete(messageReactions)
        .where(eq(messageReactions.messageId, messageId))
        .returning({ messageId: messageReactions.messageId });
      return deleted.length;
    },
  };
}

export type MessageReactionsRepo = ReturnType<typeof messageReactionsRepo>;
