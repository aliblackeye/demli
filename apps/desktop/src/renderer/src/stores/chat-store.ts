/**
 * Chat client-state store (Milestone 2b — real backend).
 *
 * Server state (groups, channels, members, messages) lives in TanStack Query
 * (src/queries/). This store owns only what the server does not:
 *
 * - selection (active group/channel, last channel per group)
 * - unread flags
 * - realtime-fed volatile state: connection status, presence, typing
 * - a user directory cache (authors of messages, fed from group details)
 * - the optimistic send outbox (pending/failed messages, reconciled by nonce)
 *
 * Presence/typing live here — NOT in query caches — so presence ticks never
 * rerender the message list (CLAUDE.md §27); only components that select
 * `presence`/`typing` update.
 */

import { create } from "zustand";
import type {
  Attachment,
  AttachmentId,
  Channel,
  ChannelId,
  DmId,
  GroupId,
  MessageId,
  MessageKind,
  MessageReplyPreview,
  NotificationMuteMode,
  NotificationMuteScope,
  PresencePlatform,
  PresenceStatus,
  User,
  UserId,
} from "@demli/types";
import { isChatCapableChannel } from "@demli/types";
import type { OutboxErrorKey } from "@demli/client-core";
import type { RealtimeStatus } from "../lib/realtime-client";
import { loadUnreadMarkers, saveUnreadMarkers, type UnreadMarkers } from "../lib/unread-storage";

/**
 * How a not-yet-confirmed message is rendering.
 * - `queued`  — waiting for a connection, or waiting its turn in the drain. The
 *   resting state while offline; it SURVIVES a restart.
 * - `sending` — dispatched to the gateway, awaiting the `message.created` echo.
 * - `failed`  — out of attempts, rejected, or its channel is gone. Only a user
 *   action (retry / discard) leaves this state.
 *
 * Mirrors `OutboxStatus` in @demli/client-core: the persistent queue
 * controller is the single authority and this store only mirrors what it
 * publishes.
 */
export type DeliveryState = "queued" | "sending" | "failed";

/**
 * Cap on how many channels keep a persisted read watermark. localStorage is
 * roomy, but an unbounded map would still grow forever; evicting the least
 * recently updated channel past this bound is harmless — a pruned channel simply
 * shows no divider until its next visit re-seeds it.
 */
const MAX_TRACKED_CHANNELS = 500;

/** Optimistic-outbox ids never become a durable read watermark. */
const OUTBOX_ID_PREFIX = "outbox-";

/**
 * Move `channelId` to the most-recent position and drop the oldest entries past
 * {@link MAX_TRACKED_CHANNELS}. Object key order is insertion order, so deleting
 * and re-adding the touched channel gives a cheap LRU.
 */
function boundMarkers(current: UnreadMarkers, channelId: string, messageId: string): UnreadMarkers {
  const next: UnreadMarkers = {};
  for (const [id, value] of Object.entries(current)) {
    if (id !== channelId) next[id] = value;
  }
  next[channelId] = messageId;
  const keys = Object.keys(next);
  if (keys.length <= MAX_TRACKED_CHANNELS) return next;
  const trimmed: UnreadMarkers = {};
  for (const id of keys.slice(keys.length - MAX_TRACKED_CHANNELS)) trimmed[id] = next[id]!;
  return trimmed;
}

/**
 * The message a pending composer send will quote (ADR 0011 §2). A lean snapshot
 * of the target — enough to render the composer banner and the optimistic
 * outbox row's quote before the server echo carries the built preview. The
 * author *name* is resolved from the `users` directory by `authorId` at render.
 */
export interface ReplyDraft {
  messageId: MessageId;
  authorId: UserId;
  /** Target content, already sliced to REPLY_PREVIEW_MAX. Blank for a deleted target. */
  content: string;
  kind: MessageKind;
}

/**
 * An optimistic message that has not (yet) been confirmed by the server.
 *
 * PROJECTION, NOT STATE (M17): the authority is the persistent queue controller
 * in realtime/outbox.ts; this store holds only the render-ready view that
 * controller publishes, joined with the extras below (which are deliberately
 * never persisted — blob URLs die on reload).
 */
