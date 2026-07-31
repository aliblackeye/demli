import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { PINS_MAX_PER_CHANNEL } from "@demli/config";
import type { ChannelId, MessageId, PinnedMessage, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toMessage } from "../mappers.js";
import { messagePins, messages } from "../schema.js";

/**
 * Outcome of a {@link MessagePinsRepo.pin} attempt.
 *
 * `pinned` distinguishes "a new row was written" from "it was already pinned",
 * so the API can skip re-broadcasting an idempotent repeat (the same shape as
 * `messageReactions.add`). `atCapacity` is the ONE failure this layer reports
 * rather than throwing: the channel already holds `PINS_MAX_PER_CHANNEL` pins, so
 * the API answers 409 instead of silently dropping the request.
 */
export interface PinResult {
  pinned: boolean;
  atCapacity: boolean;
  /** The stored pin (present whenever the message is pinned — new or pre-existing). */
  pin: { messageId: MessageId; pinnedBy: UserId; pinnedAt: string } | null;
}

/**
 * Pinned-message persistence (M17). One row per pinned message — `message_id` is
 * the PRIMARY KEY, so pinning is `INSERT … ON CONFLICT DO NOTHING` and needs no
 * dedupe logic here (the same idempotency-by-key shape as `message_reactions`).
 *
 * Authorization (author ∨ MANAGE_MESSAGES ∨ open-in-DM) and channel visibility
 * live at the API boundary; this layer only persists, counts and reads back.
 *
 * SOFT-DELETED MESSAGES ARE NEVER RETURNED. Every read filters
 * `messages.deleted_at IS NULL`, because a soft delete does not cascade the pin
 * row — the API drops it explicitly on delete, and this filter is the belt-and-
 * suspenders guarantee that a deleted message can never surface on a pin board
 * even if that reap ever failed.
 */
export function messagePinsRepo(db: Db) {
  return {
    /**
     * Pin a message, enforcing the per-channel cap ATOMICALLY.
     *
     * The count and the insert run in ONE transaction because they are a
     * check-then-act pair: two concurrent pins that both counted 49 would
     * otherwise both insert and leave the channel at 51. The count is taken with
     * the insert inside the same transaction so the cap is a real invariant, not
     * a hopeful pre-check.
     *
     * Idempotent: re-pinning an already-pinned message writes nothing, reports
     * `pinned: false`, and — crucially — does NOT count against the cap (an
     * already-pinned message is already inside the 50), so a spammed pin on a full
     * board is a no-op rather than a 409.
     */
    async pin(
      messageId: MessageId,
      channelId: ChannelId,
      pinnedBy: UserId,
    ): Promise<PinResult> {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            messageId: messagePins.messageId,
            pinnedBy: messagePins.pinnedBy,
            pinnedAt: messagePins.pinnedAt,
          })
          .from(messagePins)
          .where(eq(messagePins.messageId, messageId))
          .limit(1);

        // Already pinned: report the existing row untouched. Re-pinning must not
        // move `pinnedAt` (that would reshuffle the board) and must not 409 on a
        // full channel — this message is already one of the 50.
        if (existing) {
          return {
            pinned: false,
            atCapacity: false,
            pin: {
              messageId: existing.messageId,
              pinnedBy: existing.pinnedBy,
              pinnedAt: existing.pinnedAt.toISOString(),
            },
          };
        }

        const [counted] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messagePins)
          .where(eq(messagePins.channelId, channelId));
        if (Number(counted?.count ?? 0) >= PINS_MAX_PER_CHANNEL) {
          return { pinned: false, atCapacity: true, pin: null };
        }

        const [inserted] = await tx
          .insert(messagePins)
          .values({ messageId, channelId, pinnedBy })
          .onConflictDoNothing({ target: messagePins.messageId })
          .returning({
            messageId: messagePins.messageId,
            pinnedBy: messagePins.pinnedBy,
            pinnedAt: messagePins.pinnedAt,
          });

        // Lost an insert race against a concurrent pin of the SAME message: the
        // row exists, so this is the idempotent path, not a failure.
        if (!inserted) {
          return { pinned: false, atCapacity: false, pin: null };
        }
        return {
          pinned: true,
          atCapacity: false,
          pin: {
            messageId: inserted.messageId,
            pinnedBy: inserted.pinnedBy,
            pinnedAt: inserted.pinnedAt.toISOString(),
          },
        };
      });
    },

    /**
     * Unpin — a keyed `DELETE`. Idempotent: unpinning a message that is not
     * pinned returns `{ unpinned: false }` and never errors, so the API can skip
     * the fan-out on a no-op (mirroring `messageReactions.remove`).
     */
    async unpin(messageId: MessageId): Promise<{ unpinned: boolean }> {
      const deleted = await db
        .delete(messagePins)
        .where(eq(messagePins.messageId, messageId))
        .returning({ messageId: messagePins.messageId });
      return { unpinned: deleted.length > 0 };
    },

    /**
     * A channel's whole pin board, newest-pinned first, in ONE join. Bounded by
     * `PINS_MAX_PER_CHANNEL`, so this is deliberately un-paginated — the cap IS
     * the page size (§27). The `deleted_at IS NULL` join condition means a
     * soft-deleted message silently drops off the board.
     */
    async listForChannel(channelId: ChannelId): Promise<PinnedMessage[]> {
      const rows = await db
        .select({ pin: messagePins, message: messages })
        .from(messagePins)
        .innerJoin(messages, eq(messages.id, messagePins.messageId))
        .where(and(eq(messagePins.channelId, channelId), isNull(messages.deletedAt)))
        .orderBy(desc(messagePins.pinnedAt))
        .limit(PINS_MAX_PER_CHANNEL);

      return rows.map((row) => ({
        message: toMessage(row.message),
        pinnedBy: row.pin.pinnedBy,
        pinnedAt: row.pin.pinnedAt.toISOString(),
      }));
    },

    /** How many messages are currently pinned in `channelId` (cap enforcement / UI hint). */
    async countForChannel(channelId: ChannelId): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messagePins)
        .where(eq(messagePins.channelId, channelId));
      return Number(row?.count ?? 0);
    },

    /**
     * Which of `messageIds` are pinned — ONE `WHERE id IN (…)` lookup backing the
     * page enrichment that sets `Message.pinned` (no N+1, mirroring
     * `messageReactions.summariesForMessages`). Returns a Set so the caller's
     * per-message check is O(1).
     */
    async pinnedIdsForMessages(messageIds: MessageId[]): Promise<Set<MessageId>> {
      const ids = [...new Set(messageIds)];
      if (ids.length === 0) return new Set();
      const rows = await db
        .select({ messageId: messagePins.messageId })
        .from(messagePins)
        .where(inArray(messagePins.messageId, ids));
      return new Set(rows.map((row) => row.messageId));
    },

    /**
     * Drop a message's pin. Called by the API on message SOFT delete, which does
     * not cascade (a hard delete does, via the FK) — the same explicit-reap shape
     * as `messageEmbeds.deleteForMessage` / the attachment purge.
     */
    async deleteForMessage(messageId: MessageId): Promise<boolean> {
      const deleted = await db
        .delete(messagePins)
        .where(eq(messagePins.messageId, messageId))
        .returning({ messageId: messagePins.messageId });
      return deleted.length > 0;
    },
  };
}

export type MessagePinsRepo = ReturnType<typeof messagePinsRepo>;
