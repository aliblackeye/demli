import { and, desc, eq } from "drizzle-orm";
import type { UserNickname, UserNicknameEntry, UserNote, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toUserNickname, toUserNicknameEntry, toUserNote } from "../mappers.js";
import { userNicknames, userNotes, users } from "../schema.js";

/**
 * Private per-viewer annotations (migration 0020, ADR 0019 §1–2): the note one
 * user keeps about another, and the private nickname one user gives another.
 *
 * **Every method here takes `viewerId` FIRST and filters on it.** There is
 * deliberately no `listForTarget`, no `findByTarget`, and no method that answers
 * "what has been written about this person" — the absence is the feature. A
 * caller cannot accidentally read someone else's note, because no method here
 * will return one.
 *
 * Clearing DELETES the row rather than writing an empty string, so "no note" and
 * "no nickname" each have exactly one representation and a `null` return is
 * unambiguous.
 */
export function userNotesRepo(db: Db) {
  return {
    /**
     * The viewer's note about `targetId`, or null.
     *
     * The ONLY read path for a note in the entire codebase. If a second one ever
     * appears, that is the moment to re-read ADR 0019 §1 — the privacy guarantee
     * is "one reader", not "usually one reader".
     */
    async getNote(viewerId: UserId, targetId: UserId): Promise<UserNote | null> {
      if (viewerId === targetId) return null;
      const [row] = await db
        .select()
        .from(userNotes)
        .where(and(eq(userNotes.viewerId, viewerId), eq(userNotes.targetId, targetId)))
        .limit(1);
      return row ? toUserNote(row) : null;
    },

    /**
     * Write (or overwrite) the viewer's note. Upsert on the composite PK, so
     * saving twice edits rather than erroring. Returns null for a self-note (the
     * DB CHECK is the backstop; returning null lets the API answer 400 without
     * catching a constraint violation).
     */
    async setNote(viewerId: UserId, targetId: UserId, body: string): Promise<UserNote | null> {
      if (viewerId === targetId) return null;
      const now = new Date();
      const [row] = await db
        .insert(userNotes)
        .values({ viewerId, targetId, body, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [userNotes.viewerId, userNotes.targetId],
          set: { body, updatedAt: now },
        })
        .returning();
      return row ? toUserNote(row) : null;
    },

    /** Delete the viewer's note. True when a row was actually removed. */
    async clearNote(viewerId: UserId, targetId: UserId): Promise<boolean> {
      const rows = await db
        .delete(userNotes)
        .where(and(eq(userNotes.viewerId, viewerId), eq(userNotes.targetId, targetId)))
        .returning({ viewerId: userNotes.viewerId });
      return rows.length > 0;
    },

    /** The viewer's private nickname for `targetId`, or null. */
    async getNickname(viewerId: UserId, targetId: UserId): Promise<UserNickname | null> {
      if (viewerId === targetId) return null;
      const [row] = await db
        .select()
        .from(userNicknames)
        .where(
          and(eq(userNicknames.viewerId, viewerId), eq(userNicknames.targetId, targetId)),
        )
        .limit(1);
      return row ? toUserNickname(row) : null;
    },

    /** Write (or overwrite) the viewer's private nickname for `targetId`. */
    async setNickname(
      viewerId: UserId,
      targetId: UserId,
      nickname: string,
    ): Promise<UserNickname | null> {
      if (viewerId === targetId) return null;
      const now = new Date();
      const [row] = await db
        .insert(userNicknames)
        .values({ viewerId, targetId, nickname, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [userNicknames.viewerId, userNicknames.targetId],
          set: { nickname, updatedAt: now },
        })
        .returning();
      return row ? toUserNickname(row) : null;
    },

    /** Delete the viewer's private nickname. True when a row was removed. */
    async clearNickname(viewerId: UserId, targetId: UserId): Promise<boolean> {
      const rows = await db
        .delete(userNicknames)
        .where(
          and(eq(userNicknames.viewerId, viewerId), eq(userNicknames.targetId, targetId)),
        )
        .returning({ viewerId: userNicknames.viewerId });
      return rows.length > 0;
    },

    /**
     * EVERY private nickname this viewer has set, hydrated with the renamed user.
     *
     * The client caches this once at startup and applies it locally, which is why
     * no other endpoint has to join `user_nicknames`: name resolution stays a
     * pure client-side lookup (personal → server → displayName) instead of a join
     * bolted onto every roster, message page and DM list. A friend-group app's
     * list is small; if it ever is not, this gains a cursor like every other list.
     */
    async listNicknames(viewerId: UserId): Promise<UserNicknameEntry[]> {
      const rows = await db
        .select({ nick: userNicknames, user: users })
        .from(userNicknames)
        .innerJoin(users, eq(users.id, userNicknames.targetId))
        .where(eq(userNicknames.viewerId, viewerId))
        .orderBy(desc(userNicknames.updatedAt));
      return rows.map((r) => toUserNicknameEntry(r.nick, r.user));
    },
  };
}

export type UserNotesRepo = ReturnType<typeof userNotesRepo>;
