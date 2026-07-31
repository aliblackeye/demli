/**
 * TanStack Query hooks for the social layer (ADR 0010 — friendships, DMs,
 * profiles). Realtime friend and dm.created events keep these caches fresh; see
 * src/realtime/connection.ts. Every mutation also invalidates the relevant
 * caches so the acting client updates immediately even before the gateway
 * fan-out (W3) is live — the refetch fallback the task requires.
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dm, GroupId, User, UserId } from "@demli/types";
import {
  api,
  type FriendRequestDirection,
  type SendFriendRequestInput,
} from "../lib/api-client";
import { queryKeys } from "../lib/query-client";
import { resubscribeRealtime, sendChatMessage } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The signed-in user's self record — the ONLY read that carries the private
 * `friendCode` (ADR 0010 §2). Used by the "Add friend" surface to show/copy the
 * caller's own code. Seeded from the auth store; kept fresh on regenerate.
 */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => (await api.getMe()).user,
    // Paint instantly from the auth-store user, but treat it as stale so we
    // refetch `/users/me` once — it is the only endpoint guaranteed to carry the
    // private `friendCode` (ADR 0010 §2), which the auth/login user may omit.
    initialData: () => useAuthStore.getState().user ?? undefined,
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  });
}

export function useFriends() {
  return useQuery({
    queryKey: queryKeys.friends,
    queryFn: async () => {
      const { friends } = await api.listFriends();
      // Feed the user directory so avatars/names/presence resolve by id.
      useChatStore.getState().upsertUsers(friends.map((f) => f.user));
      return friends;
    },
  });
}

export function useFriendRequests(direction: FriendRequestDirection) {
  return useQuery({
    queryKey: queryKeys.friendRequests(direction),
    queryFn: async () => {
      const { requests } = await api.listFriendRequests(direction);
      useChatStore.getState().upsertUsers(requests.map((r) => r.user));
      return requests;
    },
  });
}

export function useDms() {
  return useQuery({
    queryKey: queryKeys.dms,
    queryFn: async () => {
      const { dms } = await api.listDms();
      useChatStore.getState().upsertUsers(dms.map((d) => d.participant));
      return dms;
    },
  });
}

/**
 * Context-aware profile card. `groupId` scopes role visibility to a shared
 * server (undefined = no server context, so no roles). Disabled until `enabled`
 * (typically the popover being open) so we never fetch a card for every avatar.
 */
export function useProfile(
  userId: UserId | null,
  groupId: GroupId | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.profile(userId ?? "none", groupId),
    enabled: enabled && userId !== null,
    queryFn: async () => {
      if (!userId) throw new Error("no user selected");
      const { profile } = await api.getUserProfile(userId, groupId);
      useChatStore.getState().upsertUsers([profile.user]);
      return profile;
    },
  });
}

// ---------------------------------------------------------------------------
// Friendship mutations
// ---------------------------------------------------------------------------

/**
 * Invalidate everything a friendship change makes stale: both request lists, the
 * friends list — AND the PROFILE cache.
 *
 * The profile is the easy one to miss and the one the user actually sees. A
 * profile carries `friendship`, and that field is what decides whether the member
 * menu offers "Add friend", "Cancel request", "Accept" or "Remove friend"
 * (`friendshipItemFor`). Refreshing only the lists left the profile saying
 * `none` after a request was sent, so the menu kept offering "Add friend" for
 * someone you had just asked — founder report, 2026-07-28. The rule was right the
 * whole time; it was being fed a stale answer.
 *
 * Invalidated by PREFIX (`["profile"]`), not per-user: a friendship touches two
 * profiles (mine and theirs), the key also carries a `groupId` so one user has
 * several entries, and profiles are small and rarely cached in bulk. Precision
 * here would buy nothing and is exactly where the next stale-field bug would
 * hide.
 */
function invalidateFriendLists(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("incoming") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("outgoing") });
  void queryClient.invalidateQueries({ queryKey: ["profile"] });
}

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendFriendRequestInput) => api.sendFriendRequest(input),
    onSuccess: () => invalidateFriendLists(queryClient),
  });
}

/**
 * Add a friend by username (#111 — the friend-code replacement). The server
 * answers a uniform result whether or not the username exists (enumeration
 * protection), so there is nothing to branch on: the caller shows one "request
 * sent, if that user exists they'll get it" message on success. We still
 * invalidate the friend lists so an auto-accept (the target had already asked
 * us) surfaces immediately.
 */
export function useSendFriendRequestByUsername() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.sendFriendRequestByUsername(username),
    onSuccess: () => invalidateFriendLists(queryClient),
  });
}

export function useAcceptFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.acceptFriendRequest(userId),
    onSuccess: () => invalidateFriendLists(queryClient),
  });
}

/** Decline (addressee) or cancel (requester) a pending request. */
export function useRemoveFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.removeFriendRequest(userId),
    onSuccess: () => invalidateFriendLists(queryClient),
  });
}

