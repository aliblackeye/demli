/**
 * TanStack Query hooks for server state — groups, group details
 * (channels + members), messages (cursor-paged infinite query), and the
 * group/channel/invite mutations. Realtime events keep these caches fresh
 * (see src/realtime/connection.ts).
 */

import { useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CategoryId,
  ChannelCategory,
  ChannelId,
  ChannelKind,
  CustomEmojiId,
  GroupId,
  InviteId,
  MessageId,
  PermissionBit,
  RoleId,
  UserId,
} from "@demli/types";
import {
  api,
  type ChannelOrderInput,
  type CreateCustomEmojiInput,
  type CreateRoleInput,
  type GroupChatDetails,
  type GroupDetails,
  type MessagesPage,
  type ModerationLogPage,
  type UpdateChannelInput,
  type UpdateGroupInput,
  type UpdateMeInput,
  type UpdateRoleInput,
  type UploadAvatarInput,
  type UploadBannerInput,
} from "../lib/api-client";
import { readInviteTargetChannel } from "@demli/client-core";
import { queryKeys } from "../lib/query-client";
import { isRetryablePreviewError } from "../lib/invite-embed";
import { can, effectivePermissions, indexRoles } from "../lib/permissions";
import { resubscribeRealtime } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";

const MESSAGES_PAGE_SIZE = 50;

/** Minimum query length the search endpoint accepts (server 400s below this). */
export const MESSAGE_SEARCH_MIN_CHARS = 3;
/** Results per search page (server clamps to 1..50). */
const MESSAGE_SEARCH_PAGE_SIZE = 25;

export function useGroups() {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: async () => (await api.listGroups()).groups,
  });
}

export function useGroupDetails(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.groupDetails(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async (): Promise<GroupDetails> => {
      if (!groupId) throw new Error("no group selected");
      const details = await api.getGroupDetails(groupId);
      // Feed the user directory so message authors/presence resolve by id.
      useChatStore.getState().upsertUsers(details.members.map((m) => m.user));
      return details;
    },
  });
}

/**
 * Messages for one channel. Pages are newest-first (keyset pagination);
 * `fetchNextPage` loads OLDER messages. Cursors keep pages disjoint, so no
 * message can appear twice across pages (rendering dedupes by id anyway).
 */
export function useChannelMessages(channelId: ChannelId | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.messages(channelId ?? "none"),
    enabled: channelId !== null,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<MessagesPage> => {
      if (!channelId) throw new Error("no channel selected");
      return api.listMessages(channelId, { cursor: pageParam, limit: MESSAGES_PAGE_SIZE });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * Full-text message search within one channel (ADR 0011 §5). Newest-first,
 * keyset-paged; `fetchNextPage` loads OLDER matches via the `before` cursor.
 * Only runs once `query` (already debounced by the caller) is ≥
 * {@link MESSAGE_SEARCH_MIN_CHARS} chars, so a too-short query never hits the
 * endpoint (which would 400). `staleTime: 0` keeps the panel honest — reopening
 * with the same term re-runs against fresh server state (§35, results are real).
 */
export function useChannelSearch(channelId: ChannelId | null, query: string) {
  const trimmed = query.trim();
  const enabled = channelId !== null && trimmed.length >= MESSAGE_SEARCH_MIN_CHARS;
  return useInfiniteQuery({
    queryKey: queryKeys.messageSearch(channelId ?? "none", trimmed),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<MessagesPage> => {
      if (!channelId) throw new Error("no channel selected");
      return api.searchMessages(channelId, {
        q: trimmed,
        limit: MESSAGE_SEARCH_PAGE_SIZE,
        before: pageParam,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 0,
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.createGroup(input),
    onSuccess: async ({ group }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      useChatStore.getState().setActiveGroup(group.id);
      // The gateway snapshots channel access at connect time — re-handshake
      // so events for the new group's channels reach this client.
      resubscribeRealtime();
    },
  });
}

export function useRedeemInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.redeemInvite(code),
    onSuccess: async (result) => {
      const { group } = result;
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      // A channel invite lands the joiner ON its channel. Seeded BEFORE
      // `setActiveGroup`, which reads `lastChannelByGroup` to pick a provisional
      // selection — seeding after would leave the first paint on #general and
      // then jump. `readInviteTargetChannel` (rather than reading the field) is
      // the deployment guard: it answers null for a plain server invite, a
      // deleted or invisible target, AND for a server that predates migration
      // 0021 — all of which correctly mean "front door", none of which may throw.
      const target = readInviteTargetChannel(result);
      if (target) useChatStore.getState().rememberChannelForGroup(group.id, target.id);
      useChatStore.getState().setActiveGroup(group.id);
      resubscribeRealtime();
    },
  });
}

export function useCreateChannel(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      kind: ChannelKind;
      roleIds?: RoleId[];
      nsfw?: boolean;
    }) => {
      if (!groupId) throw new Error("no group selected");
      return api.createChannel(groupId, input);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      resubscribeRealtime();
    },
  });
}

