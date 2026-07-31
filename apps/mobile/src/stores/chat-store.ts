/**
 * Chat client-state store — the mobile mirror of the desktop renderer's
 * stores/chat-store.ts. The behaviour is identical (this is deliberately a
 * faithful port, not a reinvention): server state lives in TanStack Query; this
 * store owns only selection, unread flags, realtime-fed volatile state
 * (connection/presence/typing), a user directory, and the optimistic outbox.
 *
 * Presence/typing live here — NOT in query caches — so presence ticks never
 * rerender the message list; only components selecting `presence`/`typing`
 * update (CLAUDE.md §27).
 */
import { create } from "zustand";
import type { OutboxErrorKey, RealtimeStatus } from "@demli/client-core";
import { isChatCapableChannel } from "@demli/types";
import type {
  Attachment,
  Channel,
  ChannelId,
  GroupId,
  MessageId,
  MessageReplyPreview,
  NotificationMute,
  NotificationMuteMode,
  NotificationMuteScope,
  PresencePlatform,
  PresenceStatus,
  User,
  UserId,
} from "@demli/types";
import { loadUnreadMarkers, saveUnreadMarkers, type UnreadMarkers } from "../lib/unread-storage";

/**
 * How a not-yet-confirmed message is rendering.
 * - `queued`  — waiting for a connection, or waiting its turn in the drain. The
 *   resting state while offline; it SURVIVES an app restart.
 * - `sending` — dispatched to the gateway, awaiting the `message.created` echo.
 * - `failed`  — out of attempts, rejected, or its channel is gone. Only a user
 *   action (retry / discard) leaves this state.
 *
 * Mirrors `OutboxStatus` in @demli/client-core: the persistent queue
 * controller is the single authority and this store only mirrors what it
 * publishes.
 */
export type DeliveryState = "queued" | "sending" | "failed";

/** A live notification mute as the client tracks it (the DTO minus identity). */
export interface MuteEntry {
  mode: NotificationMuteMode;
  /** ISO auto-expiry; null = indefinite. An elapsed value reads as unmuted. */
  until: string | null;
}

/** Composite key for the `notificationMutes` lookup — one per (scope, target). */
export function muteKey(scope: NotificationMuteScope, targetId: string): string {
  return `${scope}:${targetId}`;
}

/** The active mute mode for one target, or null when unmuted / expired. */
export function activeMuteMode(
  mutes: Record<string, MuteEntry>,
  scope: NotificationMuteScope,
  targetId: string,
  now: number = Date.now(),
): NotificationMuteMode | null {
  const entry = mutes[muteKey(scope, targetId)];
  if (!entry) return null;
  if (entry.until !== null && new Date(entry.until).getTime() <= now) return null;
  return entry.mode;
}

/** True when a target is currently muted (any mode), honoring expiry. */
export function isTargetMuted(
  mutes: Record<string, MuteEntry>,
  scope: NotificationMuteScope,
  targetId: string,
  now: number = Date.now(),
): boolean {
  return activeMuteMode(mutes, scope, targetId, now) !== null;
}

/**
 * The effective mute mode for a channel: its OWN channel mute wins over its
 * group's mute (most specific), each honoring expiry. Null when neither applies.
 */
export function effectiveChannelMuteMode(
  mutes: Record<string, MuteEntry>,
  channelId: ChannelId,
  groupId: GroupId,
  now: number = Date.now(),
): NotificationMuteMode | null {
  return (
    activeMuteMode(mutes, "channel", channelId, now) ??
    activeMuteMode(mutes, "group", groupId, now)
  );
}

/**
 * Cap on how many channels keep a persisted read watermark. SecureStore values
 * are size-limited on Android, so evicting the least recently updated channel
 * past this bound keeps the blob small; a pruned channel simply shows no divider
 * until its next visit re-seeds it.
 */
const MAX_TRACKED_CHANNELS = 80;

