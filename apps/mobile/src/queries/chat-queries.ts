/**
 * TanStack Query hooks for server state — groups, group details
 * (channels + members), messages (cursor-paged infinite query), and the
 * group/channel mutations. Mobile mirror of the desktop renderer's
 * queries/chat-queries.ts; the only change is the HTTP client is reached via
 * `getApi()` (runtime-reconfigurable base URL) instead of a fixed `api` import.
 * Realtime events keep these caches fresh (see src/realtime/connection.ts).
 */
import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CategoryId,
  ChannelCategory,
  ChannelId,
  ChannelKind,
  CustomEmojiId,
  GroupId,
  MessageId,
  PermissionBit,
  RoleId,
  UserId,
} from "@demli/types";
import type {
  ChannelOrderInput,
  CreateCustomEmojiInput,
  CreateRoleInput,
  UpdateRoleInput,
} from "@demli/client-core";
import {
  getApi,
  type GroupDetails,
  type MessagesPage,
  type ModerationLogPage,
} from "../lib/clients";
import { can, effectivePermissions, indexRoles } from "../lib/permissions";
import { queryKeys } from "../lib/query-client";
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
    queryFn: async () => (await getApi().listGroups()).groups,
  });
}

export function useGroupDetails(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.groupDetails(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async (): Promise<GroupDetails> => {
      if (!groupId) throw new Error("no group selected");
      const details = await getApi().getGroupDetails(groupId);
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
      return getApi().listMessages(channelId, { cursor: pageParam, limit: MESSAGES_PAGE_SIZE });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * Full-text message search within one channel (ADR 0011 §5). Newest-first,
 * keyset-paged; `fetchNextPage` loads OLDER matches via the `before` cursor.
 * Only runs once `query` (already debounced by the caller) is ≥
 * {@link MESSAGE_SEARCH_MIN_CHARS} chars, so a too-short query never hits the
 * endpoint (which would 400). `staleTime: 0` keeps results honest — reopening
 * the same term re-runs against fresh server state (§35, results are real).
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
      return getApi().searchMessages(channelId, {
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
    mutationFn: (input: { name: string }) => getApi().createGroup(input),
    onSuccess: async ({ group }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      useChatStore.getState().setActiveGroup(group.id);
      // The gateway snapshots channel access at connect time — re-handshake so
      // events for the new group's channels reach this client.
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
      /**
       * File the new channel straight into a category (M18) — what the "+" on a
       * category header means. Omitted/null lands it in the uncategorized list.
       */
      categoryId?: CategoryId | null;
    }) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().createChannel(groupId, input);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      resubscribeRealtime();
    },
  });
}

export function useRedeemInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => getApi().redeemInvite(code),
    onSuccess: async ({ group }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      useChatStore.getState().setActiveGroup(group.id);
      resubscribeRealtime();
    },
  });
}

export function useCreateInvite(groupId: GroupId | null) {
  return useMutation({
    mutationFn: (input: { expiresInHours?: number; maxUses?: number } = {}) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().createInvite(groupId, input);
    },
  });
}

// ---------------------------------------------------------------------------
// Roles & permissions (ADR 0007 — servers only). Mobile mirror of the desktop
// renderer's role hooks; only the client access differs (`getApi()`).
// ---------------------------------------------------------------------------

/** Custom roles of a server, pre-sorted by position. Disabled for group chats. */
export function useRoles(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.roles(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return (await getApi().listRoles(groupId)).roles;
    },
  });
}

export function useCreateRole(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().createRole(groupId, input);
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
      return getApi().updateRole(groupId, roleId, patch);
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
      return getApi().deleteRole(groupId, roleId);
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
      return getApi().setMemberRoles(groupId, input.userId, input.roleIds);
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

/** A channel's visibility role list (`[]` = public). Owner ∨ MANAGE_CHANNELS. */
export function useChannelRoles(channelId: ChannelId | null) {
  return useQuery({
    queryKey: queryKeys.channelRoles(channelId ?? "none"),
    enabled: channelId !== null,
    queryFn: async () => {
      if (!channelId) throw new Error("no channel selected");
      return (await getApi().listChannelRoles(channelId)).roleIds;
    },
  });
}

export function useSetChannelRoles(groupId: GroupId | null, channelId: ChannelId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roleIds: RoleId[]) => {
      if (!channelId) throw new Error("no channel selected");
      return getApi().setChannelRoles(channelId, roleIds);
    },
    onSuccess: async () => {
      if (channelId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.channelRoles(channelId) });
      }
      // The `restricted` flag on the channel row changed — refresh the list.
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
// Pinned messages (M17) — mirrors the desktop renderer's hooks
// ---------------------------------------------------------------------------

/**
 * A channel's pin board. UN-paginated by design (the server caps a channel at
 * `PINS_MAX_PER_CHANNEL`), and `enabled` only while the sheet is open so a
 * channel whose pins are never opened never issues the request (§27).
 */
export function usePins(channelId: ChannelId | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.pins(channelId ?? "none"),
    enabled: channelId !== null && enabled,
    queryFn: async () => {
      if (!channelId) throw new Error("no channel selected");
      return (await getApi().listPins(channelId)).pins;
    },
  });
}

/**
 * Pin / unpin one message. The authoritative UI update arrives over the socket
 * (`message.pinned`/`message.unpinned` → `foldMessagePin` + a pins invalidation),
 * so this mutation deliberately writes NO optimistic cache patch.
 */