/**
 * Mint an invite for the active server.
 *
 * `targetChannelId` makes it a CHANNEL invite (the redeemer lands there instead
 * of the front door). Additive and safe against an API that does not know the
 * field: it is ignored server-side and the link degrades to a plain server
 * invite, which every redeem path already handles.
 */
export function useCreateInvite(groupId: GroupId | null) {
  return useMutation({
    mutationFn: (
      input: { expiresInHours?: number; maxUses?: number; targetChannelId?: ChannelId } = {},
    ) => {
      if (!groupId) throw new Error("no group selected");
      return api.createInvite(groupId, input);
    },
  });
}

// ---------------------------------------------------------------------------
// Server management (owner-only) — rename/icon + delete (ADR 0005 §Server)
// ---------------------------------------------------------------------------

export function useUpdateGroup(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGroupInput) => {
      if (!groupId) throw new Error("no group selected");
      return api.updateGroup(groupId, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Upload a SERVER banner (the wide image behind the channel-sidebar header).
 * Mirrors {@link useUploadBanner}, the profile-banner hook, one level up: on
 * success the server returns the updated group, so the group list and this
 * server's details are invalidated and the header repaints.
 *
 * Every other member is told by the `group.updated` realtime event the route
 * publishes — no polling, and no second code path to keep in step. Failures
 * surface to the caller (GeneralTab renders them inline — no window.alert).
 */
export function useUploadGroupBanner(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadBannerInput) => {
      if (!groupId) throw new Error("no group selected");
      return api.uploadGroupBanner(groupId, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupId: GroupId) => api.deleteGroup(groupId),
    onSuccess: async () => {
      // AppShell's selection sync re-picks a valid server once the list refetches.
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      // Our channel access changed — re-handshake so the gateway drops the
      // deleted server's channels from this connection.
      resubscribeRealtime();
    },
  });
}

/**
 * Leave a server (self-removal). Posts a "left" system message server-side and
 * drops our channel access. AppShell's selection sync re-picks a valid server
 * once the list refetches (same as delete), so no explicit re-selection here.
 */
export function useLeaveGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupId: GroupId; userId: string }) =>
      api.leaveGroup(input.groupId, input.userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      resubscribeRealtime();
    },
  });
}

// ---------------------------------------------------------------------------
// Channel management (owner-only) — edit/delete (server channels only)
// ---------------------------------------------------------------------------

export function useUpdateChannel(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: ChannelId } & UpdateChannelInput) => {
      const { channelId, ...patch } = input;
      return api.updateChannel(channelId, patch);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

export function useDeleteChannel(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: ChannelId) => api.deleteChannel(channelId),
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      // The channel (and its subscription) is gone — re-handshake.
      resubscribeRealtime();
    },
  });
}

// ---------------------------------------------------------------------------
// Flat group chats (ADR 0005) — the home surface
// ---------------------------------------------------------------------------

export function useGroupChats() {
  return useQuery({
    queryKey: queryKeys.groupChats,
    queryFn: async () => (await api.listGroupChats()).groups,
  });
}

