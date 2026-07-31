/**
 * TanStack Query hooks behind the USER ACTION SHEET — mobile's long-press
 * equivalent of the desktop right-click menu (ADR 0017 blocks, ADR 0019 notes /
 * nicknames / timeouts / ignores, plus the migration-0017 moderation trio).
 *
 * Split out of social-queries / chat-queries on purpose: every hook here is
 * fetched ONLY while the sheet that needs it is open, so a roster of fifty rows
 * fires zero requests until somebody long-presses one (§27). Mirrors the desktop
 * renderer's hooks one-for-one — same endpoints, same invalidation sets — so the
 * two clients cannot drift on what a mutation refreshes.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import { blockChangeQueryKeys } from "../lib/block-sync";
import { getApi } from "../lib/clients";
import { queryKeys } from "../lib/query-client";
import { useChatStore } from "../stores/chat-store";

// ---------------------------------------------------------------------------
// Blocking (M18 / ADR 0017)
// ---------------------------------------------------------------------------

/**
 * Everyone the signed-in user has blocked. Deliberately NOT "who blocked me" —
 * that is never queryable, so no UI can ever reveal it (§28).
 */
export function useBlocks(enabled = true) {
  return useQuery({
    queryKey: queryKeys.blocks,
    enabled,
    queryFn: async () => {
      const { blocks } = await getApi().listBlocks();
      useChatStore.getState().upsertUsers(blocks.map((b) => b.user));
      return blocks;
    },
  });
}

/**
 * Invalidate everything a block flips. The key set is {@link blockChangeQueryKeys}
 * — shared with the `user.blocks_updated` realtime handler so a block lifted on
 * ANOTHER device refreshes exactly the same caches as one lifted here.
 */
function invalidateForBlockChange(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: UserId,
): void {
  for (const queryKey of blockChangeQueryKeys(userId)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** Block a user. Also ends the friendship / pending request in both directions. */
export function useBlockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().blockUser(userId),
    onSuccess: (_result, userId) => invalidateForBlockChange(queryClient, userId),
  });
}

/** Lift a block. Does NOT restore the friendship — that needs a new request. */
export function useUnblockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().unblockUser(userId),
    onSuccess: (_result, userId) => invalidateForBlockChange(queryClient, userId),
  });
}

// ---------------------------------------------------------------------------
// Private notes (ADR 0019 §1)
//
// SINGLE-READER data. These hooks are the only place in the app that ever
// touches a note, and the cache key is its own (`user-note`, never `profile`),
// so a note can never be picked up incidentally by a component rendering
// somebody else's card. Nothing here writes a note into the chat store, the
// user directory, or any shared projection.
// ---------------------------------------------------------------------------

/**
 * The caller's private note about `userId`. `enabled` is a hard gate, not an
 * optimization: the note editor passes `false` until it opens, so a note is
 * never fetched at all unless the viewer explicitly asked to see it.
 */
export function useUserNote(userId: UserId | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.userNote(userId ?? ("" as UserId)),
    queryFn: async () => (await getApi().getUserNote(userId as UserId)).note,
    enabled: enabled && userId !== null,
    staleTime: 60_000,
  });
}

/** Write or clear (`body: null`) the caller's private note about a user. */
export function useSetUserNote(userId: UserId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string | null) => getApi().setUserNote(userId as UserId, body),
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
 * `staleTime: Infinity` because the only thing that changes it is this client's
 * own mutation, which patches the cache directly.
 */
export function usePrivateNicknames() {
  return useQuery({
    queryKey: queryKeys.userNicknames,
    queryFn: async () => {
      const { nicknames } = await getApi().listUserNicknames();
      const map: Record<UserId, string> = {};
      for (const entry of nicknames) map[entry.user.id] = entry.nickname;
      return map;
    },
    staleTime: Infinity,
  });
}

/**
 * Set or clear the caller's private nickname for a user. The map cache is
 * patched on success so every surface reading it renames in the same frame,
 * without a refetch.
 */