export interface OutboxMessage {
  /** Client-generated id; the server echoes it on message.created. */
  nonce: string;
  channelId: ChannelId;
  authorId: UserId;
  content: string;
  createdAt: string;
  deliveryState: DeliveryState;
  /**
   * Why the send is stuck, as a KEY — never a message. The row localizes it at
   * render, so a live locale switch re-renders the reason and client-core stays
   * i18n-free (ADR 0009).
   */
  errorKey: OutboxErrorKey | null;
  /**
   * Attachment metadata (ADR 0008) linked to this send, so the optimistic row
   * renders tiles while the message.created echo is pending. Omitted for
   * text-only sends.
   */
  attachments?: Attachment[];
  /** attachmentId → local blob: URL, so the optimistic tiles show our own bytes. */
  localAttachmentUrls?: Record<AttachmentId, string>;
  /**
   * Reply preview (ADR 0011 §2) so the optimistic row renders its quote before
   * the server echo (which carries the authoritative built preview) lands.
   * Omitted for non-reply sends.
   */
  replyTo?: MessageReplyPreview;
}

/**
 * Which top-level surface the shell shows:
 * - `"server"` — a multi-channel server (GroupRail server button): ChannelSidebar
 *   + channel ChatView.
 * - `"home"` — the direct surface (GroupRail home button): the HomeSidebar
 *   (friends + DMs + flat group chats) and a friends table, DM, or group chat.
 */
export type ActiveView = "server" | "home";

/** A local mirror of one notification mute (migration 0013), keyed `${scope}:${targetId}`. */
export interface MuteEntry {
  mode: NotificationMuteMode;
  /** ISO auto-expiry instant, or null for indefinite. */
  until: string | null;
}

/** Composite key for the mute lookup so channel and group mutes never collide. */
export function muteKey(scope: NotificationMuteScope, targetId: string): string {
  return `${scope}:${targetId}`;
}

/**
 * Immutably drop a stream's unread count. Returns the SAME reference when there
 * is nothing to clear, so reading/opening an already-read stream never allocates
 * a new map (no needless badge re-render, §27).
 */
function clearCount(
  counts: Record<ChannelId, number>,
  streamId: ChannelId,
): Record<ChannelId, number> {
  if (!(streamId in counts)) return counts;
  const { [streamId]: _removed, ...rest } = counts;
  return rest;
}

/** True when `entry` is an ACTIVE mute (present and not past its `until`). */
function muteActive(entry: MuteEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return entry.until === null || new Date(entry.until).getTime() > now;
}

/** The active mute mode on a single target, or null when not muted / expired. */
export function muteModeFor(
  mutes: Record<string, MuteEntry>,
  scope: NotificationMuteScope,
  targetId: string,
  now: number = Date.now(),
): NotificationMuteMode | null {
  const entry = mutes[muteKey(scope, targetId)];
  return muteActive(entry, now) ? entry!.mode : null;
}

/**
 * The EFFECTIVE mute mode on a channel: its own channel mute wins over the
 * enclosing group's mute (most specific), each expiry-checked. null = not muted.
 */
export function channelMuteModeFor(
  mutes: Record<string, MuteEntry>,
  channelId: string,
  groupId: string | null,
  now: number = Date.now(),
): NotificationMuteMode | null {
  const own = muteModeFor(mutes, "channel", channelId, now);
  if (own !== null) return own;
  return groupId ? muteModeFor(mutes, "group", groupId, now) : null;
}

/**
 * Whether a stream (server text channel, DM, or flat group-chat) should show an
 * unread badge, applying the same mute rule ChannelItem uses so every surface
 * (channel sidebar, DM/group rows, group rail) stays consistent (migration 0013):
 *   - unmuted           → badge whenever the stream is unread;
 *   - "mentions"-muted  → badge only when the unread includes a direct @mention;
 *   - "all"-muted       → never.
 * The unread FLAG itself is always tracked in the store (so a mentions-muted
 * stream can still surface a mention pip); this is purely the display gate. Pass
 * the enclosing server groupId for a channel so a group-level mute is honored;
 * DMs and flat group-chats pass null (no enclosing server).
 */