export function useGroupChat(groupChatId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.groupChatDetails(groupChatId ?? "none"),
    enabled: groupChatId !== null,
    queryFn: async (): Promise<GroupChatDetails> => {
      if (!groupChatId) throw new Error("no group chat selected");
      const details = await api.getGroupChat(groupChatId);
      // Feed the user directory so message authors/presence resolve by id.
      useChatStore.getState().upsertUsers(details.members.map((m) => m.user));
      return details;
    },
  });
}

export function useCreateGroupChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.createGroupChat(input),
    onSuccess: async ({ group }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
      useChatStore.getState().openGroupChat({ id: group.id, streamId: group.streamId });
      // The gateway snapshots channel access at connect time — re-handshake so
      // the new group's stream channel events reach this client.
      resubscribeRealtime();
    },
  });
}

export function useAddGroupChatMember(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string }) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return api.addGroupChatMember(groupChatId, input);
    },
    onSuccess: async () => {
      if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatDetails(groupChatId),
        });
      }
    },
  });
}

/**
 * Remove a member from a group chat — owner removes anyone, a member removes
 * only themselves (leave). Callers pass their own selection cleanup for the
 * leave case via `onSuccess`.
 */
export function useRemoveGroupChatMember(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return api.removeGroupChatMember(groupChatId, userId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
      if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatDetails(groupChatId),
        });
      }
    },
  });
}

/**
 * Delete a flat group chat (owner-only). The server also broadcasts
 * `group.deleted` so every other member drops it live; here we just prune our
 * own caches and re-handshake so the gateway drops the (now-gone) stream channel.
 */
export function useDeleteGroupChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupChatId: GroupId) => api.deleteGroupChat(groupChatId),
    onSuccess: async (_result, groupChatId) => {
      queryClient.removeQueries({ queryKey: queryKeys.groupChatDetails(groupChatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
      resubscribeRealtime();
    },
  });
}

// ---------------------------------------------------------------------------
// Profile — edit own display name + avatar URL
// ---------------------------------------------------------------------------

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => api.updateMe(input),
    onSuccess: ({ user }) => {
      // Reflect the change everywhere the user is rendered (footer, messages).
      useAuthStore.getState().setUser(user);
      useChatStore.getState().upsertUsers([user]);
      // The profile card reads a SEPARATE ["profile", id, …] cache with a 60s
      // staleTime; without this, saving a bio then reopening your own card shows
      // the pre-save cache (the reported P0). Invalidate every groupId variant of
      // this user's card, and keep the `me` cache in sync so no refetch is needed.
      queryClient.setQueryData(queryKeys.me, user);
      void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    },
  });
}

/**
 * Upload a profile photo (link → file). On success the server returns the user
 * with its new public `avatarUrl`; we mirror it into the auth store, the user
 * directory (footer / messages / member lists) and the `me`/profile caches so the
 * new photo appears everywhere at once. The disabled/rejected/too-large failures
 * surface to the caller (ProfileSettings shows them inline — no window.alert).
 */
export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadAvatarInput) => api.uploadAvatar(input),
    onSuccess: ({ user }) => {
      useAuthStore.getState().setUser(user);
      useChatStore.getState().upsertUsers([user]);
      queryClient.setQueryData(queryKeys.me, user);
      void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    },
  });
}

/**
 * Upload a profile BANNER (the wide header image on the profile card). Mirrors
 * {@link useUploadAvatar}: on success the server returns the user with its new
 * public `bannerUrl`, which we mirror into the auth store, the user directory and
 * the `me`/profile caches so the banner appears everywhere at once. Failures
 * surface to the caller (ProfileSettings shows them inline — no window.alert).
 */
export function useUploadBanner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadBannerInput) => api.uploadBanner(input),
    onSuccess: ({ user }) => {
      useAuthStore.getState().setUser(user);
      useChatStore.getState().upsertUsers([user]);
      queryClient.setQueryData(queryKeys.me, user);
      void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    },
  });
}

