import { and, desc, eq, inArray } from "drizzle-orm";
import type { IgnoredUser, UserId, UserIgnore } from "@demli/types";
import type { Db } from "../client.js";
import { toIgnoredUser, toUserIgnore } from "../mappers.js";
import { userIgnores, users } from "../schema.js";

/**
 * One-directional, silent ignores (migration 0020, ADR 0019 §4).
 *
 * Compare this file to `user-blocks.ts` — the differences ARE the product:
 *
 *  - **No `existsBetween`.** A block asks "is there a row in EITHER direction",
 *    because a block must protect both parties. An ignore is one person's
 *    preference about their own attention, so it is only ever read in the
 *    ignorer's direction. A symmetric primitive here would silently make an
 *    ignore behave like a half-block.
 *  - **No "who ignores me".** There is no method, and no reverse index to make
 *    one cheap. That question is exactly what this feature exists to leave
 *    unanswerable — an ignore the other side can detect is just a rude block.
 *  - **No write-path guard anywhere.** Nothing calls this before a send. The
 *    ignored user's messages persist and deliver normally; only notification
 *    fan-out consults these rows.
 */
export function userIgnoresRepo(db: Db) {
  return {
    /**
     * Ignore `ignoredId` on behalf of `ignorerId`. IDEMPOTENT — a double-tap is
     * harmless. Returns null for a self-ignore (the DB CHECK is the backstop).
     */
    async ignore(ignorerId: UserId, ignoredId: UserId): Promise<UserIgnore | null> {
      if (ignorerId === ignoredId) return null;
      const [inserted] = await db
        .insert(userIgnores)
        .values({ ignorerId, ignoredId })
        .onConflictDoNothing({ target: [userIgnores.ignorerId, userIgnores.ignoredId] })
        .returning();
      if (inserted) return toUserIgnore(inserted);
      const [existing] = await db
        .select()
        .from(userIgnores)
        .where(
          and(eq(userIgnores.ignorerId, ignorerId), eq(userIgnores.ignoredId, ignoredId)),
        )
        .limit(1);
      return existing ? toUserIgnore(existing) : null;
    },

    /** Lift an ignore. True when a row was actually removed. */
    async unignore(ignorerId: UserId, ignoredId: UserId): Promise<boolean> {
      const rows = await db
        .delete(userIgnores)
        .where(
          and(eq(userIgnores.ignorerId, ignorerId), eq(userIgnores.ignoredId, ignoredId)),
        )
        .returning({ ignorerId: userIgnores.ignorerId });
      return rows.length > 0;
    },

    /** Everyone THIS user ignores, newest first, hydrated for the settings list. */
    async listIgnored(ignorerId: UserId): Promise<IgnoredUser[]> {
      const rows = await db
        .select({ ignore: userIgnores, user: users })
        .from(userIgnores)
        .innerJoin(users, eq(users.id, userIgnores.ignoredId))
        .where(eq(userIgnores.ignorerId, ignorerId))
        .orderBy(desc(userIgnores.createdAt));
      return rows.map((r) => toIgnoredUser(r.ignore, r.user));
    },

    /** True when `ignorerId` ignores `targetId`. One direction, always. */
    async isIgnoring(ignorerId: UserId, targetId: UserId): Promise<boolean> {
      if (ignorerId === targetId) return false;
      const [row] = await db
        .select({ ignorerId: userIgnores.ignorerId })
        .from(userIgnores)
        .where(and(eq(userIgnores.ignorerId, ignorerId), eq(userIgnores.ignoredId, targetId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * BATCH, and note the direction: given one AUTHOR and a candidate audience,
     * which of those candidates ignore that author?
     *
     * This is the shape the push fan-out needs — "drop the recipients who asked
     * not to hear from this person" — in ONE query, so a channel with fifty
     * members costs one round trip rather than fifty (§27). The block repo's
     * `relatedIds` answers a symmetric question; this one is deliberately keyed
     * the other way round, ignorer-side, and returns IGNORER ids.
     */
    async ignorersAmong(authorId: UserId, candidates: UserId[]): Promise<Set<UserId>> {
      const unique = [...new Set(candidates)].filter((id) => id !== authorId);
      if (unique.length === 0) return new Set();
      const rows = await db
        .select({ ignorerId: userIgnores.ignorerId })
        .from(userIgnores)
        .where(
          and(eq(userIgnores.ignoredId, authorId), inArray(userIgnores.ignorerId, unique)),
        );
      return new Set(rows.map((r) => r.ignorerId));
    },

    /**
     * The full set of users `ignorerId` ignores. Used by the client's initial
     * sync (`GET /users/me/ignores` hydrates; this is the id-only form for the
     * places that only need membership).
     */
    async ignoredIds(ignorerId: UserId): Promise<Set<UserId>> {
      const rows = await db
        .select({ ignoredId: userIgnores.ignoredId })
        .from(userIgnores)
        .where(eq(userIgnores.ignorerId, ignorerId));
      return new Set(rows.map((r) => r.ignoredId));
    },
  };
}

export type UserIgnoresRepo = ReturnType<typeof userIgnoresRepo>;