/** Optimistic-outbox ids never become a durable read watermark. */
const OUTBOX_ID_PREFIX = "outbox-";

/**
 * Move `channelId` to the most-recent position and drop the oldest entries past
 * {@link MAX_TRACKED_CHANNELS} (object key order is insertion order → cheap LRU).
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
 * Immutably drop a channel's unread count. Returns the SAME reference when there
 * is nothing to clear, so marking an already-read channel read never allocates a
 * new map (no needless badge re-render, §27).
 */
function clearCount(
  counts: Record<ChannelId, number>,
  channelId: ChannelId,
): Record<ChannelId, number> {
  if (!(channelId in counts)) return counts;
  const { [channelId]: _removed, ...rest } = counts;
  return rest;
}

/** An optimistic message that has not (yet) been confirmed by the server. */
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
   * render, so a live locale switch re-labels the reason and client-core stays
   * i18n-free (ADR 0009).
   */
  errorKey: OutboxErrorKey | null;
  /**
   * Ready attachment metadata riding this send (ADR 0008) — keeps the
   * optimistic row's tiles rendering (from local file URIs) and lets a retry
   * re-send the same attachment ids.
   */
  attachments?: Attachment[];
  /**
   * When this optimistic send is a reply (ADR 0011 §2): the target message id
   * threaded into the gateway `message.send`, kept so a retry re-sends the same
   * reply. `replyTo` is the denormalized preview used to render the quote line
   * on the optimistic row before the server echo carries its own.
   */
  replyToMessageId?: MessageId;
  replyTo?: MessageReplyPreview;
}

/**
 * The message a reply is being composed against (ADR 0011 §2). Held per channel
 * so the composer only shows the reply banner for the stream it belongs to; the
 * `preview` is a {@link MessageReplyPreview} built from the tapped message and
 * carried straight into the send.
 */
export interface ReplyDraft {
  channelId: ChannelId;
  preview: MessageReplyPreview;
}

/**
 * The message currently being EDITED (Feature A). A single slot like the reply
 * draft — the composer prefills its text from `content` and, on send, PATCHes
 * `messageId` (over the shared client) instead of sending a new message.
 * Cleared on save, cancel, and when leaving the channel. Mutually exclusive with
 * a reply draft (starting one clears the other).
 */
export interface EditDraft {
  channelId: ChannelId;
  messageId: MessageId;
  content: string;
}

interface ChatStore {
  // Selection ---------------------------------------------------------------
  activeGroupId: GroupId | null;
  activeChannelId: ChannelId | null;
  lastChannelByGroup: Record<GroupId, ChannelId>;
  unreadChannelIds: Record<ChannelId, boolean>;
  /**
   * channelId → count of unread messages accumulated THIS session (#110). Bumped
   * for every background message on a non-active channel; reset to 0 on read.
   * Session-only (never persisted) so it can only ever undercount across a cold
   * start — the badge then honestly falls back to "1+" (see `unreadBadgeText`)
   * rather than inventing a number. Parallel to `unreadChannelIds` so the boolean
   * dot/dim logic is untouched.
   */
  unreadCounts: Record<ChannelId, number>;
  /**
   * Subset of `unreadChannelIds` whose unread arrived from a DIRECT @mention of
   * the current user. Lets a "mentions"-muted channel still surface a mention
   * indicator while its plain unread dot is suppressed. Cleared alongside the
   * unread flag.
   */
  mentionUnreadChannelIds: Record<ChannelId, boolean>;
  /**
   * Notification mutes keyed by `${scope}:${targetId}` ({@link muteKey}).
   * Server-authoritative (mirrored from GET /notification-mutes + the
   * `notification_mute.updated` event); drives dimming + unread suppression.
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
   * userId → dominant client kind (task #47). Parallel to `presence` so existing
   * status reads are untouched; no entry ⇒ no reported platform. Drives the
   * mobile phone indicator on the presence dot.
   */
  presencePlatforms: Record<UserId, PresencePlatform>;
  /**
   * userId → their custom status line (M18). Fed by `presence.updated` (peers)
   * and `user.custom_status_updated` (our own other devices). Parallel to
   * `presence` for the same reason as `presencePlatforms`: a status line carries
   * no status dot, so folding it into `presence` would have to invent one.
   *
   * Text only — an EXPIRY never travels on a presence frame, so the durable
   * `User.customStatusExpiresAt` (and `visibleCustomStatus`) is what decides
   * whether a status is still showable.
   */
  customStatuses: Record<UserId, string>;
  /** channelId → userId → typing-entry expiry (epoch ms). */
  typing: Record<ChannelId, Record<UserId, number>>;
  /**
   * Directory of every user we have seen (group members, self). Message rows
   * resolve author name/avatar from here.
   *
   * INVARIANT: the CURRENT session user is always present while signed in — it is
   * seeded at sign-in (app/_layout), re-seeded atomically by
   * {@link ChatStore.resetChatState} on an account switch, and again on every
   * realtime handshake (`auth.succeeded`). Three independent seeds because a
   * missing self entry is user-visible: own messages render as "unknown author".
   */
  users: Record<UserId, User>;