/**
 * Permanently delete (freeze) the signed-in account (Settings → Danger zone).
 * The server freezes the account for a 14-day grace window; the caller signs out
 * on success (handled by ProfileSettings). No cache writes here — the local
 * sign-out tears every per-account cache down.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: () => api.deleteMe(),
  });
}

// ---------------------------------------------------------------------------
// Roles & permissions (ADR 0007 — servers only)
// ---------------------------------------------------------------------------

/** Custom roles of a server, pre-sorted by position. Disabled for group chats. */
export function useRoles(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.roles(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return (await api.listRoles(groupId)).roles;
    },
  });
}

export function useCreateRole(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => {
      if (!groupId) throw new Error("no group selected");
      return api.createRole(groupId, input);
    },
    onSuccess: async () => {
      if (groupId) await queryClient.invalidateQueries({ queryKey: queryKeys.roles(groupId) });
    },
  });
}

export function useUpdateRole(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { roleId: RoleId } & UpdateRoleInput) => {
      if (!groupId) throw new Error("no group selected");
      const { roleId, ...patch } = input;
      return api.updateRole(groupId, roleId, patch);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles(groupId) });
      // A color/permission change repaints member names — refresh details too.
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
    },
  });
}

export function useDeleteRole(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roleId: RoleId) => {
      if (!groupId) throw new Error("no group selected");
      return api.deleteRole(groupId, roleId);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles(groupId) });
      // Deleting a role drops it from members and can re-open channels — refetch.
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      resubscribeRealtime();
    },
  });
}

export function useSetMemberRoles(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; roleIds: RoleId[] }) => {
      if (!groupId) throw new Error("no group selected");
      return api.setMemberRoles(groupId, input.userId, input.roleIds);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      // Our own visible channels may have changed — re-handshake the gateway.
      resubscribeRealtime();
    },
  });
}

/**
 * Kick a member (owner ∨ KICK_MEMBERS). Uses the dedicated moderation endpoint
 * (migration 0017) rather than the owner-only leave endpoint, so a non-owner
 * holding KICK_MEMBERS can actually act — the leave route rejects anyone but the
 * owner from removing others (§35 permission model). The API re-checks the
 * permission and refuses to target the owner / self.
 */
export function useKickMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!groupId) throw new Error("no group selected");
      return api.kickMember(groupId, userId);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Ban a member from a server (owner ∨ KICK_MEMBERS, migration 0017): a kick PLUS
 * a permanent block so no invite brings them back. Same API guards as kick (never
 * the owner, never self). Refreshes the member roster on success.
 */
export function useBanMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; reason?: string }) => {
      if (!groupId) throw new Error("no group selected");
      return api.banMember(groupId, input.userId, input.reason);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Force-disconnect a user from a voice channel (owner ∨ KICK_MEMBERS, migration
 * 0017). The SFU participant is removed and the target gets a user-scoped
 * `voice.disconnected`, so their client leaves cleanly. No cache write needed —
 * the gateway's `voice.participant_*` fan-out removes the row for everyone. Not a
 * ban: they can rejoin.
 */
export function useDisconnectFromVoice(channelId: ChannelId | null) {
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!channelId) throw new Error("no channel selected");
      return api.disconnectFromVoice(channelId, userId);
    },
  });
}

/**
 * Set (or clear with `null`) a member's PER-SERVER nickname — the one everyone
 * in the server sees (ADR 0019 §2). Renaming YOURSELF needs no permission;
 * renaming anyone else needs owner ∨ MANAGE_NICKNAMES and the API refuses to
 * rename the owner. Distinct from `useSetPrivateNickname`, which is the
 * viewer-only label; conflating the two would publish a private name to a
 * whole server.
 */
export function useSetMemberNickname(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; nickname: string | null }) => {
      if (!groupId) throw new Error("no group selected");
      return api.setMemberNickname(groupId, input.userId, input.nickname);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Time a member out for a number of minutes (owner ∨ KICK_MEMBERS, ADR 0019
 * §3). While it holds they cannot send messages, react, or join voice in this
 * server — all enforced server-side on both transports; this mutation only
 * records the state. Never the owner, never yourself (the API refuses both).
 */
export function useTimeoutMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; minutes: number; reason?: string }) => {
      if (!groupId) throw new Error("no group selected");
      return api.timeoutMember(groupId, input.userId, {
        minutes: input.minutes,
        reason: input.reason,
      });
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.moderationLog(groupId) });
      }
    },
  });
}

