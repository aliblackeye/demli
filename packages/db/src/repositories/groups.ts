import { and, asc, eq, isNull } from "drizzle-orm";
import type {
  Channel,
  FriendGroup,
  FriendGroupKind,
  FriendGroupMember,
  GroupId,
  InvitePolicy,
  MemberRole,
  User,
  UserId,
} from "@demli/types";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import { toChannel, toGroup, toMember, toUser } from "../mappers.js";
import { channels, friendGroupMembers, friendGroups, users } from "../schema.js";

export interface GroupDetails {
  group: FriendGroup;
  channels: Channel[];
  members: Array<FriendGroupMember & { user: User }>;
}

/**
 * Fallback names for the two channels a brand-new SERVER is born with, used only
 * when the creating client sends none.
 *
 * Channel names are stored as plain text and can never be re-translated, so the
 * localized name has to be decided once, at creation, by whoever knows the
 * user's language — the client. These constants are the safety net for clients
 * that do not send them (every already-shipped desktop/mobile build, scripts,
 * future bots). They are English because `DEFAULT_LOCALE` is `"en"`
 * (`packages/i18n/src/config.ts`) and the seed uses the same two names; a
 * server-side fallback must not guess a language. Both are renameable in the UI.
 */
export const DEFAULT_SERVER_TEXT_CHANNEL_NAME = "general";
export const DEFAULT_SERVER_VOICE_CHANNEL_NAME = "Lobby";

/** A new server plus the default channels provisioned with it, in sidebar order. */
export interface CreatedServer {
  group: FriendGroup;
  channels: Channel[];
}