export function streamUnreadVisible(
  maps: {
    unreadChannelIds: Record<ChannelId, boolean>;
    mentionUnreadChannelIds: Record<ChannelId, boolean>;
    notificationMutes: Record<string, MuteEntry>;
  },
  streamId: ChannelId,
  groupId: GroupId | null = null,
  now: number = Date.now(),
): boolean {
  if (!maps.unreadChannelIds[streamId]) return false;
  const mode = channelMuteModeFor(maps.notificationMutes, streamId, groupId, now);
  if (mode === null) return true;
  if (mode === "mentions") return Boolean(maps.mentionUnreadChannelIds[streamId]);
  return false;
}

/**
 * Which sub-surface the "home" (direct) view shows (ADR 0010 §5):
 * - `"friends"`     — the friends table (Online / All / Pending / Add).
 * - `"recentCalls"` — the cross-DM call history (Voice-UX #2).
 * - `"groupChat"`   — a flat group chat conversation (ADR 0005).
 * - `"dm"`          — a 1:1 direct-message conversation.
 * Only meaningful while `activeView === "home"`.
 */
export type HomeView = "friends" | "recentCalls" | "groupChat" | "dm";

interface ChatStore {
  // Selection ---------------------------------------------------------------
  /** Server-vs-home surface toggle (GroupRail). */
  activeView: ActiveView;
  /** Which home sub-surface shows while `activeView === "home"`. */
  homeView: HomeView;
  activeGroupId: GroupId | null;
  /** Selected flat group chat while `homeView === "groupChat"`. */
  activeGroupChatId: GroupId | null;
  /** Selected DM while `homeView === "dm"` (ADR 0010). */
  activeDmId: DmId | null;
  activeChannelId: ChannelId | null;
  lastChannelByGroup: Record<GroupId, ChannelId>;
  memberSidebarOpen: boolean;
  unreadChannelIds: Record<ChannelId, boolean>;
  /**
   * streamId → count of unread messages accumulated THIS session (#110). Bumped
   * for every background message on a non-active stream; reset to 0 when the
   * stream is read/opened. Session-only (never persisted) so a cold start can
   * only ever undercount — the badge then honestly falls back to "1+" (see
   * `unreadBadgeText`) rather than inventing a number. Parallel to
   * `unreadChannelIds` so the boolean pip/dim logic is untouched.
   */
  unreadCounts: Record<ChannelId, number>;
  /**
   * channelId → true when the channel's unread includes a direct @mention of us.
   * Lets a "mentions"-muted channel still surface a badge for mentions while the
   * plain unread pip is suppressed. Cleared whenever the channel is read.
   */
  mentionUnreadChannelIds: Record<ChannelId, boolean>;
  /**
   * Local mirror of the caller's notification mutes (migration 0013), keyed by
   * {@link muteKey}. Seeded from `GET /notification-mutes`, kept live by the
   * `notification_mute.updated` event and the set/clear mutations. Read O(1) by
   * ChannelItem / GroupRail so a mute never triggers a list refetch to paint.
   */
  notificationMutes: Record<string, MuteEntry>;
  /**
   * channelId → id of the newest message the user had seen the last time the
   * channel was open. Positions the in-thread "New Messages" divider and is
   * persisted locally (lib/unread-storage). Read imperatively (never via a
   * reactive selector) so advancing it can't rerender the message list (§27).
   */
  lastReadMessageId: Record<ChannelId, MessageId>;

