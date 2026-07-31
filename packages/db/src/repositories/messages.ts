import { and, desc, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import { REPLY_PREVIEW_MAX } from "@demli/config";
import type {
  ChannelId,
  Message,
  MessageId,
  MessageKind,
  MessageReplyPreview,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toMessage } from "../mappers.js";
import {
  buildMessagesPage,
  decodeMessageCursor,
  type MessagesPage,
} from "../pagination.js";
import { messageReactions, messages } from "../schema.js";

export const MESSAGES_PAGE_MAX_LIMIT = 100;
export const MESSAGES_PAGE_DEFAULT_LIMIT = 50;

/** Message-search page sizing (ADR 0011 §5) — smaller than a channel read. */
export const MESSAGES_SEARCH_DEFAULT_LIMIT = 25;
export const MESSAGES_SEARCH_MAX_LIMIT = 50;

/**
 * Escape the LIKE/ILIKE metacharacters (`\`, `%`, `_`) so a user's query is
 * matched as a LITERAL substring, not a wildcard pattern. Postgres LIKE uses
 * backslash as the default escape char, so `\%` matches a literal `%`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function messagesRepo(db: Db) {
  return {
    /**
     * Insert a message. When a `nonce` is supplied the write is idempotent:
     * a retried send with the same (author, nonce) resolves to the ORIGINAL
     * row via the partial unique index `messages_author_nonce_unique`, so a
     * lost `message.created` echo can never create a duplicate row. Null-nonce
     * inserts (seed/server-originated) are never deduped.
     */
    async create(input: {
      channelId: ChannelId;
      authorId: UserId;
      content: string;
      /** "system" for server-generated notices (member joined/left). Default "user". */
      kind?: MessageKind;
      nonce?: string | null;
      /**
       * The message this replies to (ADR 0011 §2). Null/omitted for a normal
       * send. The caller (api/gateway) validates the target exists in the same
       * channel BEFORE calling; this layer only persists the FK. Set once, never
       * changed by `updateContent`.
       */
      replyToMessageId?: MessageId | null;
    }): Promise<Message> {
      const nonce = input.nonce ?? null;
      const kind = input.kind ?? "user";
      const replyToMessageId = input.replyToMessageId ?? null;

      if (nonce === null) {
        const [row] = await db
          .insert(messages)
          .values({
            channelId: input.channelId,
            authorId: input.authorId,
            content: input.content,
            kind,
            replyToMessageId,
          })
          .returning();
        if (!row) throw new Error("insert messages returned no row");
        return toMessage(row);
      }

      // Upsert on (author_id, nonce). The `where` predicate matches the partial
      // index so Postgres infers it as the conflict arbiter.
      const [inserted] = await db
        .insert(messages)
        .values({
          channelId: input.channelId,
          authorId: input.authorId,
          content: input.content,
          kind,
          nonce,
          replyToMessageId,
        })
        .onConflictDoNothing({
          target: [messages.authorId, messages.nonce],
          where: sql`${messages.nonce} is not null`,
        })
        .returning();
      if (inserted) return toMessage(inserted);

      // Conflict: this (author, nonce) already produced a message — return it,
      // so the caller broadcasts the same canonical message.created (idempotent).
      const [existing] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.authorId, input.authorId), eq(messages.nonce, nonce)))
        .limit(1);
      if (!existing) {
        throw new Error("nonce conflict but no existing message row found");
      }
      return toMessage(existing);
    },

    async findById(messageId: MessageId): Promise<Message | null> {
      const [row] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      return row ? toMessage(row) : null;
    },

    /**
     * Newest-first keyset pagination. `cursor` is the opaque value returned
     * as `nextCursor` by the previous page; an invalid cursor yields the
     * first page (treated as "no cursor") rather than an error page overlap.
     */
    async listPage(input: {
      channelId: ChannelId;
      limit?: number;
      cursor?: string | null;
      /**
       * Authors whose messages are HIDDEN from this reader (M18 blocking, ADR
       * 0013). Filtered in SQL — server-side, not client-side — so a blocked
       * user's content never leaves the server at all. Applied BEFORE the
       * `limit + 1` slice, so a page stays full and the keyset cursor stays
       * disjoint (no duplicates, §22): the excluded rows simply never enter the
       * window. Omitted/empty ⇒ the query is byte-for-byte the pre-M18 one.
       */
      excludeAuthorIds?: UserId[];
    }): Promise<MessagesPage<Message>> {
      const limit = Math.min(
        Math.max(input.limit ?? MESSAGES_PAGE_DEFAULT_LIMIT, 1),
        MESSAGES_PAGE_MAX_LIMIT,
      );
      const cursor = input.cursor ? decodeMessageCursor(input.cursor) : null;

      const conditions = [
        eq(messages.channelId, input.channelId),
        isNull(messages.deletedAt),
      ];
      const excluded = [...new Set(input.excludeAuthorIds ?? [])];
      if (excluded.length > 0) {
        conditions.push(not(inArray(messages.authorId, excluded)));
      }
      if (cursor) {
        // Strict row-tuple comparison keeps pages disjoint (no duplicates).
        conditions.push(
          sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      return buildMessagesPage(rows.map(toMessage), limit);
    },

    /**
     * Full-text message search within ONE channel (ADR 0011 §5). Newest-first,
     * keyset-paged on the SAME `(createdAt, id)` cursor as `listPage`, so pages
     * stay disjoint (no duplicates, CLAUDE.md §22) and a `before` cursor from one
     * search feeds the next.
     *
     * The match predicate is deterministic per query (fixed for the whole
     * pagination run): a row matches when the `simple`-config FTS vector matches
     * `websearch_to_tsquery` (whole-lexeme, GIN-indexed) OR its content contains
     * the query as a literal substring (ILIKE) — the substring arm catches the
     * short/partial tokens the tokenizer misses (e.g. a 3-char fragment inside a
     * longer word). `websearch_to_tsquery` never throws on arbitrary user input,
     * so no query sanitizing is needed beyond the API's length gate. Soft-deleted
     * messages are excluded (their content is blanked anyway).
     *
     * Authorization (channel visibility) is the caller's job — this layer only
     * runs the query for an already-authorized channel. `q` is expected trimmed
     * and non-empty (the API rejects < 3 chars with 400); a blank `q` yields an
     * empty page rather than a full-channel scan.
     */
    async search(
      channelId: ChannelId,
      q: string,
      options: {
        limit?: number;
        before?: string | null;
        /**
         * Authors excluded from the results (M18 blocking, ADR 0017) — a blocked
         * user's messages must not be findable by search either, and the filter
         * is in SQL so their content never leaves the server.
         */
        excludeAuthorIds?: UserId[];
      } = {},
    ): Promise<MessagesPage<Message>> {
      const query = q.trim();
      if (query.length === 0) return { items: [], nextCursor: null };

      const limit = Math.min(
        Math.max(options.limit ?? MESSAGES_SEARCH_DEFAULT_LIMIT, 1),
        MESSAGES_SEARCH_MAX_LIMIT,
      );
      const cursor = options.before ? decodeMessageCursor(options.before) : null;
      const likePattern = `%${escapeLike(query)}%`;

      const conditions = [
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        or(
          sql`${messages.searchVector} @@ websearch_to_tsquery('simple', ${query})`,
          sql`${messages.content} ilike ${likePattern}`,
        ),
      ];
      const excluded = [...new Set(options.excludeAuthorIds ?? [])];
      if (excluded.length > 0) {
        conditions.push(not(inArray(messages.authorId, excluded)));
      }
      if (cursor) {
        // Same strict row-tuple keyset as listPage — keeps pages disjoint.
        conditions.push(
          sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      return buildMessagesPage(rows.map(toMessage), limit);
    },

    /**
     * Batch-build reply previews for a page (ADR 0011 §2) — ONE `WHERE id IN (…)`
     * lookup, no N+1 (mirrors `attachments.listForMessages`). `targetIds` is the
     * distinct set of `replyToMessageId`s collected across the page. Lives HERE
     * (not `apps/api/lib`) so BOTH the API list/create path and the gateway's WS
     * `message.created` broadcast build the same preview from the one package
     * both processes import.
     *
     * A soft-deleted target is present with `deleted: true` and blank content
     * (renders the "Original message was deleted." stub). A hard-deleted target
     * is simply absent from the map — the self-FK went `SET NULL`, so the
     * replying row's `replyToMessageId` is already null and there is nothing to
     * preview (the caller reads `map.get(id) ?? null`).
     */
    async getReplyPreviews(
      targetIds: MessageId[],
    ): Promise<Map<MessageId, MessageReplyPreview>> {
      const previews = new Map<MessageId, MessageReplyPreview>();
      const ids = [...new Set(targetIds)];
      if (ids.length === 0) return previews;

      const rows = await db
        .select({
          id: messages.id,
          authorId: messages.authorId,
          content: messages.content,
          kind: messages.kind,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(inArray(messages.id, ids));

      for (const row of rows) {
        const deleted = row.deletedAt !== null;
        previews.set(row.id, {
          id: row.id,
          authorId: row.authorId,
          content: deleted ? "" : row.content.slice(0, REPLY_PREVIEW_MAX),
          kind: row.kind,
          deleted,
        });
      }
      return previews;
    },

    /** Edit content; only succeeds for the author of a non-deleted message. */
    async updateContent(
      messageId: MessageId,
      authorId: UserId,
      content: string,
    ): Promise<Message | null> {
      const [row] = await db
        .update(messages)
        .set({ content, updatedAt: new Date() })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.authorId, authorId),
            isNull(messages.deletedAt),
          ),
        )
        .returning();
      return row ? toMessage(row) : null;
    },

    /**
     * Soft delete — content is blanked, row kept for ordering integrity. Also
     * reaps the message's reactions (ADR 0011 §1): a deleted message shows no
     * reactions and reclaims the rows. Atomic — the blank+delete happen in one
     * transaction, and reactions are reaped only when this call is the one that
     * actually transitions the row (the `deleted_at IS NULL` guard makes a repeat
     * a no-op that returns null).
     */
    async softDelete(messageId: MessageId): Promise<Message | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(messages)
          .set({ content: "", deletedAt: new Date() })
          .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
          .returning();
        if (!row) return null;
        await tx
          .delete(messageReactions)
          .where(eq(messageReactions.messageId, messageId));
        return toMessage(row);
      });
    },
  };
}

export type MessagesRepo = ReturnType<typeof messagesRepo>;
