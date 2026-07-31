import { and, desc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type { PresencePlatform, User, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toSession, toUser, type Session } from "../mappers.js";
import { sessions, users } from "../schema.js";

export interface CreateSessionInput {
  userId: UserId;
  tokenHash: string;
  expiresAt: Date;
  /**
   * Client-declared device label shown in the active-sessions list (M15-A).
   * Optional/back-compat: pre-M15 callers omit it and the row's column stays
   * null. The caller (auth module) validates/caps length before this point.
   */
  deviceName?: string | null;
  /** Client surface (M15-A). Optional; null when the client does not declare it. */
  platform?: PresencePlatform | null;
}

export function sessionsRepo(db: Db) {
  return {
    async create(input: CreateSessionInput): Promise<Session> {
      const [row] = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          // Explicit `?? null` so an omitted field is a real NULL, not undefined.
          deviceName: input.deviceName ?? null,
          platform: input.platform ?? null,
        })
        .returning();
      if (!row) throw new Error("insert sessions returned no row");
      return toSession(row);
    },

    /**
     * Resolve an unexpired session (and its user) from a token hash. Excludes
     * SOFT-DELETED users (M15): a frozen account's sessions are revoked at
     * delete, but this `deleted_at IS NULL` guard is defense-in-depth so a
     * deleted user can never authenticate even if a session row lingered.
     */
    async findActiveByTokenHash(
      tokenHash: string,
      now: Date = new Date(),
    ): Promise<{ session: Session; user: User } | null> {
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            gt(sessions.expiresAt, now),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      return row ? { session: toSession(row.session), user: toUser(row.user) } : null;
    },

    /**
     * Every ACTIVE (unexpired) session for a user, most-recently-active first
     * (M15-A). Expired rows are excluded — the list only shows sessions that can
     * still authenticate. The caller marks which row is "current".
     */
    async listForUser(userId: UserId, now: Date = new Date()): Promise<Session[]> {
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
        .orderBy(desc(sessions.lastSeenAt));
      return rows.map(toSession);
    },

    /**
     * Bump `last_seen_at` to now for one session (M15-A). Cheap single-row PK
     * update on the auth hot path; callers throttle how often they invoke it
     * (§27). Returns true when a row was touched (false ⇒ session already gone).
     */
    async touchLastSeen(sessionId: string, now: Date = new Date()): Promise<boolean> {
      const rows = await db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(eq(sessions.id, sessionId))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /**
     * Revoke ONE session the caller owns (M15-A "sign out this device"). Scoped
     * to `userId` so a user can never close another user's session by guessing an
     * id. Returns true only when a matching owned row was removed — a foreign or
     * unknown id removes nothing (the route answers 404). The token hash vanishes
     * with the row, so the next request bearing that token fails auth (401).
     */
    async revoke(sessionId: string, userId: UserId): Promise<boolean> {
      const rows = await db
        .delete(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /**
     * Revoke every OTHER session for a user, keeping `currentSessionId` alive
     * (M15-A "sign out everywhere else"). Returns how many were removed. Those
     * tokens stop authenticating immediately; the caller's own session survives.
     */
    async revokeOthers(userId: UserId, currentSessionId: string): Promise<number> {
      const rows = await db
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)))
        .returning({ id: sessions.id });
      return rows.length;
    },

    async deleteByTokenHash(tokenHash: string): Promise<boolean> {
      const rows = await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /**
     * Revoke every session for a user — "log out everywhere" and the hook a
     * future password-change path should call (security-review M2). Returns the
     * number of sessions removed.
     */
    async deleteAllForUser(userId: UserId): Promise<number> {
      const rows = await db
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      return rows.length;
    },

    /** Housekeeping — remove expired sessions. */
    async deleteExpired(now: Date = new Date()): Promise<number> {
      const rows = await db
        .delete(sessions)
        .where(lt(sessions.expiresAt, now))
        .returning({ id: sessions.id });
      return rows.length;
    },
  };
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>;