export function useSetPrivateNickname(userId: UserId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nickname: string | null) => getApi().setUserNickname(userId as UserId, nickname),
    onSuccess: ({ nickname }) => {
      if (!userId) return;
      queryClient.setQueryData<Record<UserId, string>>(queryKeys.userNicknames, (prev) => {
        const next = { ...(prev ?? {}) };
        if (nickname) next[userId] = nickname;
        else delete next[userId];
        return next;
      });
    },
  });
}

/**
 * Set (or clear with `null`) a member's PER-SERVER nickname — the one everyone
 * in the server sees (ADR 0019 §2). Renaming YOURSELF needs no permission;
 * renaming anyone else needs owner ∨ MANAGE_NICKNAMES and the API refuses to
 * rename the owner. Distinct from {@link useSetPrivateNickname}, which is the
 * viewer-only label; conflating the two would publish a private name to a whole
 * server.
 */
export function useSetMemberNickname(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; nickname: string | null }) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().setMemberNickname(groupId, input.userId, input.nickname);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Ignores (ADR 0019 §4) — NOT blocks
//
// One-directional and silent: nothing is refused, nothing is hidden
// server-side, and the ignored user is never told. What changes is that the
// server stops sending the ignorer notifications.
// ---------------------------------------------------------------------------

/** Everyone the caller is ignoring. */
export function useIgnores(enabled = true) {
  return useQuery({
    queryKey: queryKeys.ignores,
    enabled,
    queryFn: async () => (await getApi().listIgnores()).ignores,
    staleTime: Infinity,
  });
}

/** `userId → true` for every ignored user — the shape a row fold reads. */
export function useIgnoredUserIds(): Set<UserId> {
  const { data } = useIgnores();
  return useMemo(() => new Set((data ?? []).map((entry) => entry.user.id)), [data]);
}

/** Start ignoring a user (idempotent server-side; they are never told). */
export function useIgnoreUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().ignoreUser(userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.ignores }),
  });
}

/** Stop ignoring a user. No history to restore — nothing was hidden (ADR 0019 §4). */
export function useUnignoreUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => getApi().unignoreUser(userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.ignores }),
  });
}

// ---------------------------------------------------------------------------
// Moderation (migration 0017 + ADR 0019 §3) — owner ∨ KICK_MEMBERS, never the
// server owner, never yourself. Every guard is re-checked server-side; these
// hooks only carry the request and refresh what changed.
// ---------------------------------------------------------------------------

/** Remove a member from a server. They can return through a fresh invite. */
export function useKickMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().kickMember(groupId, userId);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/** Kick PLUS a permanent block, so no invite can bring them back. */
export function useBanMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; reason?: string }) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().banMember(groupId, input.userId, input.reason);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Time a member out for a number of minutes. While it holds they cannot send
 * messages, react, or join voice IN THIS SERVER — all enforced server-side on
 * both transports; this mutation only records the state.
 */
export function useTimeoutMember(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: UserId; minutes: number; reason?: string }) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().timeoutMember(groupId, input.userId, {
        minutes: input.minutes,
        reason: input.reason,
      });
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/** Lift a timeout early (same permission). */
export function useRemoveMemberTimeout(groupId: GroupId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!groupId) throw new Error("no group selected");
      return getApi().removeMemberTimeout(groupId, userId);
    },
    onSuccess: async () => {
      if (groupId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
      }
    },
  });
}

/**
 * Force-disconnect a user from a voice channel WITHOUT removing them from the
 * server. No cache write needed — the gateway's `voice.participant_*` fan-out
 * removes the row for everyone. Not a ban: they can rejoin.
 */
export function useDisconnectFromVoice(channelId: ChannelId | null) {
  return useMutation({
    mutationFn: (userId: UserId) => {
      if (!channelId) throw new Error("no channel selected");
      return getApi().disconnectFromVoice(channelId, userId);
    },
  });
}