export function useTogglePin(channelId: ChannelId | null) {
  return useMutation({
    mutationFn: async ({ messageId, pinned }: { messageId: MessageId; pinned: boolean }) => {
      if (!channelId) throw new Error("no channel selected");
      if (pinned) await getApi().unpinMessage(channelId, messageId);
      else await getApi().pinMessage(channelId, messageId);
    },
  });
}

// ---------------------------------------------------------------------------
// Custom emoji (M17)
// ---------------------------------------------------------------------------

/** Refresh window for signed emoji URLs — comfortably inside the ~1 h expiry. */
const CUSTOM_EMOJI_URL_STALE_MS = 30 * 60_000;

/** A group's custom emoji metadata + the server's per-group cap. */
export function useCustomEmojis(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.customEmojis(groupId ?? "none"),
    enabled: groupId !== null,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return getApi().listCustomEmojis(groupId);
    },
  });
}

/**
 * Signed image URLs for EVERY emoji of the group, in one request.
 *
 * Minting the whole set is safe precisely because the set is bounded
 * (`CUSTOM_EMOJI_MAX_PER_GROUP` = 64): one small round trip beats per-row URL
 * requests from a long message list, and it makes the `:name:` resolver a plain
 * synchronous map lookup at render (§27). URLs expire, so this lives in its own
 * cache with its own refresh interval.
 */
export function useCustomEmojiUrls(groupId: GroupId | null) {
  const { data } = useCustomEmojis(groupId);
  const emojiIds = useMemo(() => (data?.emojis ?? []).map((e) => e.id), [data]);
  const idsKey = emojiIds.join(",");

  return useQuery({
    queryKey: [...queryKeys.customEmojiUrls(groupId ?? "none"), idsKey],
    enabled: groupId !== null && emojiIds.length > 0,
    staleTime: CUSTOM_EMOJI_URL_STALE_MS,
    gcTime: CUSTOM_EMOJI_URL_STALE_MS * 2,
    refetchInterval: CUSTOM_EMOJI_URL_STALE_MS,
    queryFn: async () => {
      if (!groupId) throw new Error("no group selected");
      return (await getApi().getCustomEmojiUrls(groupId, emojiIds)).urls;
    },
  });
}

/**
 * `:name:` → signed image URL for one group, ready for the message renderer.
 * A name with no minted URL is simply absent and the renderer falls back to the
 * literal `:name:` text — the same graceful degradation a deleted emoji gets.
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
      return getApi().createCustomEmoji(groupId, input);
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
      return getApi().deleteCustomEmoji(groupId, emojiId);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.customEmojis(groupId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Moderation audit log (M18) — mirrors the desktop renderer's hook
// ---------------------------------------------------------------------------

/**
 * One server's moderation audit log, newest first, keyset-paged through the
 * opaque `nextCursor`. `enabled` is a hard gate so a member who may not read the
 * log (the entry is hidden for them) never issues the request at all.
 *
 * `staleTime: 0` on purpose: the log is a moderation record, not chat — reopening
 * it must show what actually happened since, not a minute-old snapshot.
 */
export function useModerationLog(groupId: GroupId | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.moderationLog(groupId ?? ("none" as GroupId)),
    enabled: groupId !== null && enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }): Promise<ModerationLogPage> => {
      if (!groupId) throw new Error("no group selected");
      return getApi().listModerationLog(groupId, { before: pageParam });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 0,
  });
}

// M18 — channel categories (migration 0019). Mirrors the desktop renderer's
// hooks, including its cache split: categories live in their OWN key rather than
// as a field on `groupDetails`, so renaming one does not refetch every channel
// and member (§27).
// ---------------------------------------------------------------------------

/** A server's categories in sidebar order. Any member may read them. */
export function useCategories(groupId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.categories(groupId ?? ("none" as GroupId)),
    enabled: groupId !== null,
    queryFn: async (): Promise<ChannelCategory[]> => {
      if (!groupId) throw new Error("no group selected");
      return (await getApi().listCategories(groupId)).categories;
    },
  });
}

/** Append a category to the end of the server's list (owner ∨ MANAGE_CHANNELS). */
export function useCreateCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().createCategory(groupId, input);
    },
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) });
    },
  });
}

/** Rename a category (owner ∨ MANAGE_CHANNELS). */
export function useRenameCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { categoryId: CategoryId; name: string }) =>
      getApi().renameCategory(input.categoryId, { name: input.name }),
    onSuccess: async () => {
      if (!groupId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) });
    },
  });
}

/**
 * Delete a category (owner ∨ MANAGE_CHANNELS). Its channels are NOT deleted —
 * the FK is ON DELETE SET NULL, so they fall back to the uncategorized list. That
 * is why `groupDetails` is invalidated too: every freed channel's `categoryId`
 * just changed, and the list would otherwise keep filing them under a category
 * that no longer exists.
 */
export function useDeleteCategory(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: CategoryId) => getApi().deleteCategory(categoryId),
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
 * Rewrite the sidebar order — BOTH axes in one atomic call, so the list can never
 * be observed half-reordered. Callers build the body with `toReorderPayload` from
 * @demli/client-core; a hand-built partial bucket renumbers from 0 and
 * collides with the neighbours nobody touched.
 *
 * Re-reads on `onSettled` rather than `onSuccess` (as the desktop does) so a
 * REJECTED reorder also pulls server truth back — an optimistic list that failed
 * to save must not be left on screen as a lie.
 */
export function useReorderChannels(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelOrderInput) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().reorderChannels(groupId, input);
    },
    onSettled: async () => {
      if (!groupId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.categories(groupId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) }),
      ]);
    },
  });
}