  // Optimistic sends --------------------------------------------------------
  outbox: Record<ChannelId, OutboxMessage[]>;

  /**
   * The active reply draft (ADR 0011 §2), or null when not replying. A single
   * slot: only one composer is mounted at a time, and it is cleared on send, on
   * cancel, and when leaving the channel.
   */
  replyDraft: ReplyDraft | null;

  /**
   * The active edit draft (Feature A), or null when not editing. Single slot,
   * cleared on save, cancel, and when leaving the channel.
   */
  editDraft: EditDraft | null;

  /**
   * Per-channel slow-mode cooldown: epoch ms when this member may send again.
   * Armed from the gateway's SLOWMODE error (connection.ts); the composer ticks
   * it down. Owners are exempt server-side and never receive the error.
   */
  slowmodeUntil: Record<ChannelId, number>;

  // Actions -----------------------------------------------------------------
  setActiveGroup: (groupId: GroupId) => void;
  setActiveChannel: (channel: Channel) => void;
  clearActiveChannel: () => void;
  markChannelRead: (channelId: ChannelId) => void;
  markChannelUnread: (channelId: ChannelId, isMention?: boolean) => void;

  /** Replace the whole mute lookup (initial GET /notification-mutes seed). */
  replaceNotificationMutes: (mutes: NotificationMute[]) => void;
  /** Upsert one mute (optimistic set + `notification_mute.updated` with a mute). */
  setNotificationMute: (scope: NotificationMuteScope, targetId: string, entry: MuteEntry) => void;
  /** Drop one mute (optimistic clear + `notification_mute.updated` with mute:null). */
  clearNotificationMute: (scope: NotificationMuteScope, targetId: string) => void;
  /**
   * Advance a channel's read watermark to `messageId` (the newest message seen
   * while it was open) and persist it. No-op for an unchanged or synthetic
   * (outbox) id. The thread freezes the divider position from the value captured
   * at channel-open, so advancing here never moves the current divider.
   */
  setChannelReadMarker: (channelId: ChannelId, messageId: MessageId) => void;

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
   * {@link ChatStore.setPresence} because `user.custom_status_updated` carries no
   * status dot — folding it into a presence write would have to invent one.
   */
  setCustomStatus: (userId: UserId, text: string | null) => void;
  setTyping: (channelId: ChannelId, userId: UserId, expiresAt: number) => void;
  clearTyping: (channelId: ChannelId, userId: UserId) => void;
  /** Drop expired typing entries; no-op state-wise when nothing expired. */
  pruneTyping: (now: number) => void;
  upsertUsers: (users: User[]) => void;

