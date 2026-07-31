import { asc, eq, inArray } from "drizzle-orm";
import type { MessageEmbed, MessageId } from "@demli/types";
import type { Db } from "../client.js";
import { messageEmbeds } from "../schema.js";

/**
 * The write shape for a link-preview card (M17): the client-facing
 * {@link MessageEmbed} WITHOUT `fetchedAt` — the column defaults to `now()` in
 * the database, so the repo assigns it and returns the stamped rows. `position`
 * is assigned from array order by {@link MessageEmbedsRepo.replaceForMessage}.
 */
export type MessageEmbedInput = Omit<MessageEmbed, "fetchedAt">;

type MessageEmbedRow = typeof messageEmbeds.$inferSelect;

/** Row → client-facing `MessageEmbed`. `position` is server-internal (ordering only). */
function toMessageEmbed(row: MessageEmbedRow): MessageEmbed {
  return {
    url: row.url,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    siteName: row.siteName,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

/**
 * Link-preview (unfurl) persistence (M17). The unfurl service builds the cards
 * out-of-band (SSRF-guarded fetch + OG parse — that logic lives in
 * `@demli/unfurl`, never here); this layer only persists and reads them back.
 * Cards are ordered by `position` (their URL's order in the message content) so
 * they render deterministically regardless of which fetch finished first.
 */
export function messageEmbedsRepo(db: Db) {
  return {
    /**
     * Replace ALL of a message's embeds with `embeds`, atomically, and return the
     * stored set (ordered by position, with DB-assigned `fetchedAt`). A "replace"
     * — not an append — so a re-unfurl (retried send resolves to the same message)
     * is idempotent and never accumulates stale/duplicate cards. Passing an empty
     * array clears the message's embeds. `position` is the array index.
     */
    async replaceForMessage(
      messageId: MessageId,
      embeds: MessageEmbedInput[],
    ): Promise<MessageEmbed[]> {
      return db.transaction(async (tx) => {
        await tx.delete(messageEmbeds).where(eq(messageEmbeds.messageId, messageId));
        if (embeds.length === 0) return [];

        await tx.insert(messageEmbeds).values(
          embeds.map((embed, position) => ({
            messageId,
            url: embed.url,
            title: embed.title,
            description: embed.description,
            imageUrl: embed.imageUrl,
            siteName: embed.siteName,
            position,
          })),
        );

        const rows = await tx
          .select()
          .from(messageEmbeds)
          .where(eq(messageEmbeds.messageId, messageId))
          .orderBy(asc(messageEmbeds.position), asc(messageEmbeds.id));
        return rows.map(toMessageEmbed);
      });
    },

    /** A single message's embeds, in stable content order. */
    async listForMessage(messageId: MessageId): Promise<MessageEmbed[]> {
      const rows = await db
        .select()
        .from(messageEmbeds)
        .where(eq(messageEmbeds.messageId, messageId))
        .orderBy(asc(messageEmbeds.position), asc(messageEmbeds.id));
      return rows.map(toMessageEmbed);
    },

    /**
     * Bulk fetch for a page of messages — ONE query, grouped by message id (no
     * N+1, mirroring `attachments.listForMessages`). Messages with no embeds are
     * absent from the map; the caller reads `map.get(id) ?? []`.
     */
    async listForMessages(
      messageIds: MessageId[],
    ): Promise<Map<MessageId, MessageEmbed[]>> {
      const grouped = new Map<MessageId, MessageEmbed[]>();
      const ids = [...new Set(messageIds)];
      if (ids.length === 0) return grouped;

      const rows = await db
        .select()
        .from(messageEmbeds)
        .where(inArray(messageEmbeds.messageId, ids))
        .orderBy(asc(messageEmbeds.position), asc(messageEmbeds.id));

      for (const row of rows) {
        const key = row.messageId;
        const bucket = grouped.get(key);
        if (bucket) bucket.push(toMessageEmbed(row));
        else grouped.set(key, [toMessageEmbed(row)]);
      }
      return grouped;
    },

    /**
     * Delete a message's embeds and return how many were removed. Used by the API
     * on message soft-delete (soft-delete does not cascade the rows), mirroring the
     * attachment reap. Hard delete cascades via the FK, so this is the soft path.
     */
    async deleteForMessage(messageId: MessageId): Promise<number> {
      const rows = await db
        .delete(messageEmbeds)
        .where(eq(messageEmbeds.messageId, messageId))
        .returning({ id: messageEmbeds.id });
      return rows.length;
    },
  };
}

export type MessageEmbedsRepo = ReturnType<typeof messageEmbedsRepo>;