/** Lift a timeout early (same permission); logged as a separate `timeout_remove`. */
export function useRemoveMemberTimeout(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!groupId) throw new Error("no group selected");
      return api.removeMemberTimeout(groupId, userId);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.moderationLog(groupId) });
      }
    },
  });
}

/** A channel's visibility role list (`[]` = public). Owner ∨ MANAGE_CHANNELS. */
export function useChannelRoles(channelId: ChannelId | null) {
  return useQuery({
    queryKey: queryKeys.channelRoles(channelId ?? "none"),
    enabled: channelId !== null,
    queryFn: async () => {
      if (!channelId) throw new Error("no channel selected");
      return (await api.listChannelRoles(channelId)).roleIds;
    },
  });
}

export function useSetChannelRoles(groupId: GroupId | null, channelId: ChannelId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roleIds: RoleId[]) => {
      if (!channelId) throw new Error("no channel selected");
      return api.setChannelRoles(channelId, roleIds);
    },
    onSuccess: async () => {
      if (channelId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.channelRoles(channelId) });
      }
      // The `restricted` flag on the channel row changed — refresh the sidebar.
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      // Visibility changed for us or others — re-handshake the gateway.
      resubscribeRealtime();
    },
  });
}

/**
 * The signed-in user's effective access on a server (COSMETIC gating only —
 * the API is authoritative). `can(bit)` short-circuits true for the owner.
 */
export function useServerPermissions(groupId: GroupId | null) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data: details } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);

  return useMemo(() => {
    const ownerId = details?.group.ownerId;
    const isOwner = ownerId != null && ownerId === currentUserId;
    const me = details?.members.find((m) => m.userId === currentUserId);
    const bits = effectivePermissions(me?.roleIds, indexRoles(roles));
    return {
      isOwner,
      bits,
      can: (bit: PermissionBit) => can(isOwner, bits, bit),
    };
  }, [details, roles, currentUserId]);
}

// ---------------------------------------------------------------------------
// Pinned messages (M17)
// ---------------------------------------------------------------------------

/**
 * A channel's pin board. UN-paginated by design (the server caps a channel at
 * `PINS_MAX_PER_CHANNEL`), and `enabled` only while the panel is open so a
 * channel the user never opens the pins of never issues the request (§27).
 */
export function usePins(channelId: ChannelId | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.pins(channelId ?? "none"),
    enabled: channelId !== null && enabled,
    queryFn: async () => {
      if (!channelId) throw new Error("no channel selected");
      return (await api.listPins(channelId)).pins;
    },
  });
}

/**
 * Pin / unpin one message. The authoritative UI update arrives over the socket
 * (`message.pinned`/`message.unpinned` → `foldMessagePin` + a pins invalidation),
 * so this mutation deliberately writes NO optimistic cache patch — it only
 * surfaces the failure to the caller.
 */
export function useTogglePin(channelId: ChannelId | null) {
  return useMutation({
    mutationFn: async ({ messageId, pinned }: { messageId: MessageId; pinned: boolean }) => {
      if (!channelId) throw new Error("no channel selected");
      if (pinned) await api.unpinMessage(channelId, messageId);
      else await api.pinMessage(channelId, messageId);
    },
  });
}

// ---------------------------------------------------------------------------
// Custom emoji (M17)
// ---------------------------------------------------------------------------

/** A group's custom emoji metadata + the server's per-group cap. */
export function useCustomEmojis(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.customEmojis(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return api.listCustomEmojis(groupId);
    },
  });
}