  // Realtime-fed ------------------------------------------------------------
  connectionStatus: RealtimeStatus;
  presence: Record<UserId, PresenceStatus>;
  /**
   * userId → dominant client kind (task #47). Parallel to `presence` so the
   * existing status reads are untouched; a user with no reported platform simply
   * has no entry. Drives the mobile phone indicator on the presence badge.
   */
  presencePlatforms: Record<UserId, PresencePlatform>;
  /**
   * userId → live custom status line (M18), or absent when they have none. Kept
   * PARALLEL to `presence` (rather than folded into the user directory) for the
   * same reason presence is: it is a realtime-fed, high-churn value, and the
   * gateway ships it on every presence broadcast. A user with no status simply has
   * no entry. Plain text — escaped at render (§28).
   */
  customStatuses: Record<UserId, string>;
  /** channelId → userId → typing-entry expiry (epoch ms). */
  typing: Record<ChannelId, Record<UserId, number>>;
  /** Directory of every user we have seen (group members, self). */
  users: Record<UserId, User>;

  // Optimistic sends ----------------------------------------------------------
  outbox: Record<ChannelId, OutboxMessage[]>;

  /**
   * Per-channel reply target (ADR 0011 §2): the message the composer will quote,
   * or absent when not replying. Scoped by channel so switching channels keeps
   * each composer's reply context independent (and never leaks across them).
   */
  replyTargets: Record<ChannelId, ReplyDraft>;

  /**
   * Slow-mode cooldowns: channelId → epoch-ms the user may send again. Fed by
   * the gateway's SLOWMODE error (or a REST 429); the composer counts it down
   * and clears it when it elapses. Not persisted — a fresh cooldown replaces it.
   */
  slowmodeCooldownUntil: Record<ChannelId, number>;

  // Actions -------------------------------------------------------------------
  setActiveGroup: (groupId: GroupId) => void;
  /** Switch to a server surface and select the group (GroupRail / command menu). */
  openServer: (groupId: GroupId) => void;
  /** Switch to the home (direct) surface, preserving the last home sub-view. */
  openHome: () => void;
  /** Switch to the home surface and show the friends table (ADR 0010). */
  openFriends: () => void;
  /** Switch to the home surface and show the recent-calls history (Voice-UX #2). */
  openRecentCalls: () => void;
  /** Open a specific flat group chat; routes messages by its `streamId`. */
  openGroupChat: (input: { id: GroupId; streamId: ChannelId }) => void;
  /** Open a 1:1 DM conversation; routes messages by its `streamId` (ADR 0010). */
  openDm: (input: { id: DmId; streamId: ChannelId }) => void;
  /** Drop the current DM selection (e.g. after hiding it); returns to friends. */
  clearActiveDm: () => void;
  /**
   * Point the message pipeline at a group chat's stream channel (marks it read).
   * Keeps `lastChannelByGroup` untouched — a group's hidden stream is not a
   * user-selectable channel.
   */
  setActiveStream: (streamId: ChannelId) => void;
  /** Drop the current group-chat selection (e.g. after leaving it). */
  clearActiveGroupChat: () => void;
  /**
   * Drop a dangling server selection — used when the active server disappears
   * (left / deleted / auto-pruned) and no server remains to fall back to. On the
   * server surface it also routes home so we never keep rendering a server the
   * user is no longer in (task #49).
   */
  dropServerSelection: () => void;
  setActiveChannel: (channel: Channel) => void;
  /**
   * Remember which channel a server should open on, WITHOUT selecting it yet.
   *
   * Exists for the one case where the target is known before the channel object
   * is: redeeming a channel invite. The joiner has an id and a name but the
   * server's channel list has not loaded, so `setActiveChannel` (which needs a
   * real `Channel`) cannot be called. Seeding the memory instead lets the normal
   * reconciliation — `ensureChannelSelection`, which already prefers
   * `lastChannelByGroup` — land them there the moment the details arrive.
   *
   * Never touches the voice engine: a voice channel is SELECTED, so its chat
   * opens and the join stays an explicit second gesture (§11).
   */
  rememberChannelForGroup: (groupId: GroupId, channelId: ChannelId) => void;
  /** Reconcile the active channel against the active group's real channels. */
  ensureChannelSelection: (channels: Channel[]) => void;
  markChannelRead: (channelId: ChannelId) => void;
  markChannelUnread: (channelId: ChannelId) => void;
  /** Flag that the channel's unread came from a direct @mention (mentions-mute badge). */
  markChannelMentionUnread: (channelId: ChannelId) => void;