export function useUnfriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.unfriend(userId),
    onSuccess: (_result, userId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
      // The profile card's friendship state changes too.
      void queryClient.invalidateQueries({ queryKey: ["profile", userId] });
    },
  });
}

// ---------------------------------------------------------------------------
// DM mutations
// ---------------------------------------------------------------------------

/**
 * Open (idempotently create) the DM with a friend and select it. Seeds the DM
 * list cache with the returned participant-relative DTO, then re-handshakes the
 * gateway so this connection subscribes to the DM's stream channel — messages
 * flow immediately even before the W3 `dm.created` subscribe step ships (the
 * handshake subscription set is kind-agnostic, ADR 0010 §1).
 */
export function useOpenDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.openDm(userId),
    onSuccess: ({ dm }) => {
      useChatStore.getState().upsertUsers([dm.participant]);
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) => {
        const rest = (list ?? []).filter((d) => d.id !== dm.id);
        return [dm, ...rest];
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
      resubscribeRealtime();
      useChatStore.getState().openDm({ id: dm.id, streamId: dm.streamId });
    },
  });
}

/**
 * Send a message straight into a user's DM from the profile card, WITHOUT
 * navigating there.
 *
 * Deliberately not `useOpenDm` + send: opening also switches the whole surface,
 * and the profile card's message box exists precisely so you can fire off a line
 * without leaving the conversation you are in (founder's reference). It still
 * does the two things opening does that matter here — seed the DM list so the
 * new conversation appears in the sidebar, and re-handshake the gateway so this
 * connection is subscribed to the DM's stream and sees the echo.
 */
export function useSendDmMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, content }: { userId: UserId; content: string }) => {
      const { dm } = await api.openDm(userId);
      useChatStore.getState().upsertUsers([dm.participant]);
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) => {
        const rest = (list ?? []).filter((d) => d.id !== dm.id);
        return [dm, ...rest];
      });
      resubscribeRealtime();
      sendChatMessage(dm.streamId, content);
      return dm;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.dms }),
  });
}

/** Close a DM for the caller only (hide-for-self; reversible, no confirm). */
export function useHideDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dmId: GroupId) => api.hideDm(dmId),
    onSuccess: (_result, dmId) => {
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) =>
        (list ?? []).filter((d) => d.id !== dmId),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
      // If we were looking at it, fall back to the friends surface.
      if (useChatStore.getState().activeDmId === dmId) {
        useChatStore.getState().clearActiveDm();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Friend code (DEPRECATED, #111 — friend codes are being removed)
// ---------------------------------------------------------------------------

/**
 * @deprecated (#111) The add-friend surface no longer shows or regenerates a
 * friend code — friends are added by username. Retained temporarily so nothing
 * still importing it breaks; remove once the friend-code API route is retired.
 */
export function useRegenerateFriendCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.regenerateFriendCode(),
    onSuccess: ({ user }: { user: User }) => {
      queryClient.setQueryData(queryKeys.me, user);
      useAuthStore.getState().setUser(user);
    },
  });
}

// ---------------------------------------------------------------------------
// User blocking (M18 / ADR 0017)
// ---------------------------------------------------------------------------

/**
 * Everyone the signed-in user has blocked, for the settings list. Deliberately
 * NOT "who blocked me" — that is never queryable, so no UI can ever reveal it.
 */
export function useBlocks() {
  return useQuery({
    queryKey: queryKeys.blocks,
    queryFn: async () => {
      const { blocks } = await api.listBlocks();
      useChatStore.getState().upsertUsers(blocks.map((b) => b.user));
      return blocks;
    },
  });
}

/**
 * Invalidate everything a block flips: the block list, the target's profile card
 * (its `blocked` flag), the friend lists (a block severs the friendship and any
 * pending request) and the DM list. Message history in shared servers is filtered
 * SERVER-side, so the open channel's messages are refetched too.
 */
function invalidateForBlockChange(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: UserId,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.blocks });
  void queryClient.invalidateQueries({ queryKey: ["profile", userId] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("incoming") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("outgoing") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
  void queryClient.invalidateQueries({ queryKey: queryKeys.allMessages });
}

/** Block a user. Also ends the friendship / pending request in both directions. */
export function useBlockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.blockUser(userId),
    onSuccess: (_result, userId) => invalidateForBlockChange(queryClient, userId),
  });
}

/** Lift a block. Does NOT restore the friendship — that needs a new request. */
export function useUnblockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.unblockUser(userId),
    onSuccess: (_result, userId) => invalidateForBlockChange(queryClient, userId),
  });
}

// ---------------------------------------------------------------------------
// Custom status (M18)
// ---------------------------------------------------------------------------

/**
 * Set or clear the caller's own custom status. On success the returned user is
 * written straight into the auth store + `me` cache, so the footer and the own
 * profile card repaint without waiting for the round-trip event.
 */