/**
 * Signed image URLs for EVERY emoji of the group, in one request.
 *
 * Minting the whole set is safe precisely because the set is bounded
 * (`CUSTOM_EMOJI_MAX_PER_GROUP` = 64): one small round trip beats per-row URL
 * requests from a virtualized message list, and it means the `:name:` resolver
 * is a plain synchronous map lookup at render time (§27). URLs expire, so this
 * cache refreshes on its own interval rather than living in the metadata cache.
 */
export function useCustomEmojiUrls(groupId: GroupId | null) {
  const { data } = useCustomEmojis(groupId);
  const emojiIds = useMemo(() => (data?.emojis ?? []).map((e) => e.id), [data]);
  const idsKey = emojiIds.join(",");

  return useQuery({
    queryKey: [...queryKeys.customEmojiUrls(groupId ?? "none"), idsKey],
    enabled: groupId !== null && emojiIds.length > 0,
    // Signed reads live ~1 h; refresh well inside that window.
    staleTime: CUSTOM_EMOJI_URL_STALE_MS,
    gcTime: CUSTOM_EMOJI_URL_STALE_MS * 2,
    refetchInterval: CUSTOM_EMOJI_URL_STALE_MS,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return (await api.getCustomEmojiUrls(groupId, emojiIds)).urls;
    },
  });
}

/** Refresh window for signed emoji URLs — comfortably inside the ~1 h expiry. */
const CUSTOM_EMOJI_URL_STALE_MS = 30 * 60_000;

/**
 * `:name:` → signed image URL for one group, ready for the message renderer.
 * A name with no (yet) minted URL is simply absent, and the renderer falls back
 * to the literal `:name:` text — the same graceful degradation a deleted emoji
 * gets.
 */
export function useCustomEmojiMap(groupId: GroupId | null): ReadonlyMap<string, string> {
  const { data: meta } = useCustomEmojis(groupId);
  const { data: urls } = useCustomEmojiUrls(groupId);

  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of urls ?? []) byId.set(entry.emojiId, entry.url);
    const byName = new Map<string, string>();
    for (const emoji of meta?.emojis ?? []) {
      const url = byId.get(emoji.id);
      if (url) byName.set(emoji.name, url);
    }
    return byName;
  }, [meta, urls]);
}

/** Upload a custom emoji (inline base64 — see the API contract). */
export function useCreateCustomEmoji(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomEmojiInput) => {
      if (!groupId) throw new Error("no group selected");
      return api.createCustomEmoji(groupId, input);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.customEmojis(groupId) });
    },
  });
}

/** Delete a custom emoji (uploader ∨ group owner). */
export function useDeleteCustomEmoji(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (emojiId: CustomEmojiId) => {
      if (!groupId) throw new Error("no group selected");
      return api.deleteCustomEmoji(groupId, emojiId);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.customEmojis(groupId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Channel categories (M18 — migration 0019)
// ---------------------------------------------------------------------------

/**
 * A server's sidebar categories. Its own cache (not a field on groupDetails) so a
 * rename or a reorder never refetches the channel + member payload (§27). Every
 * member may read them; the mutations below are owner ∨ MANAGE_CHANNELS and the
 * API re-checks — the UI gating is cosmetic.
 */
export function useCategories(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.categories(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async (): Promise<ChannelCategory[]> => {
      if (!groupId) throw new Error("no group selected");
      return (await api.listCategories(groupId)).categories;
    },
  });
}

export function useCreateCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => {
      if (!groupId) throw new Error("no group selected");
      return api.createCategory(groupId, input);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) });
    },
  });
}

export function useRenameCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { categoryId: CategoryId; name: string }) =>
      api.renameCategory(input.categoryId, { name: input.name }),
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) });
    },
  });
}

/**
 * Delete a category. Its channels are NOT deleted — the FK is ON DELETE SET NULL,
 * so they reappear in the uncategorized top-level list. Both caches are therefore
 * invalidated: the category list AND the channel list (whose `categoryId`s just
 * became null).
 */
export function useDeleteCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: CategoryId) => api.deleteCategory(categoryId),
    onSuccess: async () => {
      if (!groupId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) }),
      ]);
    },
  });
}

