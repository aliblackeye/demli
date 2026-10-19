import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type {
  CategoryId,
  Channel,
  ChannelId,
  ChannelKind,
  GroupId,
  RoleId,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { toChannel } from "../mappers.js";
import { channelRoleAccess, channels, friendGroupMembers, friendGroups } from "../schema.js";

export function channelsRepo(db: Db) {
  return {
    async create(input: {
      groupId: GroupId;
      kind: ChannelKind;
      name: string;
      /** Age-restricted (NSFW) flag (M15); defaults false. */
      nsfw?: boolean;
      /**
       * Visibility roles to lock the new channel to, applied in the SAME
       * transaction as the insert (task #51). Omitted / empty = public (no
       * `channel_role_access` rows, the pre-M9 default). A restricted channel is
       * therefore never momentarily public between create and lock. The composite
       * FK keeps every role in the channel's own group; a bad id rolls the whole
       * create back. Callers must pass deduped, group-validated ids (the API does).
       */
      roleIds?: RoleId[];
      /**
       * Sidebar category to file the new channel under (M18), or null/omitted for
       * an uncategorized channel (the pre-M18 default). The API validates that the
       * category belongs to the SAME group before calling.
       */
      categoryId?: CategoryId | null;
    }): Promise<Channel> {
      return db.transaction(async (tx) => {
        const [top] = await tx
          .select({ position: channels.position })
          .from(channels)
          .where(eq(channels.groupId, input.groupId))
          .orderBy(desc(channels.position))
          .limit(1);
        const [row] = await tx
          .insert(channels)
          .values({
            groupId: input.groupId,
            kind: input.kind,
            name: input.name,
            nsfw: input.nsfw ?? false,
            position: (top?.position ?? -1) + 1,
            categoryId: input.categoryId ?? null,
          })
          .returning();
        if (!row) throw new Error("insert channels returned no row");

        // Lock visibility to the given roles atomically with the insert (task
        // #51). Empty list leaves the channel public.
        const roleIds = input.roleIds ?? [];
        if (roleIds.length > 0) {
          await tx
            .insert(channelRoleAccess)
            .values(roleIds.map((roleId) => ({ channelId: row.id, roleId, groupId: input.groupId })));
        }

        // A server's FIRST text channel becomes its system channel (member
        // joined/left notices). The WHERE clause makes this a no-op for group
        // chats and for servers that already have one. Known MVP quirk: after
        // the owner explicitly clears it (null = off), creating another text
        // channel re-points it — distinguishing "off" from "never set" would
        // need an extra column, deferred until it matters.
        if (input.kind === "text") {
          await tx
            .update(friendGroups)
            .set({ systemChannelId: row.id })
            .where(
              and(
                eq(friendGroups.id, input.groupId),
                eq(friendGroups.kind, "server"),
                isNull(friendGroups.systemChannelId),
              ),
            );
        }
        return toChannel(row);
      });
    },

    /**
     * Create a voice channel, optionally bound to an explicit LiveKit room
     * (ADR 0012 §6). `livekitRoom` omitted / null ⇒ the room is the channel id
     * (the default for every ordinary voice channel). The DM-call upgrade passes
     * the ongoing call's room so the channel lands joiners in the live call; that
     * upgrade path builds its channels inline in one transaction
     * ({@link callUpgradeRepo}), so this helper is for standalone voice-channel
     * creation. Position is appended after the group's current channels. No role
     * locking and no system-channel assignment (both are text-only concerns).
     */
    async createVoiceChannel(input: {
      groupId: GroupId;
      name: string;
      livekitRoom?: string | null;
    }): Promise<Channel> {
      const [top] = await db
        .select({ position: channels.position })
        .from(channels)
        .where(eq(channels.groupId, input.groupId))
        .orderBy(desc(channels.position))
        .limit(1);
      const [row] = await db
        .insert(channels)
        .values({
          groupId: input.groupId,
          kind: "voice",
          name: input.name,
          position: (top?.position ?? -1) + 1,
          livekitRoom: input.livekitRoom ?? null,
        })
        .returning();
      if (!row) throw new Error("insert channels returned no row");
      return toChannel(row);
    },

    /**
     * Patch mutable channel fields. Only provided keys are written; `description`,
     * `maxParticipants`, and `audioBitrateKbps` accept `null` to clear them.
     * Kind-specific enforcement (`maxParticipants`/`audioBitrateKbps` voice-only,
     * `slowmodeSeconds` text-only) lives at the API boundary, not here.
     * Returns the updated row, or null if the channel no longer exists.
     */
    async update(
      channelId: ChannelId,
      patch: {
        name?: string;
        description?: string | null;
        maxParticipants?: number | null;
        slowmodeSeconds?: number;
        audioBitrateKbps?: number | null;
        nsfw?: boolean;
      },
    ): Promise<Channel | null> {
      const set: Partial<typeof channels.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.maxParticipants !== undefined) set.maxParticipants = patch.maxParticipants;
      if (patch.slowmodeSeconds !== undefined) set.slowmodeSeconds = patch.slowmodeSeconds;
      if (patch.audioBitrateKbps !== undefined) set.audioBitrateKbps = patch.audioBitrateKbps;
      if (patch.nsfw !== undefined) set.nsfw = patch.nsfw;
      if (Object.keys(set).length === 0) return this.findById(channelId);
      const [row] = await db
        .update(channels)
        .set(set)
        .where(eq(channels.id, channelId))
        .returning();
      return row ? toChannel(row) : null;
    },

    /** Delete a channel; its `messages` FK-cascade. Returns true when a row was removed. */
    async delete(channelId: ChannelId): Promise<boolean> {
      const rows = await db
        .delete(channels)
        .where(eq(channels.id, channelId))
        .returning({ id: channels.id });
      return rows.length > 0;
    },

    async findById(channelId: ChannelId): Promise<Channel | null> {
      const [row] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      return row ? toChannel(row) : null;
    },

    /**
     * The voice channel bound to an explicit LiveKit room override
     * (`channels.livekit_room`, ADR 0012 §6 — the `dmcall:<id>` room a seamless
     * upgrade pins a group's voice channel to), or null.
     *
     * The REVERSE of the media-token path's `room = livekitRoom ?? id`. Needed by
     * anything that starts from a live SFU room and has to decide what KIND of
     * surface it is — the alone-idle sweep must eject from a call surface and must
     * never touch a server voice channel, so it cannot guess: `dmcall:` rooms bound
     * to a channel are indistinguishable from unbound ones by name alone.
     */
    async findByLivekitRoom(room: string): Promise<Channel | null> {
      const [row] = await db
        .select()
        .from(channels)
        .where(eq(channels.livekitRoom, room))
        .limit(1);
      return row ? toChannel(row) : null;
    },

    /**
     * Every voice channel of a group with the LiveKit room it actually runs in
     * (`livekitRoom ?? id`, ADR 0012 §6). Moderation uses it to force a removed
     * member out of the SFU: an upgraded group's voice channel lives in the
     * `dmcall:<id>` room, so evicting by channel id alone would miss the room the
     * member is really talking in.
     */
    async listVoiceRoomsForGroup(
      groupId: GroupId,
    ): Promise<Array<{ channelId: ChannelId; room: string }>> {
      const rows = await db
        .select({ id: channels.id, livekitRoom: channels.livekitRoom })
        .from(channels)
        .where(and(eq(channels.groupId, groupId), eq(channels.kind, "voice")));
      return rows.map((row) => ({ channelId: row.id, room: row.livekitRoom ?? row.id }));
    },

    /**
     * The LiveKit room override of each given channel that HAS one, keyed by
     * channel id. Channels without an override (every ordinary voice channel,
     * room = id) are absent. The batch form of the media-token path's
     * `room = livekitRoom ?? id`, for the occupancy readers that start from a
     * list of visible channel ids and must ask LiveKit for the right room names.
     */
    async livekitRoomOverrides(channelIds: readonly ChannelId[]): Promise<Map<ChannelId, string>> {
      const overrides = new Map<ChannelId, string>();
      if (channelIds.length === 0) return overrides;
      const rows = await db
        .select({ id: channels.id, livekitRoom: channels.livekitRoom })
        .from(channels)
        .where(and(inArray(channels.id, [...channelIds]), isNotNull(channels.livekitRoom)));
      for (const row of rows) {
        if (row.livekitRoom) overrides.set(row.id, row.livekitRoom);
      }
      return overrides;
    },

    async listForGroup(groupId: GroupId): Promise<Channel[]> {
      const rows = await db
        .select()
        .from(channels)
        .where(eq(channels.groupId, groupId))
        .orderBy(asc(channels.position), asc(channels.createdAt));
      return rows.map(toChannel);
    },

    /**
     * File a single channel under a category, or move it out (`categoryId: null`)
     * (M18). Position is untouched — bulk placement is
     * {@link ChannelCategoriesRepo.moveChannels}, which rewrites both. Returns the
     * updated channel, or null when it no longer exists.
     */
    async setCategory(
      channelId: ChannelId,
      categoryId: CategoryId | null,
    ): Promise<Channel | null> {
      const [row] = await db
        .update(channels)
        .set({ categoryId })
        .where(eq(channels.id, channelId))
        .returning();
      return row ? toChannel(row) : null;
    },

    /** Every channel in every group the user belongs to (WS subscriptions). */
    async listForUser(userId: UserId): Promise<Channel[]> {
      const rows = await db
        .select({ channel: channels })
        .from(channels)
        .innerJoin(
          friendGroupMembers,
          and(
            eq(friendGroupMembers.groupId, channels.groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .orderBy(asc(channels.position));
      return rows.map((r) => toChannel(r.channel));
    },

    /**
     * Channel + the requesting user's role in its group, or null when the
     * channel does not exist or the user is not a member. The permission
     * primitive for message endpoints — never trust the client (§28).
     *
     * Also surfaces the raw `livekitRoom` override (ADR 0012 §6) as a SIBLING of
     * the DTO — deliberately NOT a `Channel` field, so it never leaks on the wire.
     * The media token path resolves `room = livekitRoom ?? channel.id`, which is
     * what lets an upgraded group's voice channel (and any reconnect) land in the
     * ongoing call room. Null for every ordinary voice channel.
     */
    async findWithMembership(
      channelId: ChannelId,
      userId: UserId,
    ): Promise<{
      channel: Channel;
      role: "owner" | "member" | "guest";
      livekitRoom: string | null;
      /**
       * The member's timeout expiry (migration 0020), raw — a past instant is
       * returned as-is and the CALLER compares it to the clock (`isTimedOut`).
       *
       * Carried here rather than fetched separately because this join already
       * reads the membership row: the timeout gate on the message-send hot path
       * therefore costs ZERO extra queries on both transports. A separate lookup
       * would have added a round trip to every message sent on the platform.
       */
      timedOutUntil: Date | null;
    } | null> {
      const [row] = await db
        .select({
          channel: channels,
          role: friendGroupMembers.role,
          timedOutUntil: friendGroupMembers.timedOutUntil,
        })
        .from(channels)
        .innerJoin(
          friendGroupMembers,
          and(
            eq(friendGroupMembers.groupId, channels.groupId),
            eq(friendGroupMembers.userId, userId),
          ),
        )
        .where(eq(channels.id, channelId))
        .limit(1);
      return row
        ? {
            channel: toChannel(row.channel),
            role: row.role,
            livekitRoom: row.channel.livekitRoom,
            timedOutUntil: row.timedOutUntil,
          }
        : null;
    },
  };
}

export type ChannelsRepo = ReturnType<typeof channelsRepo>;
