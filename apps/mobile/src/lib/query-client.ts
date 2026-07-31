/**
 * TanStack Query client + query-key factory (mirrors the desktop renderer's
 * lib/query-client.ts). The realtime glue (realtime/connection.ts) writes into
 * this cache; screens read it through the hooks in src/queries.
 */
import { QueryClient } from "@tanstack/react-query";
import type { ChannelId, GroupId, UserId } from "@demli/types";
import type { FriendRequestDirection } from "./clients";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime events keep the cache fresh; avoid speculative refetch storms.
      staleTime: 60_000,
      retry: 1,
      // No window focus on mobile; refetch on app foreground is a later concern.
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  groups: ["groups"] as const,
  groupDetails: (groupId: GroupId) => ["groups", "details", groupId] as const,
  /** Every flat group chat the user belongs to (ADR 0005 — distinct from servers). */
  groupChats: ["group-chats"] as const,
  groupChatDetails: (groupChatId: GroupId) => ["group-chats", "details", groupChatId] as const,
  /**
   * A group chat's live invite links (M18). Its own cache rather than a field on
   * the details query: minting or revoking a link must not refetch the roster,
   * and a roster change must not churn an open invite screen.
   */
  groupChatInvites: (groupChatId: GroupId) => ["group-chats", "invites", groupChatId] as const,
  /**
   * A server's channel categories in sidebar order (M18). Deliberately separate
   * from `groupDetails`, mirroring the desktop key factory: renaming a category
   * must not refetch every channel and member.
   */
  categories: (groupId: GroupId) => ["categories", groupId] as const,
  /** Prefix key matching every channel's message cache. */
  allMessages: ["messages"] as const,
  messages: (channelId: ChannelId) => ["messages", channelId] as const,
  /**
   * Channel full-text search results (ADR 0011 §5), keyed by channel + query.
   * Deliberately outside the `["messages", …]` prefix so a live-message
   * invalidation never churns an open search, and vice versa.
   */
  messageSearch: (channelId: ChannelId, query: string) =>
    ["message-search", channelId, query] as const,

  // --- Roles & permissions (ADR 0007 — servers only) ---
  /** Custom roles of a server, pre-sorted by position. */
  /**
   * A channel's pinned-message board (M17). Deliberately NOT under the
   * `["messages", …]` prefix: a live message invalidation must not churn an open
   * pin sheet, and pinning must not refetch the whole scrollback (§27).
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
   * means a URL refresh never invalidates the resolver map every message row reads.
   */
  customEmojiUrls: (groupId: GroupId) => ["custom-emoji-urls", groupId] as const,
  roles: (groupId: GroupId) => ["roles", groupId] as const,
  /** A channel's visibility role list (`[]` = public). */
  channelRoles: (channelId: ChannelId) => ["channel-roles", channelId] as const,

  // --- Social layer (ADR 0010) — mirrors the desktop renderer's key factory ---
  /** The signed-in user's self record (the only read carrying `friendCode`). */
  me: ["me"] as const,
  /** Accepted friends (+ the other user). */
  friends: ["friends"] as const,
  /** Pending friend requests, one cache per direction. */
  friendRequests: (direction: FriendRequestDirection) =>
    ["friends", "requests", direction] as const,
  /** The caller's open DMs. */
  dms: ["dms"] as const,
  /** The caller's notification mutes (seed for the store; realtime keeps it live). */
  notificationMutes: ["notification-mutes"] as const,
  /** The caller's cross-DM call history (Voice-UX #2), keyset-paged. */
  recentCalls: ["dm-calls", "recent"] as const,
  /** A context-aware profile card (bio + friendship + optional server roles). */
  profile: (userId: UserId, groupId?: GroupId) =>
    ["profile", userId, groupId ?? "none"] as const,
  /** The caller's own active login sessions (M15 — the "active sessions" screen). */
  sessions: ["sessions"] as const,

  // --- M18 / migration 0020 (ADR 0017 + 0019): blocks, notes, nicknames, ignores ---
  /** Everyone the CALLER has blocked. Never "who blocked me" — that is unqueryable (§28). */
  blocks: ["blocks"] as const,
  /**
   * The caller's PRIVATE note about one user (ADR 0019 §1). Its own key space,
   * deliberately not under `profile`, so a note can never be picked up
   * incidentally by a component rendering somebody else's card.
   */
  userNote: (userId: UserId) => ["user-note", userId] as const,
  /**
   * The caller's whole private-nickname map, fetched once and applied locally —
   * a private label must never ride along on a roster/message payload.
   */
  userNicknames: ["user-nicknames"] as const,
  /** Everyone the caller is ignoring (ADR 0019 §4 — an ignore is NOT a block). */
  ignores: ["ignores"] as const,
  /**
   * One server's moderation audit log (M18), keyset-paged. Same key shape as the
   * desktop renderer's, so the two clients invalidate the same thing.
   */
  moderationLog: (groupId: GroupId) => ["moderation-log", groupId] as const,

  // --- M20 Watch Party ---
  /**
   * Whether THIS deployment can search YouTube. A deployment constant, so it is
   * cached hard and shares the desktop renderer's key shape. Search RESULTS are
   * deliberately NOT a query key: they cost a unit of a shared daily budget and
   * must never be refetched by a focus/remount TanStack decides on its own — see
   * `queries/watch-queries.ts`.
   */
  watchCapabilities: ["watch", "capabilities"] as const,
};
