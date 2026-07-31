import { and, asc, eq } from "drizzle-orm";
import type { Group, GroupId, GroupMember, MemberRole, User, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toGroupChat, toMember, toUser } from "../mappers.js";
import { channels, friendGroupMembers, friendGroups, users } from "../schema.js";

export interface GroupChatDetails {
  group: Group;
  members: Array<GroupMember & { user: User }>;
}

/**
 * Query layer for flat "group" chats — `friend_groups` rows with
 * `kind === "group"` that each own exactly ONE hidden text channel. That
 * channel's id is the group's `streamId`, so a group reuses the whole
 * channel-scoped message + realtime pipeline unchanged (see ADR 0005).
 *
 * Server (multi-channel) spaces are handled by {@link groupsRepo} instead.
 *
 * `streamId` is resolved by joining the group's `kind='text'` channel
 * specifically, not "its one channel": a group upgraded from a DM call
 * (ADR 0012 §6) also owns a VOICE channel, so an unfiltered join would be
 * ambiguous. A group has exactly one text stream, so the filtered join stays
 * exact for both ordinary and upgraded groups.
 */
export function groupChatsRepo(db: Db) {
  return {
    /**
     * Create a flat group chat atomically: the `friend_groups` row
     * (`kind='group'`), the owner membership, and the single stream channel
     * (`kind='text'`, name `"stream"`, position 0). Returns the {@link Group}
     * projection with `streamId` set to the new channel's id.
     */
    async create(input: { name: string; ownerId: UserId }): Promise<Group> {
      return db.transaction(async (tx) => {
        const [groupRow] = await tx
          .insert(friendGroups)
          .values({ name: input.name, ownerId: input.ownerId, kind: "group" })
          .returning();
        if (!groupRow) throw new Error("insert friend_groups returned no row");

        await tx
          .insert(friendGroupMembers)
          .values({ groupId: groupRow.id, userId: input.ownerId, role: "owner" });

        const [channelRow] = await tx
          .insert(channels)
          .values({ groupId: groupRow.id, kind: "text", name: "stream", position: 0 })
          .returning();
        if (!channelRow) throw new Error("insert channels returned no row");

        return toGroupChat(groupRow, channelRow.id);
      });
    },

    /** A single group chat by id (null if it does not exist or is a server). */
    async findById(groupId: GroupId): Promise<Group | null> {
      const [row] = await db
        .select({ group: friendGroups, channel: channels })
        .from(friendGroups)
        .innerJoin(
          channels,
          and(eq(channels.groupId, friendGroups.id), eq(channels.kind, "text")),
        )
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.kind, "group")))
        .limit(1);
      return row ? toGroupChat(row.group, row.channel.id) : null;
    },

    /**
     * Every flat group chat the user is a member of, oldest first. Joins each
     * group's single channel to resolve `streamId`. Never returns servers.
     */
    async listForUser(userId: UserId): Promise<Group[]> {
      const rows = await db
        .select({ group: friendGroups, channel: channels })
        .from(friendGroupMembers)
        .innerJoin(
          friendGroups,
          and(
            eq(friendGroups.id, friendGroupMembers.groupId),
            eq(friendGroups.kind, "group"),
          ),
        )
        .innerJoin(
          channels,
          and(eq(channels.groupId, friendGroups.id), eq(channels.kind, "text")),
        )
        .where(eq(friendGroupMembers.userId, userId))
        .orderBy(asc(friendGroups.createdAt));
      return rows.map((r) => toGroupChat(r.group, r.channel.id));
    },

    /** The group plus its members (each joined to its user), or null. */
    async getDetails(groupId: GroupId): Promise<GroupChatDetails | null> {
      const [groupRow] = await db
        .select({ group: friendGroups, channel: channels })
        .from(friendGroups)
        .innerJoin(
          channels,
          and(eq(channels.groupId, friendGroups.id), eq(channels.kind, "text")),
        )
        .where(and(eq(friendGroups.id, groupId), eq(friendGroups.kind, "group")))
        .limit(1);
      if (!groupRow) return null;

      const memberRows = await db
        .select({ member: friendGroupMembers, user: users })
        .from(friendGroupMembers)
        .innerJoin(users, eq(users.id, friendGroupMembers.userId))
        .where(eq(friendGroupMembers.groupId, groupId))
        .orderBy(asc(friendGroupMembers.joinedAt));

      return {
        group: toGroupChat(groupRow.group, groupRow.channel.id),
        members: memberRows.map((r) => ({ ...toMember(r.member), user: toUser(r.user) })),
      };
    },

    /** Add a member to the group (default role `"member"`). */
    async addMember(
      groupId: GroupId,
      userId: UserId,
      role: MemberRole = "member",
    ): Promise<GroupMember> {
      const [row] = await db
        .insert(friendGroupMembers)
        .values({ groupId, userId, role })
        .returning();
      if (!row) throw new Error("insert friend_group_members returned no row");
      return toMember(row);
    },

    /** Remove a member; returns true when a membership row was deleted. */
    async removeMember(groupId: GroupId, userId: UserId): Promise<boolean> {
      const rows = await db
        .delete(friendGroupMembers)
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .returning({ userId: friendGroupMembers.userId });
      return rows.length > 0;
    },
  };
}

export type GroupChatsRepo = ReturnType<typeof groupChatsRepo>;
