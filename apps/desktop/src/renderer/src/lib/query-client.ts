/**
 * Shared TanStack Query client + query-key factory. Realtime wiring
 * (src/realtime/connection.ts) writes into this cache; components read it
 * through the hooks in src/queries/.
 */

import { QueryClient } from "@tanstack/react-query";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import type { FriendRequestDirection } from "../lib/api-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime events keep the cache fresh; avoid speculative refetch storms.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  groups: ["groups"] as const,
  groupDetails: (groupId: GroupId) => ["groups", "details", groupId] as const,
  /** Flat group chats (ADR 0005) — the home surface. */
  groupChats: ["group-chats"] as const,
  groupChatDetails: (groupChatId: GroupId) =>
    ["group-chats", "details", groupChatId] as const,
  /** Prefix key matching every channel's message cache. */
  allMessages: ["messages"] as const,
  messages: (channelId: ChannelId) => ["messages", channelId] as const,
  /**
   * Channel full-text search results (ADR 0011 §5), keyed by channel + query.
   * Deliberately NOT under the `["messages", …]` prefix so a live-message
   * invalidation never churns an open search, and vice versa.
   */
  messageSearch: (channelId: ChannelId, query: string) =>
    ["message-search", channelId, query] as const,
  /**
   * A channel's pinned-message board (M17). Deliberately NOT under the
   * `["messages", …]` prefix: a live message invalidation must not churn an open
   * pin panel, and pinning must not refetch the whole scrollback (§27).
   */
  pins: (channelId: ChannelId) => ["pins", channelId] as const,
  /**
   * A group's custom emoji, metadata only (M17). One cache per group, because
   * `:name:` resolves against the message's OWN group — an emoji map is never
   * shared across groups.
   */
  customEmojis: (groupId: GroupId) => ["custom-emojis", groupId] as const,
  /**
   * Signed image URLs for a group's emoji (M17). Split from the metadata cache
   * because URLs EXPIRE (~1 h) while the metadata does not — keeping them apart
   * means a URL refresh never invalidates the resolver map that every message row
   * reads.
   */
  customEmojiUrls: (groupId: GroupId) => ["custom-emoji-urls", groupId] as const,
  /** Custom roles of a server (ADR 0007). */
  roles: (groupId: GroupId) => ["roles", groupId] as const,
  /** A channel's visibility role list (ADR 0007). */
  channelRoles: (channelId: ChannelId) => ["channel-roles", channelId] as const,

  // --- Social layer (ADR 0010) ---
  /** The signed-in user's self record (carries the private friendCode). */
  me: ["me"] as const,
  /** Accepted friends (+ the other user). */
  friends: ["friends"] as const,
  /** Pending friend requests, one cache per direction. */
  friendRequests: (direction: FriendRequestDirection) =>
    ["friends", "requests", direction] as const,
  /** The caller's open DMs. */
  dms: ["dms"] as const,
  /** The caller's notification mutes (channel/server mute, migration 0013). */
  notificationMutes: ["notification-mutes"] as const,
  /** The caller's cross-DM call history (Voice-UX #2), keyset-paged. */
  recentCalls: ["dm-calls", "recent"] as const,
  /** A context-aware profile card (bio + friendship + optional server roles). */
  profile: (userId: UserId, groupId?: GroupId) =>
    ["profile", userId, groupId ?? "none"] as const,
  /** The caller's own active login sessions (M15 — the "active sessions" screen). */
  sessions: ["sessions"] as const,

  // --- M18 (migration 0019, ADR 0017) ---
  /**
   * A server's sidebar categories. Deliberately its own cache rather than a field
   * on `groupDetails`: a category rename/reorder must not force a refetch of the
   * whole channel + member payload (§27).
   */
  categories: (groupId: GroupId) => ["categories", groupId] as const,
  /** Everyone the signed-in user has blocked (the settings list). */
  blocks: ["blocks"] as const,
  /** A server's moderation audit log, keyset-paged. */
  moderationLog: (groupId: GroupId) => ["moderation-log", groupId] as const,
  /** A flat group chat's invite links (ADR 0005 + M18). */
  groupChatInvites: (groupChatId: GroupId) =>
    ["group-chats", "invites", groupChatId] as const,

  /**
   * An invite code's peek preview (in-chat davet kartı). One cache per CODE so
   * the same link pasted in ten messages costs one request, not ten.
   */
  invitePreview: (code: string) => ["invite-preview", code] as const,

  // --- Migration 0020 / ADR 0019: notes, nicknames, ignores ---
  /**
   * The caller's PRIVATE note about one user. Its OWN key, never folded into
   * `profile`, because a note is single-reader (ADR 0019 §1) and a shared cache
   * entry is one refactor away from a component reading it out of a profile it
   * renders for someone else.
   */
  userNote: (userId: UserId) => ["user-note", userId] as const,
  /**
   * The caller's whole private-nickname map, fetched once and applied locally
   * (ADR 0019 §2). One cache, not one per user: name resolution runs on every
   * roster row and message author, so it must never be a per-row query.
   */
  userNicknames: ["user-nicknames"] as const,
  /**
   * The same private nicknames, but hydrated with the USER each one renames —
   * what the settings list needs (avatar, @username, the real name behind the
   * label) and what `userNicknames` deliberately throws away.
   *
   * A second key rather than a richer shape for the first: `userNicknames` is on
   * the hot name-resolution path and is patched in place by the rename mutation
   * so every surface repaints in the same frame. That patch cannot synthesize a
   * `User` for a nickname given to someone not yet in the cache, so folding the
   * two would trade a same-frame rename for a refetch. This key is fetched only
   * while the settings panel is open, and is invalidated wherever the map is
   * written (the rename mutation and `user.nickname_updated`).
   */
  userNicknameEntries: ["user-nickname-entries"] as const,
  /** Everyone the caller has ignored — drives both the settings list and the row fold. */
  ignores: ["ignores"] as const,
};
