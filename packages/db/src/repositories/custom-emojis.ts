import { and, asc, eq, sql } from "drizzle-orm";
import { CUSTOM_EMOJI_MAX_PER_GROUP } from "@demli/config";
import type { CustomEmoji, CustomEmojiId, GroupId, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { customEmojis } from "../schema.js";

type CustomEmojiRow = typeof customEmojis.$inferSelect;

/**
 * Row → client-facing {@link CustomEmoji}. `storagePath` is deliberately DROPPED:
 * the bucket key never leaves the API (clients render through short-lived signed
 * URLs), so it must not be reachable through a DTO (§28).
 */
function toCustomEmoji(row: CustomEmojiRow): CustomEmoji {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The full row INCLUDING `storagePath` — for API-internal use only (signing a
 * read URL, purging bytes on delete). Named so a call site that leaks it into a
 * response is obvious in review.
 */
export interface CustomEmojiRecord extends CustomEmoji {
  storagePath: string;
}

function toCustomEmojiRecord(row: CustomEmojiRow): CustomEmojiRecord {
  return { ...toCustomEmoji(row), storagePath: row.storagePath };
}

/** Why a {@link CustomEmojisRepo.create} was rejected, or `null` on success. */
export type CustomEmojiCreateError = "name_taken" | "at_capacity";

export interface CustomEmojiCreateResult {
  emoji: CustomEmojiRecord | null;
  error: CustomEmojiCreateError | null;
}

/**
 * Custom-emoji persistence (M17). Name-grammar validation, the MIME whitelist,
 * the byte cap and the magic-byte sniff all live at the API boundary (a client's
 * declared type is never trusted, §28); this layer persists, counts and reads.
 *
 * `name` arrives ALREADY LOWERCASED — the API's grammar rejects uppercase rather
 * than folding it — so the `(group_id, name)` unique index is a plain column
 * index and `:Cat:` can never land beside `:cat:`.
 */
export function customEmojisRepo(db: Db) {
  return {
    /**
     * Insert an emoji, enforcing the per-group cap ATOMICALLY.
     *
     * Count and insert share ONE transaction for the same reason pinning does:
     * they are a check-then-act pair, and two concurrent uploads that both counted
     * 63 would otherwise both insert. Returns a typed `error` instead of throwing
     * so the API can map each cause to its own status/message:
     *  - `at_capacity` → the group already holds `CUSTOM_EMOJI_MAX_PER_GROUP`;
     *  - `name_taken`  → the unique index rejected a duplicate `(group, name)`,
     *    caught here rather than pre-checked so a concurrent upload of the SAME
     *    name cannot slip between a check and an insert.
     */
    async create(input: {
      groupId: GroupId;
      name: string;
      mime: string;
      sizeBytes: number;
      storagePath: string;
      createdBy: UserId;
    }): Promise<CustomEmojiCreateResult> {
      return db.transaction(async (tx) => {
        const [counted] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(customEmojis)
          .where(eq(customEmojis.groupId, input.groupId));
        if (Number(counted?.count ?? 0) >= CUSTOM_EMOJI_MAX_PER_GROUP) {
          return { emoji: null, error: "at_capacity" as const };
        }

        // `onConflictDoNothing` on the (group, name) index turns a duplicate into
        // an empty result rather than a thrown constraint error, so the caller
        // gets a typed cause without inspecting driver error codes.
        const [inserted] = await tx
          .insert(customEmojis)
          .values({
            groupId: input.groupId,
            name: input.name,
            mime: input.mime,
            sizeBytes: input.sizeBytes,
            storagePath: input.storagePath,
            createdBy: input.createdBy,
          })
          .onConflictDoNothing({ target: [customEmojis.groupId, customEmojis.name] })
          .returning();

        if (!inserted) return { emoji: null, error: "name_taken" as const };
        return { emoji: toCustomEmojiRecord(inserted), error: null };
      });
    },

    /**
     * A group's emoji, alphabetical by name — the picker's tab order and the
     * lookup table clients build to resolve `:name:` in message content. Bounded
     * by `CUSTOM_EMOJI_MAX_PER_GROUP`, so it is deliberately un-paginated.
     * Metadata only (no storage paths, no URLs).
     */
    async listForGroup(groupId: GroupId): Promise<CustomEmoji[]> {
      const rows = await db
        .select()
        .from(customEmojis)
        .where(eq(customEmojis.groupId, groupId))
        .orderBy(asc(customEmojis.name))
        .limit(CUSTOM_EMOJI_MAX_PER_GROUP);
      return rows.map(toCustomEmoji);
    },

    /**
     * Full records (WITH storage paths) for a group — the URL-minting path needs
     * the bucket keys. Separate from {@link listForGroup} so the DTO-safe read
     * stays the default and reaching for paths is an explicit choice.
     */
    async listRecordsForGroup(groupId: GroupId): Promise<CustomEmojiRecord[]> {
      const rows = await db
        .select()
        .from(customEmojis)
        .where(eq(customEmojis.groupId, groupId))
        .orderBy(asc(customEmojis.name))
        .limit(CUSTOM_EMOJI_MAX_PER_GROUP);
      return rows.map(toCustomEmojiRecord);
    },

    /**
     * One emoji by id, SCOPED to a group. The `groupId` argument is not optional
     * on purpose: every call site already knows the group it authorized, and
     * requiring it here makes a cross-group read (fetch by id alone, then forget
     * to check the group) structurally impossible.
     */
    async findByIdInGroup(
      id: CustomEmojiId,
      groupId: GroupId,
    ): Promise<CustomEmojiRecord | null> {
      const [row] = await db
        .select()
        .from(customEmojis)
        .where(and(eq(customEmojis.id, id), eq(customEmojis.groupId, groupId)))
        .limit(1);
      return row ? toCustomEmojiRecord(row) : null;
    },

    /**
     * One emoji by NAME, scoped to a group — the reaction gate's resolver: a
     * `:name:` reaction is legal only when it names an emoji uploaded to the
     * message's group (§28, per-group scope). `name` is the lowercased shortcode
     * name (no colons); the `(group_id, name)` unique index makes this a point
     * read. Null when the group holds no such emoji (also the DM / flat-chat case
     * — those groups have no emoji rows, so every `:name:` reaction is rejected).
     * Metadata only (no storage path).
     */
    async findByNameInGroup(name: string, groupId: GroupId): Promise<CustomEmoji | null> {
      const [row] = await db
        .select()
        .from(customEmojis)
        .where(and(eq(customEmojis.groupId, groupId), eq(customEmojis.name, name)))
        .limit(1);
      return row ? toCustomEmoji(row) : null;
    },

    /** How many emoji the group holds (cap enforcement / "12 of 64" UI hint). */
    async countForGroup(groupId: GroupId): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(customEmojis)
        .where(eq(customEmojis.groupId, groupId));
      return Number(row?.count ?? 0);
    },

    /**
     * Delete one emoji, scoped to its group, returning the removed record so the
     * caller can purge its storage object. Null when it did not exist (or belonged
     * to another group) — idempotent, never an error.
     */
    async deleteInGroup(
      id: CustomEmojiId,
      groupId: GroupId,
    ): Promise<CustomEmojiRecord | null> {
      const [row] = await db
        .delete(customEmojis)
        .where(and(eq(customEmojis.id, id), eq(customEmojis.groupId, groupId)))
        .returning();
      return row ? toCustomEmojiRecord(row) : null;
    },
  };
}

export type CustomEmojisRepo = ReturnType<typeof customEmojisRepo>;
