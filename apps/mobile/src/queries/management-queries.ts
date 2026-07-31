/**
 * Mutations for owner-only server/channel management and self profile edits
 * (M6). These consume the DONE @demli/client-core methods and keep the
 * relevant caches + stores fresh; screens own the navigation in their per-call
 * onSuccess callbacks (mirrors the new-group pattern).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GroupId, User } from "@demli/types";
import {
  getApi,
  type UpdateChannelInput,
  type UpdateGroupInput,
  type UpdateMeInput,
} from "../lib/clients";
import { queryClient, queryKeys } from "../lib/query-client";
import { resubscribeRealtime } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";

/**
 * Fan an updated self record out to every place the app reads it: the auth store
 * (session user), the message-author directory (so own bubbles re-render), and
 * the `me` query cache (the You tab / profile screen read it via `useMe`).
 */
function applyUpdatedSelf(user: User): void {
  useAuthStore.getState().setUser(user);
  useChatStore.getState().upsertUsers([user]);
  queryClient.setQueryData(queryKeys.me, user);
}

// --- Server (kind='server') management -------------------------------------

export function useUpdateGroup(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGroupInput) => {
      if (!groupId) throw new Error("no server selected");
      return getApi().updateGroup(groupId, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

export function useDeleteGroup(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!groupId) throw new Error("no server selected");
      return getApi().deleteGroup(groupId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (groupId) {
        queryClient.removeQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      // Its channels are gone from this client's access — re-handshake to drop
      // the now-dead subscriptions.
      resubscribeRealtime();
    },
  });
}

/**
 * Leave a server (non-owner self-removal; owners delete instead). The API posts
 * a "left" system message and drops this member; afterwards the server's
 * channels are out of this client's access, so we re-handshake like delete does.
 */
export function useLeaveGroup(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!groupId) throw new Error("no server selected");
      const me = useAuthStore.getState().user;
      if (!me) throw new Error("not signed in");
      return getApi().leaveGroup(groupId, me.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (groupId) {
        queryClient.removeQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      resubscribeRealtime();
    },
  });
}

// --- Channel management (server channels only) -----------------------------

export function useUpdateChannel(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channelId: string; input: UpdateChannelInput }) =>
      getApi().updateChannel(vars.channelId, vars.input),
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
    mutationFn: (channelId: string) => getApi().deleteChannel(channelId),
    onSuccess: async (_result, channelId) => {
      queryClient.removeQueries({ queryKey: queryKeys.messages(channelId) });
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
      resubscribeRealtime();
    },
  });
}

// --- Profile ----------------------------------------------------------------

export function useUpdateMe() {
  return useMutation({
    mutationFn: (input: UpdateMeInput) => getApi().updateMe(input),
    onSuccess: ({ user }) => applyUpdatedSelf(user),
  });
}

/**
 * Upload a new profile photo (inline base64, M15). On success the server returns
 * the updated user with its new `avatarUrl`, which we fan out everywhere.
 */
export function useUploadAvatar() {
  return useMutation({
    mutationFn: (input: { mime: string; dataBase64: string }) => getApi().uploadAvatar(input),
    onSuccess: ({ user }) => applyUpdatedSelf(user),
  });
}

/** Upload a new profile banner (inline base64, allows GIF, M15). */
export function useUploadBanner() {
  return useMutation({
    mutationFn: (input: { mime: string; dataBase64: string }) => getApi().uploadBanner(input),
    onSuccess: ({ user }) => applyUpdatedSelf(user),
  });
}

/**
 * Permanently delete (freeze) the signed-in account (M15): the server soft-deletes
 * and freezes it for a 14-day grace window and revokes every session. The caller
 * logs out on success (the local account teardown clears per-account caches).
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: () => getApi().deleteMe(),
  });
}