export function useSetCustomStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string | null; expiresInMinutes?: number }) =>
      input.text === null || input.text.trim().length === 0
        ? api.clearCustomStatus()
        : api.setCustomStatus(input),
    onSuccess: ({ user }: { user: User }) => {
      queryClient.setQueryData(queryKeys.me, user);
      useAuthStore.getState().setUser(user);
      useChatStore.getState().upsertUsers([user]);
      useChatStore.getState().setCustomStatus(user.id, user.customStatus ?? null);
      void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Private notes (ADR 0019 §1)
//
// SINGLE-READER data. These hooks are the only place in the renderer that ever
// touches a note, and the cache key is its own (`user-note`, never `profile`),
// so a note can never be picked up incidentally by a component rendering
// somebody else's card. Nothing here writes a note into the chat store, the
// user directory, or any shared projection.
// ---------------------------------------------------------------------------

/**
 * The caller's private note about `userId`. `enabled` is a hard gate, not an
 * optimization: the note dialog passes `false` until it opens, so a roster of
 * fifty rows never fires fifty note requests (§27) — and a note is never
 * fetched at all unless the viewer explicitly asked to see it.
 */
export function useUserNote(userId: UserId | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.userNote(userId ?? ("" as UserId)),
    queryFn: async () => (await api.getUserNote(userId as UserId)).note,
    enabled: enabled && userId !== null,
    staleTime: 60_000,
  });
}

/** Write or clear (`body: null`) the caller's private note about a user. */
export function useSetUserNote(userId: UserId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string | null) => api.setUserNote(userId as UserId, body),
    onSuccess: ({ note }) => {
      if (userId) queryClient.setQueryData(queryKeys.userNote(userId), note);
    },
  });
}

// ---------------------------------------------------------------------------
// Private ("friend") nicknames (ADR 0019 §2)
// ---------------------------------------------------------------------------

/**
 * The caller's whole private-nickname map as `userId → nickname`. Fetched ONCE
 * and applied client-side, which is the whole point: a private label must never
 * ride along on a roster/message payload where it could reach the wrong viewer.
 *
 * `staleTime: Infinity` because the only things that change it are this
 * client's own mutations and the user-scoped `user.nickname_updated` event,
 * both of which write the cache directly.
 */
export function usePrivateNicknames() {
  return useQuery({
    queryKey: queryKeys.userNicknames,
    queryFn: async () => {
      const { nicknames } = await api.listUserNicknames();
      const map: Record<UserId, string> = {};
      for (const entry of nicknames) map[entry.user.id] = entry.nickname;
      return map;
    },
    staleTime: Infinity,
  });
}

/**
 * The same private nicknames hydrated with the user each one renames — the
 * settings list's shape (avatar, @username, the real name behind the label).
 *
 * Its own cache key, fetched only while the list is mounted: the hot map above
 * is patched in place by {@link useSetPrivateNickname} so a rename repaints
 * every surface in the same frame, and that patch cannot invent a `User` row.
 * See `queryKeys.userNicknameEntries` for the full reasoning.
 */
export function usePrivateNicknameEntries() {
  return useQuery({
    queryKey: queryKeys.userNicknameEntries,
    queryFn: async () => {
      const { nicknames } = await api.listUserNicknames();
      return nicknames;
    },
    staleTime: 60_000,
  });
}

/**
 * Set or clear the caller's private nickname for a user. The map cache is
 * patched on success so every surface — roster, message author, DM list,
 * profile card — renames in the same frame, without a refetch.
 */
export function useSetPrivateNickname(userId: UserId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nickname: string | null) => api.setUserNickname(userId as UserId, nickname),
    onSuccess: ({ nickname }) => {
      if (!userId) return;
      queryClient.setQueryData<Record<UserId, string>>(queryKeys.userNicknames, (prev) => {
        const next = { ...(prev ?? {}) };
        if (nickname) next[userId] = nickname;
        else delete next[userId];
        return next;
      });
      // The hydrated list cannot be patched (no `User` in the response), so it
      // refetches — it is only mounted while the settings panel is open.
      void queryClient.invalidateQueries({ queryKey: queryKeys.userNicknameEntries });
    },
  });
}

// ---------------------------------------------------------------------------
// Ignores (ADR 0019 §4) — NOT blocks
//
// One-directional and silent: nothing is refused, nothing is hidden
// server-side, and the ignored user is never told. What changes is that the
// server stops sending the ignorer notifications, and this client folds their
// message rows away.
// ---------------------------------------------------------------------------

/** The set of user ids the caller is ignoring. */
export function useIgnores() {
  return useQuery({
    queryKey: queryKeys.ignores,
    queryFn: async () => {
      const { ignores } = await api.listIgnores();
      return ignores;
    },
    staleTime: Infinity,
  });
}

/** `userId → true` for every ignored user — the shape the row fold reads. */
export function useIgnoredUserIds(): Set<UserId> {
  const { data } = useIgnores();
  return useMemo(() => new Set((data ?? []).map((entry) => entry.user.id)), [data]);
}

/** Start ignoring a user (idempotent server-side; they are never told). */
export function useIgnoreUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.ignoreUser(userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.ignores }),
  });
}

/** Stop ignoring a user. No history to restore — nothing was hidden (ADR 0019 §4). */
export function useUnignoreUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => api.unignoreUser(userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.ignores }),
  });
}
