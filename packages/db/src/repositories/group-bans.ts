import { and, desc, eq } from "drizzle-orm";
import type { GroupBan, GroupId, User, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toGroupBan, toUser } from "../mappers.js";
import { groupBans, users } from "../schema.js";

/** A ban row joined with the banned user (for the moderation ban list). */
export type GroupBanWithUser = GroupBan & { user: User };

/**
 * Server ban list (migration 0017). One row per (group, user) permanently
 * barring a user from a `kind='server'` group. Membership removal is the groups
 * repo's job; this repo only owns the durable ban record. The invite-redeem path
 * ({@link invitesRepo.redeem}) re-checks {@link isBanned} inside its own
 * transaction so a banned user cannot rejoin via any invite (§28).
 *
 * The API boundary enforces permission (owner ∨ KICK_MEMBERS), owner-immunity,
 * and server-kind — this layer only persists.
 */
export function groupBansRepo(db: Db) {
  return {
    /**
     * Ban a user (idempotent upsert on the composite PK): a re-ban refreshes the
     * moderator, reason, and timestamp rather than inserting a duplicate. Returns
     * the resulting ban row.
     */
    async ban(input: {
      groupId: GroupId;
      userId: UserId;
      bannedBy: UserId | null;
      reason?: string | null;
    }): Promise<GroupBan> {
      const [row] = await db
        .insert(groupBans)
        .values({
          groupId: input.groupId,
          userId: input.userId,
          bannedBy: input.bannedBy,
          reason: input.reason ?? null,
        })
        .onConflictDoUpdate({
          target: [groupBans.groupId, groupBans.userId],
          set: {
            bannedBy: input.bannedBy,
            reason: input.reason ?? null,
            createdAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("insert group_bans returned no row");
      return toGroupBan(row);
    },

    /** Lift a ban. Returns true when a row was removed (false if not banned). */
    async unban(groupId: GroupId, userId: UserId): Promise<boolean> {
      const rows = await db
        .delete(groupBans)
        .where(and(eq(groupBans.groupId, groupId), eq(groupBans.userId, userId)))
        .returning({ userId: groupBans.userId });
      return rows.length > 0;
    },

    /** Whether `userId` is currently banned from `groupId`. */
    async isBanned(groupId: GroupId, userId: UserId): Promise<boolean> {
      const [row] = await db
        .select({ userId: groupBans.userId })
        .from(groupBans)
        .where(and(eq(groupBans.groupId, groupId), eq(groupBans.userId, userId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * A server's bans, newest first, each joined with the banned user so the
     * moderation list renders names/avatars without N follow-up fetches. The
     * `bannedBy` moderator stays an id (the UI already has the roster).
     */
    async listForGroup(groupId: GroupId): Promise<GroupBanWithUser[]> {
      const rows = await db
        .select({ ban: groupBans, user: users })
        .from(groupBans)
        .innerJoin(users, eq(users.id, groupBans.userId))
        .where(eq(groupBans.groupId, groupId))
        .orderBy(desc(groupBans.createdAt));
      return rows.map((r) => ({ ...toGroupBan(r.ban), user: toUser(r.user) }));
    },
  };
}

export type GroupBansRepo = ReturnType<typeof groupBansRepo>;
