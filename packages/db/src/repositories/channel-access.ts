import { and, asc, eq, exists, notExists, or, sql } from "drizzle-orm";
import type { ChannelId, ChannelRoleAccess, GroupId, RoleId, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toChannelRoleAccess } from "../mappers.js";
import { channelRoleAccess, channels, friendGroupMembers, memberRoles } from "../schema.js";

/**
 * Channel visibility (ADR 0007). A channel with no `channel_role_access` rows is
 * public to all members (the pre-M9 default). One or more rows restrict it to
 * the owner and members holding at least one listed role. The composite FKs keep
 * every row's channel and role inside the same group.
 */
export function channelAccessRepo(db: Db) {
  return {
    /** Raw access rows for a channel ([] = public). */
    async listForChannel(channelId: ChannelId): Promise<ChannelRoleAccess[]> {
      const rows = await db
        .select()
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.channelId, channelId));
      return rows.map(toChannelRoleAccess);
    },

    /** Just the role ids that can see a channel ([] = public). */
    async roleIdsForChannel(channelId: ChannelId): Promise<RoleId[]> {
      const rows = await db
        .select({ roleId: channelRoleAccess.roleId })
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.channelId, channelId));
      return rows.map((r) => r.roleId);
    },

    /** True when a channel has at least one access row (i.e. is restricted). */
    async isRestricted(channelId: ChannelId): Promise<boolean> {
      const [row] = await db
        .select({ one: sql`1` })
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.channelId, channelId))
        .limit(1);
      return row !== undefined;
    },

    /** Ids of every restricted channel in a group (for the `restricted` flag). */
    async restrictedChannelIds(groupId: GroupId): Promise<ChannelId[]> {
      const rows = await db
        .selectDistinct({ channelId: channelRoleAccess.channelId })
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.groupId, groupId));
      return rows.map((r) => r.channelId);
    },

    /**
     * Replace a channel's access list (the PUT semantics of `/channels/:id/
     * access`). `roleIds = []` clears every row = makes the channel public.
     * Invalid channel/role ids fail the composite FK and roll back. `groupId`
     * must be the channel's own group; it is stored on each row so the FK can
     * verify role and channel share it.
     */
    async setChannelRoles(
      groupId: GroupId,
      channelId: ChannelId,
      roleIds: RoleId[],
    ): Promise<ChannelRoleAccess[]> {
      return db.transaction(async (tx) => {
        await tx
          .delete(channelRoleAccess)
          .where(eq(channelRoleAccess.channelId, channelId));
        if (roleIds.length === 0) return [];
        const rows = await tx
          .insert(channelRoleAccess)
          .values(roleIds.map((roleId) => ({ channelId, roleId, groupId })))
          .returning();
        return rows.map(toChannelRoleAccess);
      });
    },

    /**
     * Channel ids in `groupId` the user may see, in display order. The single
     * source of truth for both the WS subscription set and every channel-scoped
     * HTTP read. Rules:
     * - non-members see nothing;
     * - the owner sees every channel;
     * - members see all public channels plus restricted channels matching one of
     *   their roles.
     */
    async visibleChannelIdsForUser(
      groupId: GroupId,
      userId: UserId,
    ): Promise<ChannelId[]> {
      const isMember = db
        .select({ one: sql`1` })
        .from(friendGroupMembers)
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        );

      const isOwner = db
        .select({ one: sql`1` })
        .from(friendGroupMembers)
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
            eq(friendGroupMembers.role, "owner"),
          ),
        );

      // Correlated on the outer `channels` row.
      const channelHasAccessRows = db
        .select({ one: sql`1` })
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.channelId, channels.id));

      const userRoleMatchesChannel = db
        .select({ one: sql`1` })
        .from(channelRoleAccess)
        .innerJoin(
          memberRoles,
          and(
            eq(memberRoles.roleId, channelRoleAccess.roleId),
            eq(memberRoles.groupId, channels.groupId),
          ),
        )
        .where(
          and(
            eq(channelRoleAccess.channelId, channels.id),
            eq(memberRoles.userId, userId),
          ),
        );

      const rows = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.groupId, groupId),
            exists(isMember),
            or(
              exists(isOwner),
              notExists(channelHasAccessRows),
              exists(userRoleMatchesChannel),
            ),
          ),
        )
        .orderBy(asc(channels.position), asc(channels.createdAt));
      return rows.map((r) => r.id);
    },

    /**
     * Convenience visibility check for one channel — the HTTP guard primitive.
     * Cheaper to reason about than filtering the full list at each call site.
     */
    async canUserSeeChannel(
      groupId: GroupId,
      channelId: ChannelId,
      userId: UserId,
    ): Promise<boolean> {
      const visible = await this.visibleChannelIdsForUser(groupId, userId);
      return visible.includes(channelId);
    },

    /**
     * Every member of `groupId` who may SEE `channelId` — the exact INVERSE of
     * {@link visibleChannelIdsForUser} (iterate members for one channel instead
     * of channels for one member), sharing the same three-way rule so the two can
     * never drift:
     * - the owner sees every channel;
     * - a channel with no `channel_role_access` rows is public to all members;
     * - otherwise a member must hold at least one granting role.
     *
     * Single distinct query. This is the fan-out primitive for the "all messages"
     * offline push (#94): a member who cannot see a restricted channel is never
     * returned, so a push can never leak a restricted channel's traffic to them
     * (ADR 0007, §28). Callers exclude the author themselves (never notify
     * yourself), mirroring the mention resolver.
     */
    async recipientIdsForChannel(
      groupId: GroupId,
      channelId: ChannelId,
    ): Promise<UserId[]> {
      // Constant subquery (channelId is fixed): is the channel restricted at all?
      const channelHasAccessRows = db
        .select({ one: sql`1` })
        .from(channelRoleAccess)
        .where(eq(channelRoleAccess.channelId, channelId));

      // Correlated on the outer member row: does this member hold a role that
      // grants the channel?
      const memberRoleMatchesChannel = db
        .select({ one: sql`1` })
        .from(channelRoleAccess)
        .innerJoin(
          memberRoles,
          and(
            eq(memberRoles.roleId, channelRoleAccess.roleId),
            eq(memberRoles.groupId, groupId),
          ),
        )
        .where(
          and(
            eq(channelRoleAccess.channelId, channelId),
            eq(memberRoles.userId, friendGroupMembers.userId),
          ),
        );

      const rows = await db
        .selectDistinct({ userId: friendGroupMembers.userId })
        .from(friendGroupMembers)
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            or(
              eq(friendGroupMembers.role, "owner"),
              notExists(channelHasAccessRows),
              exists(memberRoleMatchesChannel),
            ),
          ),
        );
      return rows.map((r) => r.userId);
    },
  };
}

export type ChannelAccessRepo = ReturnType<typeof channelAccessRepo>;