export function groupsRepo(db: Db) {
  return {
    /**
     * Creates the group and its owner membership atomically — and NOTHING else.
     * `kind` defaults to `"server"` (the multi-channel space). Flat "group" chats
     * are created via {@link groupChatsRepo}, which also provisions the single
     * stream channel.
     *
     * User-facing server creation goes through
     * {@link createServerWithDefaults} instead, which additionally provisions the
     * starter text + voice channels. This one stays bare so fixtures, the seed,
     * and callers that build their own channel layout are unaffected.
     */
    async create(input: {
      name: string;
      ownerId: UserId;
      kind?: FriendGroupKind;
    }): Promise<FriendGroup> {
      return db.transaction(async (tx) => {
        const [groupRow] = await tx
          .insert(friendGroups)
          .values({
            name: input.name,
            ownerId: input.ownerId,
            kind: input.kind ?? "server",
          })
          .returning();
        if (!groupRow) throw new Error("insert friend_groups returned no row");
        await tx
          .insert(friendGroupMembers)
          .values({ groupId: groupRow.id, userId: input.ownerId, role: "owner" });
        return toGroup(groupRow);
      });
    },

    /**
     * Create a SERVER that is not born empty: the `friend_groups` row, the owner
     * membership, one text channel (position 0) and one voice channel
     * (position 1), all in ONE transaction. A half-provisioned server — group row
     * without channels — is therefore impossible; any failure rolls the whole
     * thing back and the group never existed.
     *
     * Kind is hardcoded to `"server"` and NOT a parameter. That is the gate: flat
     * group chats ({@link groupChatsRepo.create}) and DMs ({@link dmsRepo}) own
     * exactly one hidden `"stream"` text channel and would break if a second
     * text channel or a voice channel appeared beside it (their `streamId` join
     * assumes one text channel). Those paths cannot reach this method at all.
     *
     * Channel names are caller-supplied because they are stored as untranslatable
     * plain text — see {@link DEFAULT_SERVER_TEXT_CHANNEL_NAME} for the fallback
     * rationale. Both channels are uncategorized (`category_id` NULL, M18), which
     * renders them in the top-level list exactly like every pre-M18 channel.
     *
     * The text channel also becomes the server's `system_channel_id`, matching
     * the invariant {@link channelsRepo.create} maintains ("a server's FIRST text
     * channel receives member joined/left notices") — set here inside the same
     * transaction so the server is complete the moment it is visible.
     */
    async createServerWithDefaults(input: {
      name: string;
      ownerId: UserId;
      /** Localized starter text-channel name; falls back to the English default. */
      textChannelName?: string;
      /** Localized starter voice-channel name; falls back to the English default. */
      voiceChannelName?: string;
    }): Promise<CreatedServer> {
      const textName = input.textChannelName ?? DEFAULT_SERVER_TEXT_CHANNEL_NAME;
      const voiceName = input.voiceChannelName ?? DEFAULT_SERVER_VOICE_CHANNEL_NAME;

      return db.transaction(async (tx) => {
        const [groupRow] = await tx
          .insert(friendGroups)
          .values({ name: input.name, ownerId: input.ownerId, kind: "server" })
          .returning();
        if (!groupRow) throw new Error("insert friend_groups returned no row");

        await tx
          .insert(friendGroupMembers)
          .values({ groupId: groupRow.id, userId: input.ownerId, role: "owner" });

        // Text first (position 0) so the sidebar opens on it; voice below it.
        const [textRow] = await tx
          .insert(channels)
          .values({
            groupId: groupRow.id,
            kind: "text",
            name: textName,
            position: 0,
            categoryId: null,
          })
          .returning();
        if (!textRow) throw new Error("insert channels returned no row");

        const [voiceRow] = await tx
          .insert(channels)
          .values({
            groupId: groupRow.id,
            kind: "voice",
            name: voiceName,
            position: 1,
            categoryId: null,
          })
          .returning();
        if (!voiceRow) throw new Error("insert channels returned no row");

        // First text channel = system channel (same rule as channelsRepo.create).
        const [withSystemChannel] = await tx
          .update(friendGroups)
          .set({ systemChannelId: textRow.id })
          .where(eq(friendGroups.id, groupRow.id))
          .returning();

        return {
          group: toGroup(withSystemChannel ?? groupRow),
          channels: [toChannel(textRow), toChannel(voiceRow)],
        };
      });
    },

    async findById(groupId: GroupId): Promise<FriendGroup | null> {
      const [row] = await db
        .select()
        .from(friendGroups)
        .where(eq(friendGroups.id, groupId))
        .limit(1);
      return row ? toGroup(row) : null;
    },

    /**
     * Groups the user belongs to, filtered by `kind` (default `"server"` — the
     * back-compatible behavior: `/groups` is server-only). Flat group chats are
     * listed via {@link groupChatsRepo.listForUser}.
     */
    async listForUser(
      userId: UserId,
      kind: FriendGroupKind = "server",
    ): Promise<FriendGroup[]> {
      const rows = await db
        .select({ group: friendGroups })
        .from(friendGroupMembers)
        .innerJoin(
          friendGroups,
          and(
            eq(friendGroups.id, friendGroupMembers.groupId),
            eq(friendGroups.kind, kind),
          ),
        )
        .where(eq(friendGroupMembers.userId, userId))
        .orderBy(asc(friendGroups.createdAt));
      return rows.map((r) => toGroup(r.group));
    },

    /**
     * Every `friend_groups` id the user is a member of, regardless of `kind` —
     * servers, flat group chats AND dms.
     *
     * Deliberately NOT {@link listForUser}: that one defaults to `kind="server"`
     * because `/groups` is server-only. This is the MEMBERSHIP truth, which is
     * what the realtime gateway needs to index a connection for group-scoped
     * fan-out: the API publishes `member.left` / `group.deleted` / `emoji.*`
     * with a group-chat (and, for emoji, dm) id, and a server-only index made
     * the gateway silently drop them — a kicked member kept receiving messages
     * because their subscription was never torn down.
     *
     * Ids only, no join: a membership row cannot outlive its group (FK cascade),
     * so the group table adds nothing here.
     */
    async listMemberGroupIds(userId: UserId): Promise<GroupId[]> {
      const rows = await db
        .select({ groupId: friendGroupMembers.groupId })
        .from(friendGroupMembers)
        .where(eq(friendGroupMembers.userId, userId));
      return rows.map((r) => r.groupId);
    },

    async getMembership(
      groupId: GroupId,
      userId: UserId,
    ): Promise<FriendGroupMember | null> {
      const [row] = await db
        .select()
        .from(friendGroupMembers)
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .limit(1);
      return row ? toMember(row) : null;
    },

    async addMember(
      groupId: GroupId,
      userId: UserId,
      role: MemberRole,
    ): Promise<FriendGroupMember> {
      const [row] = await db
        .insert(friendGroupMembers)
        .values({ groupId, userId, role })
        .returning();
      if (!row) throw new Error("insert friend_group_members returned no row");
      return toMember(row);
    },

    /** Remove a membership; returns true when a row was deleted. */
    /**
     * Set (or clear, with `null`) a member's PER-SERVER nickname — the public one
     * everyone in the server sees (migration 0020, ADR 0019 §3). Returns the
     * updated member, or null when there is no such membership.
     */
    async setMemberNickname(
      groupId: GroupId,
      userId: UserId,
      nickname: string | null,
    ): Promise<FriendGroupMember | null> {
      const [row] = await db
        .update(friendGroupMembers)
        .set({ nickname })
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .returning();
      return row ? toMember(row) : null;
    },

    /**
     * Set (or lift, with `null`) a member's timeout expiry (migration 0020).
     *
     * Takes an absolute instant rather than a duration on purpose: the API turns
     * the moderator's "30 minutes" into `now + 30m` using the SERVER clock, so a
     * client with a skewed clock cannot lengthen or shorten a mute. Returns the
     * updated member, or null when there is no such membership.
     */
    async setMemberTimeout(
      groupId: GroupId,
      userId: UserId,
      timedOutUntil: Date | null,
    ): Promise<FriendGroupMember | null> {
      const [row] = await db
        .update(friendGroupMembers)
        .set({ timedOutUntil })
        .where(
          and(
            eq(friendGroupMembers.groupId, groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .returning();
      return row ? toMember(row) : null;
    },

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

    /** How many members a group currently has. */
    async countMembers(groupId: GroupId): Promise<number> {
      const rows = await db
        .select({ userId: friendGroupMembers.userId })
        .from(friendGroupMembers)
        .where(eq(friendGroupMembers.groupId, groupId));
      return rows.length;
    },

    /**
     * Remove a membership and, if it was the group's LAST member, delete the now-
     * empty group in the SAME transaction (task #50 auto-delete). Channels,
     * remaining memberships and invites FK-cascade from `friend_groups`; messages
     * cascade from `channels` — identical to {@link delete}. Doing the count +
     * prune inside one transaction makes concurrent leaves race-safe: exactly one
     * of them observes the empty group and deletes it.
     *
     * Kind-agnostic (operates on `friend_group_members` / `friend_groups` by id);
     * the API boundary is responsible for keeping DMs out of this path (they are
     * never emptied — ADR 0010).
     */
    async removeMemberAndPruneIfEmpty(
      groupId: GroupId,
      userId: UserId,
    ): Promise<{ removed: boolean; groupDeleted: boolean }> {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(friendGroupMembers)
          .where(
            and(
              eq(friendGroupMembers.groupId, groupId),
              eq(friendGroupMembers.userId, userId),
            ),
          )
          .returning({ userId: friendGroupMembers.userId });
        if (deleted.length === 0) return { removed: false, groupDeleted: false };

        const remaining = await tx
          .select({ userId: friendGroupMembers.userId })
          .from(friendGroupMembers)
          .where(eq(friendGroupMembers.groupId, groupId))
          .limit(1);
        if (remaining.length > 0) return { removed: true, groupDeleted: false };

        await tx.delete(friendGroups).where(eq(friendGroups.id, groupId));
        return { removed: true, groupDeleted: true };
      });
    },

    /**
     * Patch mutable server fields (`name`, `iconUrl`, `bannerUrl`,
     * `systemChannelId`, `invitePolicy`). Only the provided keys are written;
     * `null` clears the icon / banner / disables system messages. Validation that
     * `systemChannelId` is one of THIS server's text channels, and that
     * `invitePolicy` is only set on servers, lives at the API boundary. Returns
     * the updated row, or null if the group no longer exists.
     */
    async update(
      groupId: GroupId,
      patch: {
        name?: string;
        iconUrl?: string | null;
        bannerUrl?: string | null;
        systemChannelId?: string | null;
        invitePolicy?: InvitePolicy;
      },
    ): Promise<FriendGroup | null> {
      const set: Partial<typeof friendGroups.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.iconUrl !== undefined) set.iconUrl = patch.iconUrl;
      if (patch.bannerUrl !== undefined) set.bannerUrl = patch.bannerUrl;
      if (patch.systemChannelId !== undefined) set.systemChannelId = patch.systemChannelId;
      if (patch.invitePolicy !== undefined) set.invitePolicy = patch.invitePolicy;
      if (Object.keys(set).length === 0) return this.findById(groupId);
      const [row] = await db
        .update(friendGroups)
        .set(set)
        .where(eq(friendGroups.id, groupId))
        .returning();
      return row ? toGroup(row) : null;
    },

    /**
     * Delete a group and everything it owns. `channels`, `friend_group_members`,
     * and `invites` FK-cascade from `friend_groups`; `messages` cascade from
     * `channels`. Returns true when a row was removed.
     */
    async delete(groupId: GroupId): Promise<boolean> {
      const rows = await db
        .delete(friendGroups)
        .where(eq(friendGroups.id, groupId))
        .returning({ id: friendGroups.id });
      return rows.length > 0;
    },

    async getDetails(groupId: GroupId): Promise<GroupDetails | null> {
      const [groupRow] = await db
        .select()
        .from(friendGroups)
        .where(eq(friendGroups.id, groupId))
        .limit(1);
      if (!groupRow) return null;

      const channelRows = await db
        .select()
        .from(channels)
        .where(eq(channels.groupId, groupId))
        .orderBy(asc(channels.position), asc(channels.createdAt));

      const memberRows = await db
        .select({ member: friendGroupMembers, user: users })
        .from(friendGroupMembers)
        .innerJoin(users, eq(users.id, friendGroupMembers.userId))
        // Hide SOFT-DELETED members (M15): a frozen/purged account vanishes from
        // the member sidebar even though its membership row still exists.
        .where(and(eq(friendGroupMembers.groupId, groupId), isNull(users.deletedAt)))
        .orderBy(asc(friendGroupMembers.joinedAt));

      return {
        group: toGroup(groupRow),
        channels: channelRows.map(toChannel),
        members: memberRows.map((r) => ({ ...toMember(r.member), user: toUser(r.user) })),
      };
    },

    /**
     * Distinct ids of every user sharing at least one group with `userId`
     * (includes `userId` itself). Used for presence fan-out scope.
     */
    async listCoMemberUserIds(userId: UserId): Promise<UserId[]> {
      const mine = alias(friendGroupMembers, "mine");
      const rows = await db
        .selectDistinct({ userId: friendGroupMembers.userId })
        .from(friendGroupMembers)
        .innerJoin(
          mine,
          and(eq(mine.groupId, friendGroupMembers.groupId), eq(mine.userId, userId)),
        );
      return rows.map((r) => r.userId);
    },
  };
}

export type GroupsRepo = ReturnType<typeof groupsRepo>;