/**
 * Persist a new sidebar order (both axes, one atomic call). The payload must
 * already list every touched bucket in FULL — build it with `toReorderPayload`
 * from @demli/app-ui, never by hand (see the API contract note).
 */
export function useReorderChannels(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelOrderInput) => {
      if (!groupId) throw new Error("no group selected");
      return api.reorderChannels(groupId, input);
    },
    onSettled: async () => {
      if (!groupId) return;
      // Settled, not success: a REJECTED reorder must also re-read the server's
      // truth, so a rolled-back sidebar can never drift from what was stored.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Moderation audit log (M18) — owner ∨ KICK_MEMBERS
// ---------------------------------------------------------------------------

/** One page of audit entries; `fetchNextPage` walks backwards in time. */
export function useModerationLog(groupId: GroupId | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.moderationLog(groupId ?? "none"),
    enabled: groupId !== null && enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ModerationLogPage> => {
      if (!groupId) throw new Error("no group selected");
      return api.listModerationLog(groupId, { before: pageParam });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // The log is a moderation record, not chat: reopening the tab must show what
    // actually happened since, not a minute-old snapshot.
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Group-DM invite links (M18) — same invites table, same redeem endpoint
// ---------------------------------------------------------------------------

export function useGroupChatInvites(groupChatId: GroupId | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupChatInvites(groupChatId ?? "none"),
    enabled: groupChatId !== null && enabled,
    queryFn: async () => {
      if (!groupChatId) throw new Error("no group chat selected");
      return (await api.listGroupChatInvites(groupChatId)).invites;
    },
    staleTime: 0,
  });
}

/** Any member may mint a link (a flat chat has no roles and no invite policy). */
export function useCreateGroupChatInvite(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expiresInHours?: number; maxUses?: number } = {}) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return api.createGroupChatInvite(groupChatId, input);
    },
    onSuccess: async () => {
      if (!groupChatId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.groupChatInvites(groupChatId),
      });
    },
  });
}

/** Revoking is OWNER-only, mirroring "only the owner adds members". */
export function useRevokeGroupChatInvite(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: InviteId) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return api.revokeGroupChatInvite(groupChatId, inviteId);
    },
    onSuccess: async () => {
      if (!groupChatId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.groupChatInvites(groupChatId),
      });
    },
  });
}

// --- In-chat invite embed card (davet kartı) ---------------------------------

/**
 * Peek preview for one invite code. Cached per code with a generous staleTime
 * so the SAME link across many messages / rerenders costs one request — the
 * card is rendered from inside the virtualized message list, which mounts and
 * unmounts rows constantly (§27). Decided API answers (dead invite) are never
 * retried; only transport failures are.
 */
export function useInvitePreview(code: string) {
  return useQuery({
    queryKey: queryKeys.invitePreview(code),
    queryFn: async () => (await api.getInvitePreview(code)).preview,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: (failureCount, error) => failureCount < 2 && isRetryablePreviewError(error),
  });
}

/**
 * Redeem FROM the card. Same wire call as {@link useRedeemInvite}, but it does
 * NOT auto-navigate — the card flips to "Katıldın" + a "git" button and the
 * user decides when to go. Invalidates the groups AND flat
 * group-chat lists (one invite pipeline serves both, ADR 0005) plus this
 * code's preview so `alreadyMember` refreshes.
 */
export function useRedeemInviteFromEmbed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.redeemInvite(code),
    onSuccess: async (result, code) => {
      // Remember the target now even though the card does not navigate: the
      // user's "git" press goes through `openServer`, which reads this memory.
      // A voice target is therefore SELECTED, never connected — the founder's
      // "tekrar bastığında sesli odaya katılır".
      const target = readInviteTargetChannel(result);
      if (target) {
        useChatStore.getState().rememberChannelForGroup(result.group.id, target.id);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
        queryClient.invalidateQueries({ queryKey: queryKeys.groupChats }),
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.invitePreview(code) });
      // The gateway snapshots channel access at connect time — re-handshake so
      // events for the new group's channels reach this client.
      resubscribeRealtime();
    },
  });
}
