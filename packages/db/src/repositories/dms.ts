import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Dm, GroupId, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toDm, toUser } from "../mappers.js";
import { channels, friendGroupMembers, friendGroups, users } from "../schema.js";

/** Canonical DM key — `least(a,b):greatest(a,b)`, one value per unordered pair. */
function dmKeyFor(x: UserId, y: UserId): string {
  const [a, b] = x < y ? [x, y] : [y, x];
  return `${a}:${b}`;
}

function isDmKeyCollision(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505" &&
    (err as { constraint_name?: string }).constraint_name === "friend_groups_dm_key_unique"
  );
}

/**
 * DM query layer (ADR 0010 §1). A DM is a `friend_groups` row with `kind='dm'`,
 * exactly two members, owning exactly one hidden text channel (its stream) — so
 * it reuses the whole channel-scoped message pipeline unchanged, mirroring
 * {@link groupChatsRepo}. Uniqueness ("one DM per pair") is enforced by the
 * `dm_key` partial unique index; "close" is per-member `hidden_at`, never a
 * delete, so a counterpart's copy and the full history always survive.
 */
export function dmsRepo(db: Db) {
  return {
    /**
     * Idempotently resolve the DM between `callerId` and `otherId`, creating it
     * (row + 2 members + 1 stream channel, one transaction) only if absent.
     * `dm.participant` is always the OTHER user relative to the caller. Races
     * lose gracefully: a concurrent create surfaces the winner's row.
     */
    async getOrCreate(
      callerId: UserId,
      otherId: UserId,
    ): Promise<{ dm: Dm; created: boolean }> {
      if (callerId === otherId) throw new Error("cannot create a DM with yourself");

      const existing = await this.findByPair(callerId, otherId);
      if (existing) return { dm: existing, created: false };

      const [otherUserRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, otherId))
        .limit(1);
      if (!otherUserRow) throw new Error("cannot create a DM with a nonexistent user");

      const key = dmKeyFor(callerId, otherId);
      try {
        const dm = await db.transaction(async (tx) => {
          const [groupRow] = await tx
            .insert(friendGroups)
            .values({ name: "dm", ownerId: callerId, kind: "dm", dmKey: key })
            .returning();
          if (!groupRow) throw new Error("insert friend_groups (dm) returned no row");

          await tx.insert(friendGroupMembers).values([
            { groupId: groupRow.id, userId: callerId, role: "member" },
            { groupId: groupRow.id, userId: otherId, role: "member" },
          ]);

          const [channelRow] = await tx
            .insert(channels)
            .values({ groupId: groupRow.id, kind: "text", name: "stream", position: 0 })
            .returning();
          if (!channelRow) throw new Error("insert channels (dm stream) returned no row");

          return toDm(groupRow, channelRow.id, toUser(otherUserRow));
        });
        return { dm, created: true };
      } catch (err) {
        if (isDmKeyCollision(err)) {
          const raced = await this.findByPair(callerId, otherId);
          if (raced) return { dm: raced, created: false };
        }
        throw err;
      }
    },

    /** The DM for a pair (participant relative to `callerId`), or null. */
    async findByPair(callerId: UserId, otherId: UserId): Promise<Dm | null> {
      const [row] = await db
        .select({ group: friendGroups, channel: channels })
        .from(friendGroups)
        .innerJoin(channels, eq(channels.groupId, friendGroups.id))
        .where(and(eq(friendGroups.dmKey, dmKeyFor(callerId, otherId)), eq(friendGroups.kind, "dm")))
        .limit(1);
      if (!row) return null;
      const [otherUserRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, otherId))
        .limit(1);
      if (!otherUserRow) return null;
      return toDm(row.group, row.channel.id, toUser(otherUserRow));
    },

    /**
     * A DM by id, with `participant` resolved as the member that is NOT
     * `viewerId`. Returns null when the DM does not exist, is not a DM, or the
     * viewer is not one of its two members (the `self` join gates access).
     */
    async findById(dmId: GroupId, viewerId: UserId): Promise<Dm | null> {
      const self = alias(friendGroupMembers, "self");
      const other = alias(friendGroupMembers, "other");
      const [row] = await db
        .select({ group: friendGroups, channel: channels, otherUser: users })
        .from(friendGroups)
        .innerJoin(channels, eq(channels.groupId, friendGroups.id))
        .innerJoin(self, and(eq(self.groupId, friendGroups.id), eq(self.userId, viewerId)))
        .innerJoin(other, and(eq(other.groupId, friendGroups.id), ne(other.userId, viewerId)))
        .innerJoin(users, eq(users.id, other.userId))
        .where(and(eq(friendGroups.id, dmId), eq(friendGroups.kind, "dm")))
        .limit(1);
      return row ? toDm(row.group, row.channel.id, toUser(row.otherUser)) : null;
    },

    /**
     * Every DM the user has open (`hidden_at IS NULL`), newest first, each with
     * the other participant resolved. A hidden DM is absent here but untouched
     * for the counterpart.
     */
    async listForUser(userId: UserId): Promise<Dm[]> {
      const self = alias(friendGroupMembers, "self");
      const other = alias(friendGroupMembers, "other");
      const rows = await db
        .select({ group: friendGroups, channel: channels, otherUser: users })
        .from(self)
        .innerJoin(
          friendGroups,
          and(eq(friendGroups.id, self.groupId), eq(friendGroups.kind, "dm")),
        )
        .innerJoin(channels, eq(channels.groupId, friendGroups.id))
        .innerJoin(other, and(eq(other.groupId, friendGroups.id), ne(other.userId, userId)))
        .innerJoin(users, eq(users.id, other.userId))
        .where(and(eq(self.userId, userId), isNull(self.hiddenAt)))
        .orderBy(desc(friendGroups.createdAt));
      return rows.map((r) => toDm(r.group, r.channel.id, toUser(r.otherUser)));
    },

    /**
     * Close a DM for one side (hide-for-self): sets that member's `hidden_at`.
     * The counterpart's row is untouched. Returns true when a row changed.
     */
    async hide(dmId: GroupId, userId: UserId): Promise<boolean> {
      const rows = await db
        .update(friendGroupMembers)
        .set({ hiddenAt: new Date() })
        .where(and(eq(friendGroupMembers.groupId, dmId), eq(friendGroupMembers.userId, userId)))
        .returning({ userId: friendGroupMembers.userId });
      return rows.length > 0;
    },

    /** Re-open a hidden DM (clears `hidden_at`) — on re-open or new inbound. */
    async unhide(dmId: GroupId, userId: UserId): Promise<boolean> {
      const rows = await db
        .update(friendGroupMembers)
        .set({ hiddenAt: null })
        .where(and(eq(friendGroupMembers.groupId, dmId), eq(friendGroupMembers.userId, userId)))
        .returning({ userId: friendGroupMembers.userId });
      return rows.length > 0;
    },
  };
}

export type DmsRepo = ReturnType<typeof dmsRepo>;
