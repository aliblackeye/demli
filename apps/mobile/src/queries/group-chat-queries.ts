/**
 * TanStack Query hooks for flat group chats (ADR 0005) — a `friend_groups` row
 * with `kind='group'` that owns exactly one hidden stream channel. Kept separate
 * from the server-facing chat-queries so the two social shapes never collide.
 *
 * Messages reuse the channel pipeline keyed by `group.streamId`, so a group chat
 * needs no message hooks of its own — the shared <ChatThread> takes `streamId`
 * as the channel id. These hooks only cover the group-chat roster lifecycle.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupId, InviteId } from "@demli/types";
import { getApi, type GroupChatDetails } from "../lib/clients";
import { queryKeys } from "../lib/query-client";
import { resubscribeRealtime } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";

export function useGroupChats() {
  return useQuery({
    queryKey: queryKeys.groupChats,
    queryFn: async () => (await getApi().listGroupChats()).groups,
  });
}

export function useGroupChatDetails(groupChatId: GroupId | null) {
  return useQuery({
    queryKey: queryKeys.groupChatDetails(groupChatId ?? "none"),
    enabled: groupChatId !== null,
    queryFn: async (): Promise<GroupChatDetails> => {
      if (!groupChatId) throw new Error("no group chat selected");
      const details = await getApi().getGroupChat(groupChatId);
      // Feed the user directory so message authors/presence resolve by id.
      useChatStore.getState().upsertUsers(details.members.map((m) => m.user));
      return details;
    },
  });
}

export function useCreateGroupChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => getApi().createGroupChat(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
      // The gateway snapshots channel access at connect time; this connection
      // predates the new stream channel, so re-handshake to receive its events.
      resubscribeRealtime();
    },
  });
}

export function useAddGroupChatMember(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string }) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return getApi().addGroupChatMember(groupChatId, input);
    },
    onSuccess: async ({ member }) => {
      useChatStore.getState().upsertUsers([member.user]);
      if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatDetails(groupChatId),
        });
      }
      // Adding another member does not change THIS client's channel access, so
      // no resubscribe is needed here (the added user re-subscribes on connect).
    },
  });
}

export function useRemoveGroupChatMember(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return getApi().removeGroupChatMember(groupChatId, userId);
    },
    onSuccess: async (_result, userId) => {
      const me = useAuthStore.getState().user;
      if (me && userId === me.id) {
        // I left: drop the group from my list, forget its roster, and
        // re-handshake since I no longer have access to its stream channel.
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
        if (groupChatId) {
          queryClient.removeQueries({ queryKey: queryKeys.groupChatDetails(groupChatId) });
        }
        resubscribeRealtime();
      } else if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatDetails(groupChatId),
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Invite links (M18) — the SAME `invites` table and the SAME
// `POST /invites/:code/redeem` endpoint a server invite uses, so the product has
// exactly one deep-link shape and one join flow.
// ---------------------------------------------------------------------------

/**
 * The group chat's live links. Readable by any member — seeing what is currently
 * handed out is not a privileged act, and the owner-only rule applies to REVOKING
 * (see `canRevokeGroupChatInvite` in @demli/client-core).
 *
 * Expired and exhausted links stay in this list: the server does not filter them,
 * and hiding them would leave a member wondering why a link they shared stopped
 * working. The screen annotates each row's remaining life instead.
 */
export function useGroupChatInvites(groupChatId: GroupId | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groupChatInvites(groupChatId ?? "none"),
    enabled: enabled && groupChatId !== null,
    queryFn: async () => {
      if (!groupChatId) throw new Error("no group chat selected");
      return (await getApi().listGroupChatInvites(groupChatId)).invites;
    },
  });
}

/** Mint a link (any member). */
export function useCreateGroupChatInvite(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expiresInHours?: number; maxUses?: number }) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return getApi().createGroupChatInvite(groupChatId, input);
    },
    onSuccess: async () => {
      if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatInvites(groupChatId),
        });
      }
      // The gateway is deliberately NOT re-handshaked here: a link grants nobody
      // new channel access. The person who redeems it re-subscribes on their
      // own side, where the membership actually changed.
    },
  });
}

/** Revoke one link (group OWNER only — the API answers 403 to anyone else). */
export function useRevokeGroupChatInvite(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: InviteId) => {
      if (!groupChatId) throw new Error("no group chat selected");
      return getApi().revokeGroupChatInvite(groupChatId, inviteId);
    },
    onSuccess: async () => {
      if (groupChatId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupChatInvites(groupChatId),
        });
      }
    },
  });
}

/**
 * Delete a flat group chat (owner-only). The server broadcasts `group.deleted`
 * so every other member drops it live; here we prune our own caches and
 * re-handshake so the gateway drops the (now-gone) stream channel.
 */
export function useDeleteGroupChat(groupChatId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!groupChatId) throw new Error("no group chat selected");
      return getApi().deleteGroupChat(groupChatId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
      if (groupChatId) {
        queryClient.removeQueries({ queryKey: queryKeys.groupChatDetails(groupChatId) });
      }
      resubscribeRealtime();
    },
  });
}