  /** Replace the whole mute mirror (seed from `GET /notification-mutes`). */
  replaceNotificationMutes: (
    mutes: { scope: NotificationMuteScope; targetId: string; mode: NotificationMuteMode; until: string | null }[],
  ) => void;
  /** Upsert one mute (from the mutation echo or the `notification_mute.updated` event). */
  setLocalMute: (scope: NotificationMuteScope, targetId: string, entry: MuteEntry) => void;
  /** Drop one mute (unmute). */
  clearLocalMute: (scope: NotificationMuteScope, targetId: string) => void;
  /**
   * Advance a channel's read watermark to `messageId` (the newest message seen
   * while it was open) and persist it. No-op for an unchanged or synthetic
   * (outbox) id. The message list freezes the divider position from the value
   * captured at channel-open, so advancing here never moves the current divider.
   */
  setChannelReadMarker: (channelId: ChannelId, messageId: MessageId) => void;
  toggleMemberSidebar: () => void;

  setConnectionStatus: (status: RealtimeStatus) => void;
  replacePresence: (
    entries: {
      userId: UserId;
      status: PresenceStatus;
      platform?: PresencePlatform;
      customStatus?: string | null;
    }[],
  ) => void;
  setPresence: (
    userId: UserId,
    status: PresenceStatus,
    platform?: PresencePlatform,
    customStatus?: string | null,
  ) => void;
  /**
   * Set (or clear with `null`) one user's custom status line. Separate from
   * {@link setPresence} because `user.custom_status_updated` carries no status
   * dot — folding it into a presence write would have to invent one.
   */
  setCustomStatus: (userId: UserId, text: string | null) => void;
  setTyping: (channelId: ChannelId, userId: UserId, expiresAt: number) => void;
  clearTyping: (channelId: ChannelId, userId: UserId) => void;
  /** Drop expired typing entries; no-op state-wise when nothing expired. */
  pruneTyping: (now: number) => void;
  upsertUsers: (users: User[]) => void;

  /** Set (or replace) the channel's reply target — the composer shows a banner. */
  setReplyTarget: (channelId: ChannelId, draft: ReplyDraft) => void;
  /** Clear a channel's reply target (cancel button, after send, or channel gone). */
  clearReplyTarget: (channelId: ChannelId) => void;

  /**
   * Mirror the persistent queue's latest projection (realtime/outbox.ts). The
   * ONLY writer of `outbox` — nothing else may mutate it, so the controller and
   * the UI can never disagree about what is still unsent.
   */
  syncOutbox: (outbox: Record<ChannelId, OutboxMessage[]>) => void;

  /** Arm a slow-mode cooldown of `seconds` for a channel (from a SLOWMODE error). */
  startSlowmodeCooldown: (channelId: ChannelId, seconds: number) => void;
  /** Drop a channel's cooldown once it has elapsed (composer calls this). */
  clearSlowmodeCooldown: (channelId: ChannelId) => void;

  /** Full reset on logout. */
  resetChatState: () => void;
}

const initialState = {
  activeView: "server" as ActiveView,
  homeView: "friends" as HomeView,
  activeGroupId: null,
  activeGroupChatId: null,
  activeDmId: null,
  activeChannelId: null,
  lastChannelByGroup: {},
  memberSidebarOpen: true,
  unreadChannelIds: {},
  unreadCounts: {} as Record<ChannelId, number>,
  mentionUnreadChannelIds: {},
  notificationMutes: {},
  // Seed the divider watermarks synchronously from localStorage so the very first
  // channel opened after launch already knows where "new" begins.
  lastReadMessageId: loadUnreadMarkers() as Record<ChannelId, MessageId>,
  connectionStatus: "idle" as RealtimeStatus,
  presence: {},
  presencePlatforms: {},
  customStatuses: {},
  typing: {},
  users: {},
  outbox: {},
  replyTargets: {},
  slowmodeCooldownUntil: {},
};