  /**
   * Mirror the persistent queue's latest projection (realtime/outbox.ts). The
   * ONLY writer of `outbox` — nothing else may mutate it, so the controller and
   * the UI can never disagree about what is still unsent.
   */
  syncOutbox: (outbox: Record<ChannelId, OutboxMessage[]>) => void;

  /** Start replying to a message in `channelId` (replaces any current draft). */
  setReplyDraft: (channelId: ChannelId, preview: MessageReplyPreview) => void;
  /** Clear the reply draft (send, cancel, or leaving the channel). */
  clearReplyDraft: () => void;

  /** Start editing a message in `channelId` (replaces any current draft; clears a reply draft). */
  setEditDraft: (channelId: ChannelId, messageId: MessageId, content: string) => void;
  /** Clear the edit draft (save, cancel, or leaving the channel). */
  clearEditDraft: () => void;

  /** Arm/refresh a channel's slow-mode cooldown (seconds until next send). */
  startSlowmodeCooldown: (channelId: ChannelId, retryAfterSeconds: number) => void;
  /** Clear a channel's cooldown (composer calls this when it hits 0). */
  clearSlowmodeCooldown: (channelId: ChannelId) => void;

  /**
   * Full reset on logout / account switch.
   *
   * `self` — the session user to RE-SEED into {@link users} in the SAME update as
   * the wipe. This is a hard invariant, not a convenience: an account SWITCH
   * keeps auth `status` authenticated (ADR 0013), so app/_layout's status-keyed
   * `upsertUsers([user])` never re-fires after the reset. Without the re-seed the
   * directory stays empty until some roster query lands — and a DM has NO roster
   * query, so the user's OWN messages rendered as "unknown author" (founder P0).
   * Pass `null`/omit only when there is genuinely no session (full sign-out).
   */
  resetChatState: (self?: User | null) => void;
}

