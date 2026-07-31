/**
 * TanStack Query hooks for the social layer (ADR 0010 — friendships, DMs,
 * profiles). The mobile mirror of the desktop renderer's social-queries.ts.
 *
 * Realtime events (friend.* / dm.created) keep these caches fresh; see
 * src/realtime/connection.ts. Every mutation also invalidates the relevant
 * caches so the acting client updates immediately even before the gateway
 * fan-out (W3) reaches it — the refetch fallback the plan requires (§5).
 *
 * Navigation differs from desktop: the desktop keeps the selected DM in a store
 * (`activeDmId`); mobile routes to a `/dm/[dmId]` screen instead, so `useOpenDm`
 * only opens/seeds the DM and returns it — the caller navigates in its own
 * onSuccess (mirrors the group-chat create pattern).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dm, GroupId, User, UserId } from "@demli/types";
import {
  getApi,
  type FriendRequestDirection,
  type SendFriendRequestInput,
} from "../lib/clients";
import type { DmWithPreview } from "../lib/dm-preview";
import { queryKeys } from "../lib/query-client";
import { resubscribeRealtime, sendChatMessage } from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The signed-in user's self record — the ONLY read that carries the private
 * `friendCode` (ADR 0010 §2). Seeded from the auth store; kept fresh on
 * regenerate. Backs the "Add friend" surface (show/copy/regenerate own code).
 */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => (await getApi().getMe()).user,
    initialData: () => useAuthStore.getState().user ?? undefined,
    // Treat the store-seeded record as already stale so the full self record —
    // the only one carrying `friendCode` (ADR 0010 §2, self-only /users/me) — is
    // fetched on mount; login/register responses may omit the code.
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  });
}

export function useFriends() {
  return useQuery({
    queryKey: queryKeys.friends,
    queryFn: async () => {
      const { friends } = await getApi().listFriends();
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
      const { requests } = await getApi().listFriendRequests(direction);
      useChatStore.getState().upsertUsers(requests.map((r) => r.user));
      return requests;
    },
  });
}

export function useDms() {
  return useQuery({
    queryKey: queryKeys.dms,
    // The API attaches a `lastMessagePreview` to each DM for the Home list; the
    // shared client types `/dms` as `Dm[]` (the domain type stays lean), so we
    // widen it here to the mobile-local `DmWithPreview` the rows consume.
    queryFn: async (): Promise<DmWithPreview[]> => {
      const { dms } = await getApi().listDms();
      useChatStore.getState().upsertUsers(dms.map((d) => d.participant));
      return dms as DmWithPreview[];
    },
  });
}

/**
 * Context-aware profile card. `groupId` scopes role visibility to a shared
 * server (undefined = no server context, so no roles). `enabled` gates the
 * fetch (typically the sheet being open) so we never fetch a card per avatar.
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
      const { profile } = await getApi().getUserProfile(userId, groupId);
      useChatStore.getState().upsertUsers([profile.user]);
      return profile;
    },
  });
}

// ---------------------------------------------------------------------------
// Friendship mutations
// ---------------------------------------------------------------------------

/** Invalidate every friendship-derived list (friends + both request directions). */
function invalidateFriendLists(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("incoming") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("outgoing") });
}

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendFriendRequestInput) => getApi().sendFriendRequest(input),
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
    mutationFn: (username: string) => getApi().sendFriendRequestByUsername(username),
    onSuccess: () => invalidateFriendLists(queryClient),
  });
}

export function useAcceptFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().acceptFriendRequest(userId),
    onSuccess: (_result, userId) => {
      invalidateFriendLists(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["profile", userId] });
    },
  });
}

/** Decline (addressee) or cancel (requester) a pending request. */
export function useRemoveFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().removeFriendRequest(userId),
    onSuccess: (_result, userId) => {
      invalidateFriendLists(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["profile", userId] });
    },
  });
}

export function useUnfriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().unfriend(userId),
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
 * Open (idempotently create) the DM with a friend. Seeds the DM list cache with
 * the returned participant-relative DTO, then re-handshakes the gateway so this
 * connection subscribes to the DM's stream channel — messages flow immediately
 * even before the W3 `dm.created` subscribe step reaches us (the handshake
 * subscription set is kind-agnostic, ADR 0010 §1). The caller navigates to the
 * DM screen in its own onSuccess (mobile routes rather than storing selection).
 */
export function useOpenDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().openDm(userId),
    onSuccess: ({ dm }) => {
      useChatStore.getState().upsertUsers([dm.participant]);
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) => {
        const rest = (list ?? []).filter((d) => d.id !== dm.id);
        return [dm, ...rest];
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
      resubscribeRealtime();
    },
  });
}

/**
 * Send ONE line to a user without leaving the current screen — the profile
 * screen's inline message box.
 *
 * Deliberately not `useOpenDm` + navigate: opening also switches the whole
 * surface, and the box exists precisely so you can fire off a message and stay
 * where you are (founder's reference). It still does the two things opening does
 * that matter here — seed the DM list so the new conversation appears at Home,
 * and re-handshake the gateway so this connection is subscribed to the DM's
 * stream and sees the echo.
 */
export function useSendDmMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, content }: { userId: UserId; content: string }) => {
      const { dm } = await getApi().openDm(userId);
      useChatStore.getState().upsertUsers([dm.participant]);
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) => {
        const rest = (list ?? []).filter((d) => d.id !== dm.id);
        return [dm, ...rest];
      });
      resubscribeRealtime();
      // The outbox owns delivery from here: queued offline, retried on
      // reconnect, and echoed back into the DM's own thread (M17).
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
    mutationFn: (dmId: GroupId) => getApi().hideDm(dmId),
    onSuccess: (_result, dmId) => {
      queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) =>
        (list ?? []).filter((d) => d.id !== dmId),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
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
    mutationFn: () => getApi().regenerateFriendCode(),
    onSuccess: ({ user }: { user: User }) => {
      queryClient.setQueryData(queryKeys.me, user);
      useAuthStore.getState().setUser(user);
    },
  });
}

// ---------------------------------------------------------------------------
// Custom status (M18) — mirrors the desktop renderer's hook
// ---------------------------------------------------------------------------

/**
 * Set or clear the caller's own custom status. On success the returned user is
 * written straight into the auth store + `me` cache + user directory, so the
 * You tab and the own profile card repaint without waiting for the round-trip
 * `user.custom_status_updated` event.
 *
 * A blank text routes to the CLEAR endpoint — "empty means clear" is decided once
 * in `buildCustomStatusInput`, so no caller has to remember it.
 */
export function useSetCustomStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string | null; expiresInMinutes?: number }) =>
      input.text === null || input.text.trim().length === 0
        ? getApi().clearCustomStatus()
        : getApi().setCustomStatus({ text: input.text, ...(input.expiresInMinutes !== undefined ? { expiresInMinutes: input.expiresInMinutes } : {}) }),
    onSuccess: ({ user }: { user: User }) => {
      queryClient.setQueryData(queryKeys.me, user);
      useAuthStore.getState().setUser(user);
      useChatStore.getState().upsertUsers([user]);
      useChatStore.getState().setCustomStatus(user.id, user.customStatus ?? null);
      void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    },
  });
}