/**
 * The channel a server opens on when nothing valid is selected. Deliberately
 * TEXT-only even though voice channels now carry a chat (M20): landing a user
 * inside a voice channel's chat by default would put the "join voice" affordance
 * in front of them before they asked for it, and #general is what a server means
 * by "the front door". Voice channels become the active channel only when the
 * user picks one, or when one is restored from `lastChannelByGroup`.
 */
function firstTextChannel(channels: Channel[]): Channel | undefined {
  return channels
    .filter((c) => c.kind === "text")
    .sort((a, b) => a.position - b.position)[0];
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,

  setActiveGroup: (groupId) => {
    const { activeGroupId, lastChannelByGroup } = get();
    if (groupId === activeGroupId) return;
    set({
      activeGroupId: groupId,
      // Provisional — ensureChannelSelection validates it once details load.
      activeChannelId: lastChannelByGroup[groupId] ?? null,
    });
  },

  openServer: (groupId) => {
    set({ activeView: "server" });
    get().setActiveGroup(groupId);
  },

  openHome: () => set({ activeView: "home" }),

  openFriends: () => set({ activeView: "home", homeView: "friends" }),

  openRecentCalls: () => set({ activeView: "home", homeView: "recentCalls" }),

  openGroupChat: ({ id, streamId }) =>
    set((state) => ({
      activeView: "home",
      homeView: "groupChat",
      activeGroupChatId: id,
      activeChannelId: streamId,
      unreadChannelIds: { ...state.unreadChannelIds, [streamId]: false },
      unreadCounts: clearCount(state.unreadCounts, streamId),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [streamId]: false },
    })),

  openDm: ({ id, streamId }) =>
    set((state) => ({
      activeView: "home",
      homeView: "dm",
      activeDmId: id,
      activeChannelId: streamId,
      unreadChannelIds: { ...state.unreadChannelIds, [streamId]: false },
      unreadCounts: clearCount(state.unreadCounts, streamId),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [streamId]: false },
    })),

  clearActiveDm: () => set({ activeDmId: null, homeView: "friends" }),

  setActiveStream: (streamId) =>
    set((state) => ({
      activeChannelId: streamId,
      unreadChannelIds: { ...state.unreadChannelIds, [streamId]: false },
      unreadCounts: clearCount(state.unreadCounts, streamId),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [streamId]: false },
    })),

  clearActiveGroupChat: () => set({ activeGroupChatId: null, homeView: "friends" }),

  dropServerSelection: () =>
    set((state) =>
      state.activeView === "server"
        ? { activeGroupId: null, activeChannelId: null, activeView: "home" }
        : { activeGroupId: null },
    ),

  setActiveChannel: (channel) => {
    // M20: a VOICE channel is a legal chat target — every voice channel carries
    // its own text chat, and opening it is a pure READ action.
    // Joining the room is a separate, explicit gesture (ChannelItem's join
    // control / the command menu), so selecting a voice channel here must never
    // touch the voice engine. The gate stays (rather than being deleted) so a
    // future non-chat channel kind still fails closed, exactly like the four
    // server-side write gates that ask this same shared question.
    if (!isChatCapableChannel(channel.kind)) return;
    set((state) => ({
      activeView: "server",
      activeChannelId: channel.id,
      activeGroupId: channel.groupId,
      lastChannelByGroup: { ...state.lastChannelByGroup, [channel.groupId]: channel.id },
      unreadChannelIds: { ...state.unreadChannelIds, [channel.id]: false },
      unreadCounts: clearCount(state.unreadCounts, channel.id),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [channel.id]: false },
    }));
  },

  rememberChannelForGroup: (groupId, channelId) => {
    set((state) => ({
      lastChannelByGroup: { ...state.lastChannelByGroup, [groupId]: channelId },
      // Apply it immediately when that server is already the active one, so the
      // landing does not wait for a group switch that will never happen.
      activeChannelId:
        state.activeGroupId === groupId ? channelId : state.activeChannelId,
    }));
  },

  ensureChannelSelection: (channels) => {
    const { activeChannelId, lastChannelByGroup, activeGroupId } = get();
    // Keep ANY chat-capable selection the user made — including a voice channel
    // (M20). Matching on `kind === "text"` here would have yanked a deliberately
    // opened voice chat back to #general the moment group details refetched.
    const current = channels.find(
      (c) => c.id === activeChannelId && isChatCapableChannel(c.kind),
    );
    if (current) return;
    const remembered = activeGroupId
      ? channels.find(
          (c) =>
            c.id === lastChannelByGroup[activeGroupId] && isChatCapableChannel(c.kind),
        )
      : undefined;
    const next = remembered ?? firstTextChannel(channels);
    if (next) {
      get().setActiveChannel(next);
    } else if (activeChannelId !== null) {
      set({ activeChannelId: null });
    }
  },

  markChannelRead: (channelId) => {
    set((state) => ({
      unreadChannelIds: { ...state.unreadChannelIds, [channelId]: false },
      unreadCounts: clearCount(state.unreadCounts, channelId),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [channelId]: false },
    }));
  },

  markChannelUnread: (channelId) => {
    // The COUNT must advance on EVERY background message (that is what the badge
    // shows), so — unlike the boolean flag — there is no early-return here.
    set((state) => ({
      unreadChannelIds: { ...state.unreadChannelIds, [channelId]: true },
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  markChannelMentionUnread: (channelId) => {
    if (get().mentionUnreadChannelIds[channelId]) return;
    set((state) => ({
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [channelId]: true },
    }));
  },

  replaceNotificationMutes: (mutes) => {
    const next: Record<string, MuteEntry> = {};
    for (const m of mutes) next[muteKey(m.scope, m.targetId)] = { mode: m.mode, until: m.until };
    set({ notificationMutes: next });
  },

  setLocalMute: (scope, targetId, entry) => {
    set((state) => ({
      notificationMutes: { ...state.notificationMutes, [muteKey(scope, targetId)]: entry },
    }));
  },

  clearLocalMute: (scope, targetId) => {
    const key = muteKey(scope, targetId);
    if (!(key in get().notificationMutes)) return;
    set((state) => {
      const { [key]: _removed, ...rest } = state.notificationMutes;
      return { notificationMutes: rest };
    });
  },

  setChannelReadMarker: (channelId, messageId) => {
    if (!messageId || messageId.startsWith(OUTBOX_ID_PREFIX)) return;
    const current = get().lastReadMessageId;
    if (current[channelId] === messageId) return;
    const next = boundMarkers(current, channelId, messageId) as Record<ChannelId, MessageId>;
    set({ lastReadMessageId: next });
    saveUnreadMarkers(next);
  },

  toggleMemberSidebar: () =>
    set((state) => ({ memberSidebarOpen: !state.memberSidebarOpen })),

  setConnectionStatus: (status) => {
    if (get().connectionStatus !== status) set({ connectionStatus: status });
  },

  replacePresence: (entries) => {
    const presence: Record<UserId, PresenceStatus> = {};
    const presencePlatforms: Record<UserId, PresencePlatform> = {};
    const customStatuses: Record<UserId, string> = {};
    for (const entry of entries) {
      presence[entry.userId] = entry.status;
      if (entry.platform) presencePlatforms[entry.userId] = entry.platform;
      if (entry.customStatus) customStatuses[entry.userId] = entry.customStatus;
    }
    set({ presence, presencePlatforms, customStatuses });
  },

  setPresence: (userId, status, platform, customStatus) => {
    const state = get();
    // `customStatus` is OPTIONAL on the wire: a payload built by a client (or a
    // pre-M18 peer) omits it entirely, and treating "absent" as "cleared" would
    // wipe a status every time such a payload arrived. Only an explicitly present
    // field (string or null) writes.
    const statusLine = customStatus === undefined ? undefined : (customStatus ?? null);
    const customUnchanged =
      statusLine === undefined || (state.customStatuses[userId] ?? null) === statusLine;

    // Short-circuit only when status, platform AND the custom line are unchanged,
    // so a desktop⇄mobile switch at the same status still repaints the badge.
    if (
      state.presence[userId] === status &&
      state.presencePlatforms[userId] === platform &&
      customUnchanged
    ) {
      return;
    }

    const presencePlatforms = { ...state.presencePlatforms };
    if (platform) presencePlatforms[userId] = platform;
    else delete presencePlatforms[userId];

    let customStatuses = state.customStatuses;
    if (!customUnchanged) {
      customStatuses = { ...state.customStatuses };
      if (statusLine) customStatuses[userId] = statusLine;
      else delete customStatuses[userId];
    }

    set({
      presence: { ...state.presence, [userId]: status },
      presencePlatforms,
      customStatuses,
    });
  },

  setCustomStatus: (userId, text) => {
    const state = get();
    const next = text && text.length > 0 ? text : null;
    if ((state.customStatuses[userId] ?? null) === next) return;
    const customStatuses = { ...state.customStatuses };
    if (next) customStatuses[userId] = next;
    else delete customStatuses[userId];
    set({ customStatuses });
  },

  setTyping: (channelId, userId, expiresAt) => {
    set((state) => ({
      typing: {
        ...state.typing,
        [channelId]: { ...state.typing[channelId], [userId]: expiresAt },
      },
    }));
  },

  clearTyping: (channelId, userId) => {
    const channelTyping = get().typing[channelId];
    if (!channelTyping || !(userId in channelTyping)) return;
    set((state) => {
      const { [userId]: _removed, ...rest } = state.typing[channelId] ?? {};
      return { typing: { ...state.typing, [channelId]: rest } };
    });
  },

  pruneTyping: (now) => {
    const { typing } = get();
    let changed = false;
    const next: ChatStore["typing"] = {};
    for (const [channelId, entries] of Object.entries(typing)) {
      const kept: Record<UserId, number> = {};
      for (const [userId, expiresAt] of Object.entries(entries)) {
        if (expiresAt > now) kept[userId] = expiresAt;
        else changed = true;
      }
      next[channelId] = kept;
    }
    if (changed) set({ typing: next });
  },

  upsertUsers: (incoming) => {
    const { users } = get();
    let changed = false;
    const next = { ...users };
    for (const user of incoming) {
      const existing = next[user.id];
      // Compare EVERY public profile field, not just the ones the message list
      // paints: `user.updated` also carries bio/banner edits, and dropping them
      // here would leave the profile card stale while the roster looked correct.
      if (
        !existing ||
        existing.displayName !== user.displayName ||
        existing.username !== user.username ||
        existing.avatarUrl !== user.avatarUrl ||
        existing.bio !== user.bio ||
        existing.bannerUrl !== user.bannerUrl
      ) {
        next[user.id] = user;
        changed = true;
      }
    }
    if (changed) set({ users: next });
  },

  setReplyTarget: (channelId, draft) => {
    set((state) => ({ replyTargets: { ...state.replyTargets, [channelId]: draft } }));
  },

  clearReplyTarget: (channelId) => {
    if (!(channelId in get().replyTargets)) return;
    set((state) => {
      const { [channelId]: _removed, ...rest } = state.replyTargets;
      return { replyTargets: rest };
    });
  },

  syncOutbox: (outbox) => {
    // The projection preserves per-channel array identity for untouched
    // channels, so this assignment does not re-render a message list whose own
    // queue did not change (§27). Blob-URL revocation moved with the meta map
    // into realtime/outbox.ts — the store no longer owns any send lifecycle.
    if (get().outbox === outbox) return;
    set({ outbox });
  },

  startSlowmodeCooldown: (channelId, seconds) => {
    const until = Date.now() + Math.max(0, seconds) * 1000;
    set((state) => ({
      slowmodeCooldownUntil: { ...state.slowmodeCooldownUntil, [channelId]: until },
    }));
  },

  clearSlowmodeCooldown: (channelId) => {
    if (!(channelId in get().slowmodeCooldownUntil)) return;
    set((state) => {
      const { [channelId]: _removed, ...rest } = state.slowmodeCooldownUntil;
      return { slowmodeCooldownUntil: rest };
    });
  },

  resetChatState: () => set({ ...initialState }),
}));