const initialState = {
  activeGroupId: null,
  activeChannelId: null,
  lastChannelByGroup: {},
  unreadChannelIds: {},
  unreadCounts: {} as Record<ChannelId, number>,
  mentionUnreadChannelIds: {},
  notificationMutes: {} as Record<string, MuteEntry>,
  // Hydrated asynchronously from SecureStore just after the store is created
  // (see below) — starts empty so a cold start never blocks on the keystore.
  lastReadMessageId: {} as Record<ChannelId, MessageId>,
  connectionStatus: "idle" as RealtimeStatus,
  presence: {},
  presencePlatforms: {},
  customStatuses: {},
  typing: {},
  users: {},
  outbox: {},
  replyDraft: null,
  editDraft: null,
  slowmodeUntil: {},
};

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,

  setActiveGroup: (groupId) => {
    if (groupId === get().activeGroupId) return;
    set({ activeGroupId: groupId });
  },

  setActiveChannel: (channel) => {
    // Every CHAT-CAPABLE channel may be the active one — which since M20 means
    // voice channels too, because each one carries its own text chat. The gate
    // asks the same shared question as the four server-side write gates
    // (packages/types), so a future non-chat kind still fails closed here.
    //
    // This is load-bearing beyond selection: `activeChannelId` is what suppresses
    // the unread flag for the stream you are currently reading (see
    // realtime/connection handleMessageCreated). While it was pinned to
    // `kind === "text"`, reading a voice channel's chat marked every arriving
    // message unread right in front of the user.
    //
    // Joining the ROOM stays a separate, explicit gesture (the voice screen /
    // the row's primary tap) — selecting a channel here never touches the voice
    // engine.
    if (!isChatCapableChannel(channel.kind)) return;
    set((state) => ({
      activeChannelId: channel.id,
      activeGroupId: channel.groupId,
      lastChannelByGroup: { ...state.lastChannelByGroup, [channel.groupId]: channel.id },
      unreadChannelIds: { ...state.unreadChannelIds, [channel.id]: false },
      unreadCounts: clearCount(state.unreadCounts, channel.id),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [channel.id]: false },
    }));
  },

  clearActiveChannel: () => {
    if (get().activeChannelId === null) return;
    set({ activeChannelId: null });
  },

  markChannelRead: (channelId) => {
    set((state) => ({
      unreadChannelIds: { ...state.unreadChannelIds, [channelId]: false },
      unreadCounts: clearCount(state.unreadCounts, channelId),
      mentionUnreadChannelIds: { ...state.mentionUnreadChannelIds, [channelId]: false },
    }));
  },

  markChannelUnread: (channelId, isMention = false) => {
    const state = get();
    // A later mention upgrades an existing plain-unread flag so a
    // "mentions"-muted channel still lights up; a plain message never clears it.
    const alreadyMention = state.mentionUnreadChannelIds[channelId];
    // The COUNT must advance on EVERY background message (that is what the badge
    // shows), so — unlike the boolean flag — there is no early-return here.
    set({
      unreadChannelIds: { ...state.unreadChannelIds, [channelId]: true },
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] ?? 0) + 1,
      },
      mentionUnreadChannelIds:
        isMention && !alreadyMention
          ? { ...state.mentionUnreadChannelIds, [channelId]: true }
          : state.mentionUnreadChannelIds,
    });
  },

  replaceNotificationMutes: (mutes) => {
    const next: Record<string, MuteEntry> = {};
    for (const m of mutes) next[muteKey(m.scope, m.targetId)] = { mode: m.mode, until: m.until };
    set({ notificationMutes: next });
  },

  setNotificationMute: (scope, targetId, entry) => {
    set((state) => ({
      notificationMutes: { ...state.notificationMutes, [muteKey(scope, targetId)]: entry },
    }));
  },

  clearNotificationMute: (scope, targetId) => {
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
    // so a desktop⇄mobile switch at the same status still repaints the dot.
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

    set({ presence: { ...state.presence, [userId]: status }, presencePlatforms, customStatuses });
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

  syncOutbox: (outbox) => {
    // The projection preserves per-channel array identity for untouched
    // channels, so this assignment does not re-render a thread whose own queue
    // did not change (§27). All send lifecycle now lives in realtime/outbox.ts.
    if (get().outbox === outbox) return;
    set({ outbox });
  },

  setReplyDraft: (channelId, preview) =>
    set({ replyDraft: { channelId, preview }, editDraft: null }),

  clearReplyDraft: () => {
    if (get().replyDraft === null) return;
    set({ replyDraft: null });
  },

  setEditDraft: (channelId, messageId, content) =>
    set({ editDraft: { channelId, messageId, content }, replyDraft: null }),

  clearEditDraft: () => {
    if (get().editDraft === null) return;
    set({ editDraft: null });
  },

  startSlowmodeCooldown: (channelId, retryAfterSeconds) => {
    const until = Date.now() + Math.max(0, retryAfterSeconds) * 1000;
    set((state) => ({ slowmodeUntil: { ...state.slowmodeUntil, [channelId]: until } }));
  },

  clearSlowmodeCooldown: (channelId) => {
    if (get().slowmodeUntil[channelId] === undefined) return;
    set((state) => {
      const { [channelId]: _removed, ...rest } = state.slowmodeUntil;
      return { slowmodeUntil: rest };
    });
  },

  resetChatState: (self) =>
    set({ ...initialState, users: self ? ({ [self.id]: self } as Record<UserId, User>) : {} }),
}));

// Hydrate the persisted "New Messages" divider watermarks once, just after the
// store is created. Async (SecureStore) but local, so it resolves long before a
// channel's messages arrive over the network; any marker advanced in the gap
// wins over the persisted value (spread order below).
void loadUnreadMarkers().then((persisted) => {
  if (Object.keys(persisted).length === 0) return;
  useChatStore.setState((state) => ({
    lastReadMessageId: {
      ...(persisted as Record<ChannelId, MessageId>),
      ...state.lastReadMessageId,
    },
  }));
});
