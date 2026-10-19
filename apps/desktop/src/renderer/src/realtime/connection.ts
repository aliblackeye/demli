/**
 * Realtime wiring — the single place where gateway events meet client state.
 *
 * - Owns the RealtimeClient singleton (src/lib/realtime-client.ts).
 * - Dispatches ServerToClientEvent into the chat store and the TanStack
 *   Query message cache. Event names come from the SERVER_EVENT constants;
 *   no string literals (CLAUDE.md §24).
 * - Owns the optimistic send pipeline: nonce outbox → message.created echo
 *   reconciliation, error.raised / timeout → failed with retry/discard.
 * - Owns composer typing notifications (throttled start, idle stop).
 */

import type { InfiniteData } from "@tanstack/react-query";
import {
  createVoiceAnnouncer,
  isStaleSelfPresence,
  withoutSelfPresence,
} from "@demli/client-core";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import {
  SERVER_EVENT,
  clientEvent,
  contentMentionsUser,
  type AppLifecycleState,
  type MessageDTO,
  type ServerToClientEvent,
} from "@demli/protocol";
import type {
  Attachment,
  AttachmentId,
  ChannelId,
  Dm,
  Group,
  GroupId,
  Message,
  MessageEmbed,
  MessageId,
  MessageReactionSummary,
  MessageReplyPreview,
  SelectablePresenceStatus,
  User,
  UserId,
} from "@demli/types";
import {
  api,
  type FriendWithUser,
  type GroupChatDetails,
  type GroupDetails,
  type MessagesPage,
} from "../lib/api-client";
import { notifyBlocked } from "../lib/blocked-notice";
import { foldMessageEmbeds } from "./embed-fold";
import { foldMessagePin } from "./pin-fold";
import { outbox, rememberOutboxMeta, setOutboxTransport } from "./outbox";
import { RealtimeClient } from "../lib/realtime-client";
import { CLIENT_SIGNATURE } from "../lib/client-signature";
import { getCallController } from "../lib/call-controller";
import { queryClient, queryKeys } from "../lib/query-client";
import { playSound } from "../sounds/sound-manager";
import {
  notifyAddedToGroupChat,
  notifyFriendRequest,
  notifyIncomingMessage,
} from "../notifications/notification-manager";
import { shouldPlayMessageCue } from "../notifications/notify-policy";
import { visibleContext } from "../notifications/visible-conversation";
import { useAuthStore } from "../stores/auth-store";
import { channelMuteModeFor, useChatStore } from "../stores/chat-store";
import {
  getEffectiveSelfPresenceStatus,
  isDoNotDisturb,
  useSelfPresenceStore,
} from "../stores/self-presence-store";
import { startIdleAutoPresence, stopIdleAutoPresence } from "../stores/idle-auto";
import { useVoiceStore } from "../stores/voice-store";
import {
  createThrottledOccupancyPull,
  useVoiceOccupancyStore,
} from "../stores/voice-occupancy-store";
import { useWatchPartyStore, type WatchRefusal } from "../stores/watch-party-store";

/** How long a typing.started entry stays visible without a refresh. */
const TYPING_TTL_MS = 8_000;
/** Re-send typing.start at most this often while the user keeps typing. */
const TYPING_START_THROTTLE_MS = 4_000;
/** Send typing.stop after this much composer inactivity. */
const TYPING_IDLE_MS = 5_000;
const TYPING_PRUNE_INTERVAL_MS = 2_500;

/**
 * QA hook (kept from Milestone 1): typing "/fail" simulates a failed send
 * locally — the frame never reaches the gateway — so the retry/discard UI
 * stays manually testable.
 */
const QA_FAIL_CONTENT = "/fail";
const QA_FAIL_LATENCY_MS = 450;

type MessagesCache = InfiniteData<MessagesPage, string | null>;

// ---------------------------------------------------------------------------
// Query-cache message updates
// ---------------------------------------------------------------------------

function cacheHasMessage(data: MessagesCache, messageId: string): boolean {
  return data.pages.some((page) => page.messages.some((m) => m.id === messageId));
}

/** Append a freshly created message (pages are newest-first; page 0 is newest). */
function insertMessage(message: Message): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(message.channelId), (data) => {
    if (!data || cacheHasMessage(data, message.id)) return data;
    const [first, ...rest] = data.pages;
    if (!first) return data;
    return {
      ...data,
      pages: [{ ...first, messages: [message, ...first.messages] }, ...rest],
    };
  });
}

function replaceMessage(message: Message): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(message.channelId), (data) => {
    if (!data || !cacheHasMessage(data, message.id)) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) => {
          if (m.id !== message.id) return m;
          // `message.updated` (edit) intentionally omits reactions/replyTo (ADR
          // 0011 / W3 note): reactions are delta-managed and a reply is immutable.
          // Preserve the existing enrichment so an edit never wipes the pills or
          // the quote line.
          return {
            ...message,
            reactions: message.reactions ?? m.reactions,
            replyTo: message.replyTo ?? m.replyTo,
            replyToMessageId: message.replyToMessageId ?? m.replyToMessageId,
          };
        }),
      })),
    };
  });
}

function removeMessage(channelId: ChannelId, messageId: string): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(channelId), (data) => {
    if (!data || !cacheHasMessage(data, messageId)) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        messages: page.messages.filter((m) => m.id !== messageId),
      })),
    };
  });
}

/**
 * Fold a link-preview set (`message.embeds_updated`, M17) onto its cached
 * message. The pure {@link foldMessageEmbeds} is a no-op when the message is not
 * on a loaded page (the embeds still ride the next GET's `MessageDTO.embeds`) and
 * rebuilds only the target row, so unchanged messages never re-render (§27).
 */
function applyEmbedsUpdate(channelId: ChannelId, messageId: string, embeds: MessageEmbed[]): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(channelId), (data) =>
    foldMessageEmbeds(data, messageId, embeds),
  );
}

// ---------------------------------------------------------------------------
// Reaction cache folding (ADR 0011 §3) — deltas fold into the cached message's
// aggregated `reactions` summary; the optimistic layer patches it on tap and
// reconciles against the server's authoritative summary.
// ---------------------------------------------------------------------------

/**
 * Fold one reaction delta into a message's summary. Pure. `mine` guards the
 * initiator's own server echo: after an optimistic add/remove I am already
 * counted, so a re-application for my `userId` is a no-op (idempotent on
 * `(emoji, me)`, per the W4 hand-off). Other users' deltas always apply — the
 * summary is aggregated, and a genuine miss self-heals on the reconnect refetch.
 * New emoji append last, matching the server's first-occurrence ordering.
 */
function foldReaction(
  reactions: MessageReactionSummary[] | undefined,
  emoji: string,
  delta: 1 | -1,
  mine: boolean,
): MessageReactionSummary[] {
  const list = reactions ?? [];
  const idx = list.findIndex((r) => r.emoji === emoji);
  const entry = idx >= 0 ? list[idx] : undefined;

  if (delta === 1) {
    if (!entry) return [...list, { emoji, count: 1, reactedByMe: mine }];
    if (mine && entry.reactedByMe) return list; // already counted — dedupe my echo
    return list.map((r, i) =>
      i === idx ? { ...r, count: r.count + 1, reactedByMe: mine ? true : r.reactedByMe } : r,
    );
  }

  if (!entry) return list; // nothing to remove
  if (mine && !entry.reactedByMe) return list; // never counted — dedupe my echo
  const nextCount = entry.count - 1;
  if (nextCount <= 0) return list.filter((_, i) => i !== idx);
  return list.map((r, i) =>
    i === idx ? { ...r, count: nextCount, reactedByMe: mine ? false : r.reactedByMe } : r,
  );
}

/** Apply a `reactions` transform to one cached message (no-op if it isn't loaded). */
function updateMessageReactions(
  channelId: ChannelId,
  messageId: string,
  next: (reactions: MessageReactionSummary[] | undefined) => MessageReactionSummary[],
): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(channelId), (data) => {
    if (!data || !cacheHasMessage(data, messageId)) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) =>
          m.id === messageId ? { ...m, reactions: next(m.reactions) } : m,
        ),
      })),
    };
  });
}

/** Read a cached message's current reaction summary (undefined if not loaded). */
function readMessageReactions(
  channelId: ChannelId,
  messageId: string,
): MessageReactionSummary[] | undefined {
  const data = queryClient.getQueryData<MessagesCache>(queryKeys.messages(channelId));
  if (!data) return undefined;
  for (const page of data.pages) {
    const found = page.messages.find((m) => m.id === messageId);
    if (found) return found.reactions;
  }
  return undefined;
}

/** Fold an inbound reaction delta into the cache (realtime handler entry point). */
function applyReactionDelta(
  channelId: ChannelId,
  messageId: string,
  emoji: string,
  delta: 1 | -1,
  mine: boolean,
): void {
  updateMessageReactions(channelId, messageId, (reactions) =>
    foldReaction(reactions, emoji, delta, mine),
  );
}

/**
 * Toggle my reaction on a message (UI entry point). Applies the delta
 * optimistically, fires the idempotent HTTP verb, then reconciles against the
 * server's authoritative summary — or rolls back to the pre-tap snapshot on
 * error (rate limit / lost visibility). The server echo for my own `userId` is
 * deduped by {@link foldReaction}, so it never double-counts.
 */
export function toggleMessageReaction(
  channelId: ChannelId,
  messageId: MessageId,
  emoji: string,
  reactedByMe: boolean,
): void {
  const me = useAuthStore.getState().user;
  if (!me) return;

  const snapshot = readMessageReactions(channelId, messageId);
  const adding = !reactedByMe;

  applyReactionDelta(channelId, messageId, emoji, adding ? 1 : -1, true);

  const request = adding
    ? api.addReaction(messageId, emoji)
    : api.removeReaction(messageId, emoji);

  void request.then(
    ({ reactions }) => updateMessageReactions(channelId, messageId, () => reactions),
    (error: unknown) => {
      updateMessageReactions(channelId, messageId, () => snapshot ?? []);
      console.warn("[reactions] toggle failed", error);
    },
  );
}

/** Events were missed (seq gap / reconnect) — the cache can no longer be trusted. */
function refetchServerState(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allMessages });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
  // Group-chat rosters carry member profiles too, so a `user.updated` missed
  // while away heals here alongside the server rosters.
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
  // Social lists too: friend/DM events may have been missed while away, and the
  // gateway fan-out (W3) can lag — a reconnect refetch is the correct fallback
  // (ADR 0010 §5). Cheap no-ops when the user has no friends/DMs.
  invalidateSocialLists();
}

/**
 * A user we can see changed their public profile — repaint every surface that
 * shows their name/photo, without a network round-trip.
 *
 * Surgical `setQueryData` patches rather than `invalidateQueries` on purpose
 * (§27): a profile edit by any visible user would otherwise refetch every cached
 * group roster, and the roster is exactly the hot surface. The new `User` is
 * already in hand, so patching is both cheaper AND instant. Only the profile card
 * is invalidated — it carries friendship + role context this event does not.
 *
 * Covers: the user directory (message rows read names/avatars reactively from
 * it), server rosters (the member sidebar — the founder's reported surface),
 * group-chat rosters, the friends list and the DM list.
 */
function applyUserUpdate(user: User): void {
  useChatStore.getState().upsertUsers([user]);

  // Own profile changed on another device — keep this window's identity in sync.
  if (useAuthStore.getState().user?.id === user.id) {
    // Merge, never replace: `user` is the PUBLIC projection, so assigning it
    // wholesale would drop the me-only fields (friendCode/birthdate/isAdult) that
    // this client legitimately holds for itself.
    const self = useAuthStore.getState().user;
    if (self) {
      const merged = { ...self, ...user };
      useAuthStore.getState().setUser(merged);
      queryClient.setQueryData(queryKeys.me, merged);
    }
  }

  // Server rosters → the right-hand member sidebar.
  queryClient.setQueriesData<GroupDetails>({ queryKey: queryKeys.groups }, (details) => {
    if (!details?.members?.some((m) => m.user.id === user.id)) return details;
    return {
      ...details,
      members: details.members.map((m) => (m.user.id === user.id ? { ...m, user } : m)),
    };
  });

  // Flat group-chat rosters.
  queryClient.setQueriesData<GroupChatDetails>(
    { queryKey: queryKeys.groupChats },
    (details) => {
      if (!details?.members?.some((m) => m.user.id === user.id)) return details;
      return {
        ...details,
        members: details.members.map((m) => (m.user.id === user.id ? { ...m, user } : m)),
      };
    },
  );

  // Friends list.
  queryClient.setQueryData<FriendWithUser[]>(queryKeys.friends, (friends) => {
    if (!friends?.some((f) => f.user.id === user.id)) return friends;
    return friends.map((f) => (f.user.id === user.id ? { ...f, user } : f));
  });

  // DM list (the counterpart's name/photo in the sidebar).
  queryClient.setQueryData<Dm[]>(queryKeys.dms, (dms) => {
    if (!dms?.some((d) => d.participant.id === user.id)) return dms;
    return dms.map((d) => (d.participant.id === user.id ? { ...d, participant: user } : d));
  });

  // The profile card carries friendship + server roles this event does not, so it
  // is refetched rather than patched. Two-segment prefix → every `groupId` variant.
  void queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
}

/** Refresh every friendship-derived list + the caller's DMs (ADR 0010). */
function invalidateSocialLists(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("incoming") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("outgoing") });
  void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
}

/** True when `channelId` is a known server channel or a flat group-chat stream. */
function isKnownServerOrGroupChannel(channelId: ChannelId): boolean {
  // Server channels: scan every cached group-details channel list. The prefix
  // match also returns the ["groups"] list itself (FriendGroup[]), which has no
  // `.channels` — the optional chain treats it as a miss.
  const groupDetails = queryClient.getQueriesData<GroupDetails>({
    queryKey: queryKeys.groups,
  });
  for (const [, details] of groupDetails) {
    if (details?.channels?.some((c) => c.id === channelId)) return true;
  }
  // Flat group chats: each group's single stream channel.
  const groupChats = queryClient.getQueryData<Group[]>(queryKeys.groupChats);
  return groupChats?.some((g) => g.streamId === channelId) ?? false;
}

/**
 * The server group that owns a text channel, or null for a DM / flat group-chat
 * stream. Used to resolve a channel's EFFECTIVE mute (its own mute OR its
 * server's), so the notify sound + toast honor a whole-server mute the same way
 * the channel sidebar badge does (migration 0013). Cheap cache scan, only on
 * inbound messages (never the presence hot path, §27).
 */
function serverGroupIdForChannel(channelId: ChannelId): GroupId | null {
  const groupDetails = queryClient.getQueriesData<GroupDetails>({
    queryKey: queryKeys.groups,
  });
  for (const [, details] of groupDetails) {
    if (details?.channels?.some((c) => c.id === channelId)) return details.group.id;
  }
  return null;
}

/**
 * A message landed on a stream that is NOT in our DM list and is not a known
 * server / group-chat channel — i.e. a DM we had hidden that the gateway just
 * un-hid on inbound (ADR 0010 §1; W3 hand-off note 1: the server does not
 * re-emit `dm.created` per message). Re-surface it by refetching the DM list.
 * Guarded so a normal server/group message never triggers a refetch (§27).
 */
function resurfaceHiddenDmIfNeeded(channelId: ChannelId): void {
  const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms);
  // DM list never loaded → nothing on screen to fix; a later fetch shows it.
  if (!dms) return;
  if (dms.some((d) => d.streamId === channelId)) return;
  if (isKnownServerOrGroupChannel(channelId)) return;
  void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
}

/**
 * A DM was created for us (`dm.created`, user-scoped). The gateway has already
 * subscribed this connection to the DM's stream (ADR 0010 §4), so we only need
 * the conversation to appear: seed the participant into the user directory and
 * patch/refresh the DM list. We do NOT auto-open it — the user picks it.
 */
function handleDmCreated(dm: Dm): void {
  useChatStore.getState().upsertUsers([dm.participant]);
  queryClient.setQueryData<Dm[]>(queryKeys.dms, (list) => {
    const rest = (list ?? []).filter((d) => d.id !== dm.id);
    return [dm, ...rest];
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
}

/**
 * We were just added to a flat group chat (`group_chat.added`, user-scoped). The
 * gateway has already subscribed this connection to the group's stream (ADR 0005,
 * mirror of `dm.created`), so we only need the group to APPEAR: patch it into the
 * home group-chat list (deduped) and refetch the authoritative list, then fire a
 * notification. We do NOT auto-open it — the user picks it — matching the DM path.
 */
function handleGroupChatAdded(group: Group): void {
  queryClient.setQueryData<Group[]>(queryKeys.groupChats, (list) => {
    const rest = (list ?? []).filter((g) => g.id !== group.id);
    return [group, ...rest];
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
  notifyAddedToGroupChat(group);
}

/**
 * A role changed in a server (created/updated/deleted). Refetch both the role
 * list and the group details — member-name colors derive from the role list, so
 * a color/permission change must repaint members too (ADR 0007).
 */
function invalidateGroupRoles(groupId: GroupId): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.roles(groupId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(groupId) });
}

/**
 * A whole server / flat group chat was deleted (owner delete OR auto-deleted
 * when its last member left — task #50). Tear down anything still pointing at it
 * and drop it from every cached list.
 */
function handleGroupDeleted(groupId: GroupId): void {
  const chat = useChatStore.getState();

  // Voice teardown: if we are sitting in a voice room that belonged to the
  // deleted server, leave it (LiveKit client-side teardown). The gateway already
  // stopped routing its signaling frames to us; this ends the media session.
  const voiceRoomId = useVoiceStore.getState().roomId;
  if (voiceRoomId) {
    const details = queryClient.getQueryData<GroupDetails>(queryKeys.groupDetails(groupId));
    if (details?.channels.some((c) => c.id === voiceRoomId)) {
      useVoiceStore.getState().leave();
    }
  }

  // Route out first: if we are looking at this group chat, drop the selection so
  // the home surface stops rendering it (server surface is handled by AppShell's
  // selection sync once the groups list refetches below).
  if (chat.activeGroupChatId === groupId) chat.clearActiveGroupChat();

  // Drop the group's caches, then refresh both lists so the rail / home prune it.
  queryClient.removeQueries({ queryKey: queryKeys.groupDetails(groupId) });
  queryClient.removeQueries({ queryKey: queryKeys.groupChatDetails(groupId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
}

// ---------------------------------------------------------------------------
// Optimistic send pipeline
// ---------------------------------------------------------------------------

/**
 * Locate a queued item by nonce alone — `error.raised` carries no channel id.
 * The queue is bounded (`OUTBOX_MAX_ITEMS`) and this runs once per rejection, so
 * the linear scan is free.
 */
function findQueuedItem(nonce: string): { channelId: ChannelId } | null {
  for (const [channelId, bucket] of Object.entries(outbox.getState())) {
    if (bucket.some((item) => item.nonce === nonce)) return { channelId };
  }
  return null;
}

/**
 * The gateway transport for the PERSISTENT queue (M17).
 *
 * Every retry keeps its original nonce, and the gateway's insert is
 * `ON CONFLICT (author_id, nonce) DO NOTHING`, so replaying a send whose echo was
 * lost resolves to the ORIGINAL row instead of inserting a duplicate. That
 * server-side dedupe exists ONLY on this gateway path — the REST send carries no
 * nonce — which is exactly why the queue must never drain over HTTP.
 *
 * Returns false when the socket is not open; the controller reads that as "still
 * offline" and stops draining until reconnect.
 */
setOutboxTransport((item) => {
  if (item.content === QA_FAIL_CONTENT) {
    // QA hook: accept the dispatch, then fail it out-of-band so the failed-row
    // affordances (retry / discard) can be exercised without a real outage.
    window.setTimeout(
      () => outbox.reject(item.channelId, item.nonce, "rejected"),
      QA_FAIL_LATENCY_MS,
    );
    return true;
  }
  // attachmentIds / replyToMessageId are omitted entirely when absent so a
  // plain text send stays byte-identical to pre-M10/M14. The gateway links
  // attachments (ADR 0008) and enriches the reply preview (ADR 0011) on
  // message.created; both come back on the echo.
  return client.send(
    clientEvent.messageSend({
      channelId: item.channelId,
      content: item.content,
      nonce: item.nonce,
      ...(item.attachmentIds && item.attachmentIds.length > 0
        ? { attachmentIds: item.attachmentIds }
        : {}),
      ...(item.replyToMessageId ? { replyToMessageId: item.replyToMessageId } : {}),
    }),
  );
});

/** Optional attachment payload for {@link sendChatMessage} (ADR 0008). */
export interface SendChatMessageAttachments {
  /** Ready, uploader-owned attachment ids to link to this message. */
  attachmentIds: AttachmentId[];
  /** Metadata for the optimistic row (renders tiles before the echo lands). */
  attachments: Attachment[];
  /** attachmentId → local blob: URL, so the optimistic tiles show our bytes. */
  localAttachmentUrls: Record<AttachmentId, string>;
}

/** Optional reply payload for {@link sendChatMessage} (ADR 0011 §2). */
export interface SendChatMessageReply {
  /** The quoted message's id — threaded to the gateway's `message.send`. */
  replyToMessageId: MessageId;
  /** Lean preview so the optimistic row shows the quote before the echo lands. */
  replyTo: MessageReplyPreview;
}

/** Optimistically append and send a message over the gateway. */
export function sendChatMessage(
  channelId: ChannelId,
  rawContent: string,
  media?: SendChatMessageAttachments,
  reply?: SendChatMessageReply,
): void {
  const content = rawContent.trim();
  const attachmentIds = media?.attachmentIds ?? [];
  // Content-OR-attachments (ADR 0008): a caption-less attachment send is valid.
  if (content.length > MESSAGE_MAX_LENGTH) return;
  if (content.length === 0 && attachmentIds.length === 0) return;
  const me = useAuthStore.getState().user;
  if (!me) return;

  const nonce = crypto.randomUUID();
  // Render-only extras (attachment metadata, blob: preview URLs, the reply
  // quote) are deliberately NOT part of the persisted item — they are
  // re-derivable or dead after a reload — so they are handed to the projection
  // layer, not to the queue.
  rememberOutboxMeta(nonce, {
    ...(media?.attachments ? { attachments: media.attachments } : {}),
    ...(media?.localAttachmentUrls ? { localAttachmentUrls: media.localAttachmentUrls } : {}),
    ...(reply?.replyTo ? { replyTo: reply.replyTo } : {}),
  });
  outbox.enqueue({
    nonce,
    channelId,
    authorId: me.id,
    content,
    createdAt: new Date().toISOString(),
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(reply?.replyToMessageId ? { replyToMessageId: reply.replyToMessageId } : {}),
  });
}

/**
 * Retry a failed queued message with its original nonce. Safe to replay: the
 * gateway dedupes on `(author_id, nonce)`, so a send whose echo was lost resolves
 * to the original row rather than inserting a duplicate.
 */
export function retryOutboxMessage(channelId: ChannelId, nonce: string): void {
  outbox.retry(channelId, nonce);
}

export function discardOutboxMessage(channelId: ChannelId, nonce: string): void {
  outbox.discard(channelId, nonce);
}

// ---------------------------------------------------------------------------
// Self presence (status picker)
// ---------------------------------------------------------------------------

/**
 * Change our OWN status (the status picker). Three effects:
 *  1. persist the choice per-account so it survives reload/reconnect;
 *  2. paint our own dot immediately, so the click answers at once;
 *  3. tell the gateway so peers repaint — the server masks `invisible` to
 *     `offline` for everyone else. Our own sockets then get the account's REAL
 *     status back (M16, see `presence.updated` below), which is the derived
 *     answer across every device: usually our pick, but a `dnd`/`invisible`
 *     still declared on the phone outranks it (ADR 0020), and the dot follows.
 *
 * `dnd` / `invisible` only change PRESENTATION + peer visibility; the call and
 * notification FSMs are untouched (DND merely gates their sound/overlay layer).
 */
export function setSelfPresenceStatus(status: SelectablePresenceStatus): void {
  const me = useAuthStore.getState().user;
  if (!me) return;
  useSelfPresenceStore.getState().setStatus(me.id, status);
  // A manual pick clears any active auto-away — the choice is authoritative, so
  // an idle→online (or any) pick must not keep broadcasting the automatic idle.
  useSelfPresenceStore.getState().setAutoAway(false);
  useChatStore.getState().setPresence(me.id, status);
  client.send(clientEvent.presenceUpdate({ userId: me.id, status }));
}

/**
 * Broadcast a presence status to the gateway + paint our own dot WITHOUT
 * persisting it as the chosen status. The auto-idle detector (`idle-auto.ts`)
 * uses this so an automatic away-flip repaints peers and self without ever
 * overwriting the user's picked status (which stays the source of truth). A send
 * that misses the socket is self-healed by the `auth.succeeded` re-assert, which
 * re-broadcasts the EFFECTIVE status on every (re)connect.
 */
export function pushSelfPresenceToGateway(status: SelectablePresenceStatus): void {
  const me = useAuthStore.getState().user;
  if (!me) return;
  useChatStore.getState().setPresence(me.id, status);
  client.send(clientEvent.presenceUpdate({ userId: me.id, status }));
}

// ---------------------------------------------------------------------------
// Composer typing notifications
// ---------------------------------------------------------------------------

interface ComposerTypingState {
  lastStartSentAt: number;
  idleTimer: number;
}

const composerTyping = new Map<ChannelId, ComposerTypingState>();

function sendTypingStop(channelId: ChannelId): void {
  const me = useAuthStore.getState().user;
  if (me) client.send(clientEvent.typingStop({ channelId, userId: me.id }));
}

/** Call on every non-empty composer change; throttles typing.start itself. */
export function notifyComposerTyping(channelId: ChannelId): void {
  const me = useAuthStore.getState().user;
  if (!me) return;

  const now = Date.now();
  const existing = composerTyping.get(channelId);
  if (existing) window.clearTimeout(existing.idleTimer);

  if (!existing || now - existing.lastStartSentAt >= TYPING_START_THROTTLE_MS) {
    client.send(clientEvent.typingStart({ channelId, userId: me.id }));
  }

  composerTyping.set(channelId, {
    lastStartSentAt:
      existing && now - existing.lastStartSentAt < TYPING_START_THROTTLE_MS
        ? existing.lastStartSentAt
        : now,
    idleTimer: window.setTimeout(() => {
      composerTyping.delete(channelId);
      sendTypingStop(channelId);
    }, TYPING_IDLE_MS),
  });
}

/** Call when the composer empties, sends, or unmounts. */
export function notifyComposerIdle(channelId: ChannelId): void {
  const existing = composerTyping.get(channelId);
  if (!existing) return;
  window.clearTimeout(existing.idleTimer);
  composerTyping.delete(channelId);
  sendTypingStop(channelId);
}

// ---------------------------------------------------------------------------
// Watch party (M20, ADR 0016) — client → gateway
//
// Thin senders, on purpose: every authority decision (occupancy, membership,
// timeout, host-or-owner) is the gateway's, and duplicating any of it here would
// create a second opinion that can drift from the real one. The UI hides what
// the user cannot do so there is no dead button (§35); these functions never
// pretend to be the gate.
// ---------------------------------------------------------------------------

/**
 * The channel our last watch frame concerned.
 *
 * `error.raised` carries no channel and no correlation id, so a refusal has to
 * be attributed to something. This is that something — and it is accurate,
 * because a client can only be in ONE voice channel at a time, which is the only
 * channel it can send a `watch.*` frame for. Reset whenever a session frame
 * lands for that room (the refusal is then stale by definition).
 */
let lastWatchActionChannel: ChannelId | null = null;

/** Codes emitted ONLY by the watch-party coordinator — safe to attribute. */
const WATCH_ONLY_ERROR_CODES = new Set<string>([
  "NOT_IN_VOICE",
  "NOT_HOST",
  "WATCH_NOT_ACTIVE",
  // The queue's own refusal (wave 3). Same property as the other three — the
  // coordinator is its only emitter in the whole gateway — and the only one of
  // the four the user can fix on the spot, so it must reach the panel rather
  // than a console warning nobody reads.
  "WATCH_QUEUE_FULL",
]);

/** Start (or replace) the party in a voice channel with a pasted link/id. */
export function startWatchParty(channelId: ChannelId, videoRef: string): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef }));
}

/** Play / pause / seek, at the position the controller's own player is at. */
export function controlWatchParty(
  channelId: ChannelId,
  action: "play" | "pause" | "seek",
  positionSec: number,
): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchControl({ channelId, action, positionSec }));
}

/** Swap the video without ending the session. */
export function setWatchPartyVideo(channelId: ChannelId, videoRef: string): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchSetVideo({ channelId, videoRef }));
}

/** Hand control to another occupant of the same voice channel. */
export function transferWatchPartyHost(channelId: ChannelId, toUserId: UserId): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchTransferHost({ channelId, toUserId }));
}

/** End the session for everyone. */
export function stopWatchParty(channelId: ChannelId): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchStop({ channelId }));
}

/**
 * Queue a video (wave 3).
 *
 * The `itemId` is minted HERE, by the client, and it is a uuid because the
 * schema demands one. It is the handle every later mutation names — remove,
 * reorder, play-now — so it must exist before the server has answered, and it
 * must survive a reconnect: the gateway treats a repeated add of the same
 * `itemId` as a no-op rather than a duplicate row, which is only true if the
 * retry carries the SAME id. Generating it per attempt would turn one flaky
 * network moment into two copies of the same video in the queue.
 *
 * Requires a live session (`WATCH_NOT_ACTIVE` otherwise) — the UI only offers
 * this from inside a running party, which is the same rule from the other side.
 */
export function addToWatchQueue(
  channelId: ChannelId,
  input: { videoRef: string; title?: string; durationSeconds?: number },
): void {
  lastWatchActionChannel = channelId;
  client.send(
    clientEvent.watchQueueAdd({
      channelId,
      itemId: crypto.randomUUID(),
      videoRef: input.videoRef,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.durationSeconds === undefined
        ? {}
        : { durationSeconds: input.durationSeconds }),
    }),
  );
}

/** Drop a queued item. An id that is already gone is a no-op server-side. */
export function removeFromWatchQueue(channelId: ChannelId, itemId: string): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchQueueRemove({ channelId, itemId }));
}

/**
 * Set the queue's order. The FULL desired order, not a delta — the server
 * applies the list against whatever it is holding, so a reorder computed from a
 * slightly stale view converges instead of corrupting.
 */
export function reorderWatchQueue(channelId: ChannelId, itemIds: string[]): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchQueueReorder({ channelId, itemIds }));
}

/** Skip straight to a queued item. */
export function playWatchQueueItem(channelId: ChannelId, itemId: string): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchQueuePlay({ channelId, itemId }));
}

/**
 * Tell the server the current video finished, so it can advance the queue.
 *
 * Sent by the HOST ONLY. Every client's player reaches the end at its own
 * moment (ads, buffering, drift), so if everyone reported it the server would
 * take the FIRST report as truth and the room would advance on whichever member
 * happened to be running ahead — and a viewer whose ad ended early would skip
 * the last seconds of the video for everybody. One reporter, the same one who
 * owns the transport. The gateway enforces this too (`NOT_HOST`); the client
 * simply does not produce frames it knows will be refused.
 *
 * `videoId` makes the report idempotent: the server ignores one that does not
 * match the session's current video, so a duplicate or late report cannot eat a
 * second item off the queue.
 */
export function reportWatchEnded(channelId: ChannelId, videoId: string): void {
  lastWatchActionChannel = channelId;
  client.send(clientEvent.watchEnded({ channelId, videoId }));
}

// ---------------------------------------------------------------------------
// Inbound event dispatch
// ---------------------------------------------------------------------------

/** True once this app session has completed at least one WS handshake. */
let hadHandshake = false;

function handleMessageCreated(payload: MessageDTO): void {
  const chat = useChatStore.getState();
  const me = useAuthStore.getState().user;
  const { nonce, ...message } = payload;

  chat.clearTyping(message.channelId, message.authorId);

  // Our own echo confirms the queued item — it leaves the queue (and its
  // persisted blob) here, and the drain moves on to the next one.
  if (nonce && me && message.authorId === me.id) {
    outbox.confirm(message.channelId, nonce);
  }

  insertMessage(message);

  const isOwn = me !== null && message.authorId === me.id;

  if (!isOwn) {
    // A message on a hidden DM re-surfaces it (server already un-hid its side).
    resurfaceHiddenDmIfNeeded(message.channelId);
  }

  const isMention = me !== null && contentMentionsUser(message.content, me.id, false);

  if (message.channelId !== chat.activeChannelId && !isOwn) {
    chat.markChannelUnread(message.channelId);
    // Flag a direct @mention so a "mentions"-muted channel still badges it
    // (broadcast @everyone/@here excluded, matching the server's mention push).
    if (isMention) {
      chat.markChannelMentionUnread(message.channelId);
    }
  }

  // Effective mute for this channel — its OWN mute or its enclosing server's
  // (migration 0013). A muted conversation must be fully SILENT: no sound, no
  // toast, matching the sidebar badge suppression. "mentions" mode still alerts
  // on a direct @mention. The unread FLAG above is always tracked regardless —
  // the display layer decides whether to paint it — so a mentions-muted stream
  // can still surface its mention pip.
  const muteMode = isOwn
    ? null
    : channelMuteModeFor(
        chat.notificationMutes,
        message.channelId,
        serverGroupIdForChannel(message.channelId),
      );
  const alertsMuted = muteMode === "all" || (muteMode === "mentions" && !isMention);

  // Notification sound: someone else's *user* message, not muted, not in Do Not
  // Disturb, and the user is not already READING that conversation. Never for our
  // own messages, and never for system notices (member joined/left).
  //
  // The "is the user reading it?" half is `shouldPlayMessageCue` — the SAME
  // policy module the toast uses (notifications/notify-policy.ts), so the cue and
  // the toast can never drift apart. It also fixes the cases the old inline
  // `channelId !== activeChannelId || !document.hasFocus()` test got wrong:
  // `activeChannelId` survives a jump to the Friends table and survives the
  // center swapping to the video stage, both of which used to silence a cue for
  // a conversation nobody was looking at.
  if (
    message.kind !== "system" &&
    !isOwn &&
    !alertsMuted &&
    shouldPlayMessageCue({
      doNotDisturb: isDoNotDisturb(),
      streamId: message.channelId,
      visible: visibleContext(),
    })
  ) {
    playSound("message");
  }

  // Toast (native OS toast on desktop / browser notification on web, with an
  // in-app fallback): same "someone else's user message, not muted" gate as the
  // sound above. The notification manager adds the rest (the visibility policy,
  // per-channel throttle, the enabled setting, sink selection and surface
  // resolution) so this stays a thin hand-off (CLAUDE.md §23 — media/notify
  // lifecycle out of the UI).
  if (message.kind !== "system" && !isOwn && !alertsMuted) {
    notifyIncomingMessage(message);
  }
}

function handleServerEvent(event: ServerToClientEvent): void {
  const chat = useChatStore.getState();

  switch (event.type) {
    case SERVER_EVENT.authSucceeded: {
      const me = useAuthStore.getState().user;
      // Peers only. The contract says the snapshot never carries us; a pre-M16
      // gateway did — MASKED, i.e. "offline" for an invisible user — so any self
      // entry is dropped here rather than trusted to be overwritten below.
      const entries = withoutSelfPresence(event.payload.presence, me?.id);
      // Seed our own dot from the EFFECTIVE status, not a hardcoded "online" — so
      // a reload/reconnect keeps the picked dnd/invisible/idle AND a live
      // auto-away (idle) that was in effect while the socket was down. The echo of
      // the re-assert below then replaces it with the account's derived status.
      const effective = getEffectiveSelfPresenceStatus();
      // Our own custom status is not in the snapshot (it excludes us), so seed it
      // from the durable copy on the session user — otherwise a reload would blank
      // our own status line until someone else's presence tick happened to carry it.
      if (me) {
        entries.push({
          userId: me.id,
          status: effective,
          customStatus: me.customStatus ?? null,
        });
      }
      chat.replacePresence(entries);
      chat.setConnectionStatus("online");
      // Re-assert the effective status to the gateway so peers repaint (invisible is
      // masked to offline server-side).
      //
      // ALWAYS — including "online". This used to skip the online case to save a
      // frame, on the theory that a fresh socket lands on the gateway's default.
      // It does not: `presence:status:<user>` is per-USER, carries no TTL, and is
      // only deleted when the user's LAST connection disconnects. So a device that
      // auto-flipped to "idle" and then went away (app closed, machine slept)
      // while any other session stayed connected leaves "idle" behind, and the
      // next client to connect adopts it in silence — the user is at their
      // keyboard, their own picker says "Çevrimiçi", and their friends see the
      // amber dot. Founder hit exactly this (2026-07-28).
      //
      // The status pick is per-device localStorage and the server is last-writer-
      // wins, so asserting our own view on connect is the same authority the
      // picker already has; it just stops a stale value from ruling by default.
      // One small frame per connection is not worth a presence that lies.
      if (me) {
        client.send(clientEvent.presenceUpdate({ userId: me.id, status: effective }));
      }
      // Seed "who is in each voice channel" from the handshake snapshot, so
      // occupancy renders immediately (and re-seeds on reconnect — self-healing a
      // missed delta). Absent from pre-occupancy servers → treated as empty.
      useVoiceOccupancyStore.getState().seed(event.payload.voiceOccupancy ?? []);
      // The gateway tracks our voice presence per WS connection and forgot it on
      // this fresh socket, so re-announce our current room — otherwise peers would
      // stop seeing us under the channel after a reconnect (§10).
      voiceAnnouncer.reset();
      // Re-report foreground/background on every (re)connect (#110): the gateway
      // defaults a fresh socket to "foreground", so a reconnect while hidden/tray
      // must correct that or the desktop looks awake and swallows the push.
      reportAppState();
      if (hadHandshake) {
        // Reconnect: anything could have happened while we were away.
        refetchServerState();
        // Calls included (call-UX plan K2.2). `call.accepted` is fan-out to the
        // sockets connected AT THAT INSTANT with no queue and no replay, so a socket
        // that blinked between invite and accept — a gateway restart on deploy is
        // enough — used to lose the answer FOREVER: the caller rang into a timeout
        // while the callee sat in a live room. Re-read the authoritative call and
        // settle FSM + media onto it. No-op when nothing is live.
        void getCallController()?.resyncActiveCall("reconnect");
      }
      hadHandshake = true;
      return;
    }

    case SERVER_EVENT.errorRaised: {
      const { nonce, message, code, retryAfterSeconds, channelId } = event.payload;
      // Our own voice.join refused (e.g. the gateway has not caught up with a
      // DM → group upgrade yet): the announcer retries it on a short backoff.
      if (channelId && voiceAnnouncer.refused(channelId, code)) return;
      if (nonce) {
        const queued = findQueuedItem(nonce);
        if (queued) {
          // The channel is gone, or we are no longer a member: retrying can only
          // fail again, so the item goes terminal and the user is told rather
          // than watching it burn its attempts and land as a mystery failure.
          const terminal = code === "CHANNEL_NOT_FOUND" || code === "NOT_A_MEMBER";
          outbox.reject(queued.channelId, nonce, terminal ? "channel_gone" : "rejected");
          // A DM send refused by a block (M18). The queue's own row copy is the
          // generic "rejected" line — deliberately, because the shared outbox key
          // union has no `blocked` member and is not this layer's to widen — so
          // the reason is surfaced ONCE at the app root instead. The copy there is
          // direction-free: the gateway sends this same code whichever side
          // blocked, and the UI must not make the two distinguishable (§28).
          if (code === "BLOCKED") notifyBlocked("message");
          // Slow mode rejection — arm the composer countdown for this channel.
          if (code === "SLOWMODE" && typeof retryAfterSeconds === "number") {
            chat.startSlowmodeCooldown(queued.channelId, retryAfterSeconds);
          }
        }
      } else if (WATCH_ONLY_ERROR_CODES.has(code) && lastWatchActionChannel) {
        // A watch-party refusal (M20). These three codes have exactly one
        // emitter in the whole gateway, so attributing them here cannot steal
        // another feature's error — and each needs its OWN wording ("join the
        // room", "ask the host", "nothing is running"), which is why the ADR
        // split them apart in the first place. The player renders the copy; this
        // layer never formats a message (the gateway's English string is for
        // logs, not for a Turkish-speaking user, §26).
        useWatchPartyStore
          .getState()
          .refuse(lastWatchActionChannel, code as WatchRefusal);
      } else {
        console.warn(`[realtime] gateway error: ${code} — ${message}`);
      }
      return;
    }

    case SERVER_EVENT.messageCreated:
      handleMessageCreated(event.payload);
      return;

    case SERVER_EVENT.messageUpdated: {
      const { nonce: _nonce, ...message } = event.payload;
      replaceMessage(message);
      return;
    }

    case SERVER_EVENT.messageDeleted:
      removeMessage(event.payload.channelId, event.payload.messageId);
      return;

    case SERVER_EVENT.typingStarted: {
      const me = useAuthStore.getState().user;
      if (me && event.payload.userId === me.id) return;
      chat.setTyping(event.payload.channelId, event.payload.userId, Date.now() + TYPING_TTL_MS);
      return;
    }

    case SERVER_EVENT.typingStopped:
      chat.clearTyping(event.payload.channelId, event.payload.userId);
      return;

    case SERVER_EVENT.presenceUpdated:
      // A frame about OURSELVES carries the account's REAL status (M16): how a
      // status picked on another device reaches this one's own dot. It is never
      // `offline` from a correct gateway — we are reading it on a live socket — so
      // a self "offline" is the peer mask a pre-M16 gateway sent an invisible
      // user, and painting it is exactly the bug that showed them offline.
      if (isStaleSelfPresence(event.payload, useAuthStore.getState().user?.id)) return;
      // `customStatus` (M18) rides along on every server-side presence broadcast,
      // so a peer's status line lands through the same event the roster already
      // repaints on — no second subscription, no extra audience. It is OPTIONAL on
      // the wire and the store treats "absent" as "don't touch", so a pre-M18 peer
      // (or a client-built payload) never clears a status it simply didn't carry.
      chat.setPresence(
        event.payload.userId,
        event.payload.status,
        event.payload.platform,
        event.payload.customStatus,
      );
      return;

    // Voice-channel occupancy deltas — WHO is in each voice channel, live. The
    // gateway broadcasts these to every member who can SEE the channel (not just
    // those in the room), so the channel sidebar shows occupants under each voice
    // channel and updates as people join/leave (incl. single-session eviction,
    // which the gateway broadcasts as a leave). The joined member's OWN rich view
    // (speaking/mic) still comes from the LiveKit voice store; this is the
    // cross-channel directory (§10/§27).
    case SERVER_EVENT.voiceParticipantJoined:
      useVoiceOccupancyStore
        .getState()
        .addOccupant(event.payload.channelId, event.payload.userId, event.payload.muted);
      return;
    case SERVER_EVENT.voiceParticipantLeft:
      useVoiceOccupancyStore
        .getState()
        .removeOccupant(event.payload.channelId, event.payload.userId);
      return;

    // Authoritative occupancy snapshot (state-resync), pushed right after
    // auth.succeeded on every (re)connect. Sourced from the media plane (LiveKit),
    // so it is the ground truth for who is connected and who is sharing: REPLACE
    // per-channel occupancy from it, healing any join/leave/screen-share desync a
    // missed delta left behind (the "I see a screen share, my peer doesn't" bug).
    // Channels absent from the snapshot are authoritatively empty; the subsequent
    // participant_joined/left deltas then process as usual on top of this baseline.
    case SERVER_EVENT.voiceResync:
      useVoiceOccupancyStore.getState().resync(event.payload.channels);
      return;

    // Single-active-session eviction (user-scoped): the user joined voice on
    // another device, so this device leaves the named room. Engine-guarded — a
    // no-op unless we are actually in it (the device that just joined ignores
    // it). The clean leave + localized notice surface off the voice store's
    // endedReason (VoiceEvictionToast), never as a scary error (§26).
    case SERVER_EVENT.voiceSessionReplaced:
      useVoiceStore.getState().sessionReplaced(event.payload.roomId);
      // A DM call whose room was taken over on another device must also end
      // cleanly (ADR 0012 §5) — the controller ignores it unless the replaced
      // room is the call's own room. Feed it after the voice store has evicted.
      getCallController()?.applyServerEvent(event);
      return;

    // Roles/permissions (M9, ADR 0007). All mutations are HTTP; these thin
    // server→client events just tell the client its cached role/member/channel
    // views are stale. Invalidate and refetch — the selection sync effect
    // (AppShell) re-picks a visible channel if the active one vanished.
    case SERVER_EVENT.roleCreated:
    case SERVER_EVENT.roleUpdated:
      // groupId lives on the role for create/update (protocol D3).
      invalidateGroupRoles(event.payload.role.groupId);
      return;

    case SERVER_EVENT.roleDeleted:
      invalidateGroupRoles(event.payload.groupId);
      return;

    case SERVER_EVENT.memberRolesUpdated:
      // A member's role set changed — repaint colors and, if it's us, our
      // visible channel list may differ (groupDetails is visibility-filtered).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    case SERVER_EVENT.channelAccessChanged:
      // A channel's visibility changed. Refetch the group's (filtered) channel
      // list + the channel's access roles; selection sync handles navigation.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channelRoles(event.payload.channelId),
      });
      return;

    // Channel & member lifecycle (task #43). All group-scoped. groupDetails is
    // the visibility-filtered {channels, members} view, so invalidating it
    // refetches the channel list and the roster. channel.created fixes a freshly
    // created channel staying invisible until you navigate away and back — the
    // gateway also subscribes this connection to the new channel; selection sync
    // (AppShell) re-picks a visible channel if the active one was deleted.
    case SERVER_EVENT.channelDeleted:
      // Anything still queued for a deleted channel can NEVER be delivered.
      // Drop it and tell the user (§26) rather than letting it retry into the
      // cap and then sit as a mystery failure.
      outbox.dropChannel(event.payload.channelId);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    case SERVER_EVENT.channelCreated:
    case SERVER_EVENT.channelUpdated:
    case SERVER_EVENT.memberJoined:
    case SERVER_EVENT.memberLeft:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // Group (server / flat group chat) lifecycle (task #49/#50). group.updated is
    // a live rename/re-icon — refresh the list + this group's details. group.deleted
    // tears the whole group down: voice teardown, drop caches, route out.
    case SERVER_EVENT.groupUpdated:
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.group.id),
      });
      return;

    case SERVER_EVENT.groupDeleted:
      handleGroupDeleted(event.payload.groupId);
      return;

    // Social layer (ADR 0010, user-scoped). All mutations are HTTP; these thin
    // events tell this client its friend/DM caches are stale. Invalidate and
    // refetch — the same live/refetch model as roles (M9). Works whether or not
    // the gateway fan-out (W3) is live: the acting client already invalidated on
    // mutation success, and these events light up the OTHER side once W3 ships.
    case SERVER_EVENT.friendRequestReceived:
      // Someone asked me → a new incoming request. Seed the requester so the
      // pending row renders a name/avatar without a round-trip.
      chat.upsertUsers([event.payload.requester]);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.friendRequests("incoming"),
      });
      // Desktop toast (click → friends surface). Gated in the manager (enabled +
      // window unfocused). This is user-scoped, so it only reaches the addressee.
      notifyFriendRequest(event.payload.requester);
      return;

    case SERVER_EVENT.friendRequestAccepted:
      // They accepted my request → we are friends; the outgoing request is gone.
      chat.upsertUsers([event.payload.friend]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.friendRequests("outgoing"),
      });
      return;

    case SERVER_EVENT.friendRemoved:
      // Decline / cancel / unfriend from the other party — any of the three
      // friendship lists could change; refresh all (payload carries the actor).
      invalidateSocialLists();
      return;

    case SERVER_EVENT.dmCreated:
      handleDmCreated(event.payload.dm);
      return;

    // We were added to a flat group chat (`group_chat.added`, user-scoped, ADR
    // 0005). The gateway already subscribed us to its stream; surface the group
    // in the home list and notify. The group-chat twin of `dm.created`.
    case SERVER_EVENT.groupChatAdded:
      handleGroupChatAdded(event.payload.group);
      return;

    // Notification mute changed on ANOTHER device (migration 0013, user-scoped).
    // Keep the local lookup live so this device's badges/dimming match at once;
    // `mute: null` means the target was unmuted.
    case SERVER_EVENT.notificationMuteUpdated: {
      const { scope, targetId, mute } = event.payload;
      if (mute) chat.setLocalMute(scope, targetId, { mode: mute.mode, until: mute.until });
      else chat.clearLocalMute(scope, targetId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationMutes });
      return;
    }

    // Reaction deltas (ADR 0011 §3), channel-scoped. Fold each into the target
    // message's cached summary; `mine` derives from the actor id so my own echo
    // is deduped and other users' reactions bump the shared count.
    case SERVER_EVENT.messageReactionAdded:
    case SERVER_EVENT.messageReactionRemoved: {
      const me = useAuthStore.getState().user;
      const { channelId, messageId, emoji, userId } = event.payload;
      const mine = me !== null && userId === me.id;
      const delta = event.type === SERVER_EVENT.messageReactionAdded ? 1 : -1;
      applyReactionDelta(channelId, messageId, emoji, delta, mine);
      return;
    }

    // DM call signalling (ADR 0012). These user-scoped control events drive the
    // shared call FSM (packages/client-core), which the desktop wraps in
    // `lib/call-controller` and binds to the ring / in-call UI (Wave 6). Media
    // never crosses the WS — the controller drives the LiveKit engine (§10/§35).
    case SERVER_EVENT.callInvite:
    case SERVER_EVENT.callAccepted:
    case SERVER_EVENT.callEnded:
    case SERVER_EVENT.callUpgraded:
      getCallController()?.applyServerEvent(event);
      return;

    // This session was signed out from another device (#98, user-scoped). The
    // gateway forwards this ONLY to the connection whose own session was revoked
    // and then closes it (4401) — so receiving it always means US. Log out NOW
    // (drop to sign-in with the "session expired" notice) rather than waiting for
    // the socket close; `sessionExpired()` is idempotent, so the subsequent 4401
    // close → onAuthExpired is a harmless no-op.
    case SERVER_EVENT.sessionRevoked:
      useAuthStore.getState().sessionExpired();
      return;

    // Someone we can see changed their public profile (name/avatar/banner/bio).
    // Repaint everywhere they appear (founder P0: a new photo must show up in the
    // member sidebar without a reload).
    case SERVER_EVENT.userUpdated:
      applyUserUpdate(event.payload.user);
      return;

    // Link previews arrived for a message (M17). Channel-scoped, additive: fold
    // the full replacement card set onto the cached message (a no-op if it is not
    // on a loaded page — the embeds still arrive on the next GET, whose MessageDTO
    // carries `embeds`). Rendered below the message text by MessageRow.
    case SERVER_EVENT.messageEmbedsUpdated: {
      const { channelId, messageId, embeds } = event.payload;
      applyEmbedsUpdate(channelId, messageId, embeds);
      return;
    }

    // Pin board changed (M17), channel-scoped. Two independent effects:
    //  1. flip `pinned` on the cached message so its row draws the marker — a
    //     no-op when the message is not on a loaded page (pinning something far
    //     up the scrollback is normal);
    //  2. invalidate the channel's pin query so an open pin panel refetches.
    // The event carries no message body on purpose, so the panel (not the socket)
    // is what fetches the pinned message's content.
    case SERVER_EVENT.messagePinned:
    case SERVER_EVENT.messageUnpinned: {
      const { channelId, messageId } = event.payload;
      const pinned = event.type === SERVER_EVENT.messagePinned;
      queryClient.setQueryData<MessagesCache>(queryKeys.messages(channelId), (data) =>
        foldMessagePin(data, messageId, pinned),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.pins(channelId) });
      return;
    }

    // A group's custom emoji changed (M17), group-scoped. Invalidate the group's
    // emoji list so both the picker and the `:name:` resolver pick it up; the
    // signed image URLs hang off their own query and are minted lazily, so there
    // is nothing else to do here. A deleted emoji simply stops resolving and its
    // shortcode renders as literal text again.
    case SERVER_EVENT.emojiCreated:
    case SERVER_EVENT.emojiDeleted: {
      const { groupId } = event.payload;
      void queryClient.invalidateQueries({ queryKey: queryKeys.customEmojis(groupId) });
      return;
    }

    // Server moderation (migration 0017), user-scoped: WE were kicked/banned from
    // a server. The authoritative teardown (drop this server's channels, leave any
    // of its voice rooms) already rode the group-scoped `member.left` the same
    // action published; here we refresh the group list + this server's details so
    // it drops out of the rail. The localized "you were removed/banned" toast is a
    // moderation-UI-wave concern — this stopgap keeps the exhaustive switch honest
    // and the caches correct without inventing UI copy.
    case SERVER_EVENT.memberKicked:
    case SERVER_EVENT.memberBanned:
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // The server disconnected US from a voice room (migration 0017, user-scoped),
    // and `reason` says why. The media teardown is driven server-side by the SFU
    // force-remove, so this event's job is the WORDING: it names the reason the
    // raw LiveKit disconnect cannot carry, so an alone-idle close never reads as
    // "you joined on another device" (§26). Unmapped reasons (`moderator`, and
    // anything a newer server sends) fall through to the existing behavior.
    case SERVER_EVENT.voiceDisconnected:
      useVoiceStore.getState().voiceDisconnected(event.payload);
      return;

    // Channel categories (M18, group-scoped). A create/rename only touches the
    // category cache — deliberately NOT groupDetails, so a rename never refetches
    // the whole channel + member payload (§27).
    case SERVER_EVENT.categoryCreated:
    case SERVER_EVENT.categoryUpdated:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.categories(event.payload.category.groupId),
      });
      return;

    // A delete and a reorder BOTH move channels: delete frees its channels to the
    // uncategorized list (FK ON DELETE SET NULL), reorder rewrites `categoryId` +
    // `position`. Either way the cached channel rows are stale, so both caches go.
    case SERVER_EVENT.categoryDeleted:
    case SERVER_EVENT.categoryReordered:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.categories(event.payload.groupId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // Custom status (M18, user-scoped → our own devices). Peers pick a status up
    // through `presence.updated`; this case is what keeps THIS user's other
    // windows in sync after they set it somewhere else.
    case SERVER_EVENT.customStatusUpdated: {
      chat.setCustomStatus(event.payload.userId, event.payload.text);
      const self = useAuthStore.getState().user;
      if (self && self.id === event.payload.userId) {
        const updated: User = {
          ...self,
          customStatus: event.payload.text,
          customStatusExpiresAt: event.payload.expiresAt,
        };
        useAuthStore.getState().setUser(updated);
        queryClient.setQueryData(queryKeys.me, updated);
      }
      void queryClient.invalidateQueries({ queryKey: ["profile", event.payload.userId] });
      return;
    }

    // Our OWN block list changed (M18, user-scoped) — from this device or another.
    // A thin RESYNC signal by design: the gateway has already re-derived our block
    // set and re-applied its message fan-out filter, so the client's job is to
    // drop every cache the block shows through. Messages included: history in
    // shared servers is filtered SERVER-side, so previously hidden messages appear
    // (or cached ones must disappear) only after a refetch.
    case SERVER_EVENT.blocksUpdated:
      void queryClient.invalidateQueries({ queryKey: queryKeys.blocks });
      void queryClient.invalidateQueries({ queryKey: ["profile", event.payload.userId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
      void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("incoming") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests("outgoing") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMessages });
      return;

    // Migration 0020 (ADR 0019). A note deliberately has NO event — it has a
    // single reader, so there is nobody else to notify.

    // Our OWN private-nickname map changed, from this device or another
    // (USER-scoped). Names are resolved client-side from this one cached map,
    // so re-reading it is the whole fix — nothing else holds a private label.
    case SERVER_EVENT.userNicknameUpdated:
      void queryClient.invalidateQueries({ queryKey: queryKeys.userNicknames });
      // …and the hydrated list behind the settings panel, which holds the same
      // facts joined to the renamed users (only mounted while that panel is open).
      void queryClient.invalidateQueries({ queryKey: queryKeys.userNicknameEntries });
      return;

    // A member's SERVER nickname or timeout changed (GROUP-scoped). Both live on
    // the membership row inside the group details payload, which is where the
    // roster, the user menu and the profile card all read them from.
    case SERVER_EVENT.memberNicknameUpdated:
    case SERVER_EVENT.memberTimeoutUpdated:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // Our own ignore list changed (USER-scoped, mirrors `blocks_updated`).
    // Nothing was hidden server-side, so there is no history to restore — the
    // client simply stops (or starts) folding that author's rows.
    case SERVER_EVENT.ignoresUpdated:
      void queryClient.invalidateQueries({ queryKey: queryKeys.ignores });
      return;

    // Watch party (M20, ADR 0016). `started` and `state` share one payload and
    // ONE client path: both are an upsert-by-channelId, so the opening frame,
    // the 5 s drift heartbeat, the join push and the reconnect snapshot all seat
    // the player on server truth without a "first frame" special case.
    case SERVER_EVENT.watchStarted:
    case SERVER_EVENT.watchState:
      useWatchPartyStore.getState().upsert(event.payload);
      return;

    // Explicit transfer OR the automatic handoff when the host leaves the room.
    // Silent by design: the controls simply appear/disappear where they belong.
    case SERVER_EVENT.watchHostChanged:
      useWatchPartyStore
        .getState()
        .setHost(event.payload.channelId, event.payload.hostId);
      return;

    // The host stopped it, or the room emptied. Either way the session is gone
    // server-side, so the stage clears rather than leaving an orphaned player
    // running against state nobody will ever refresh.
    case SERVER_EVENT.watchStopped:
      useWatchPartyStore
        .getState()
        .stop(event.payload.channelId, event.payload.reason);
      return;

    // The queue (M20). The server sends the COMPLETE list — on every change and
    // again on voice.join — so this is a replace, never a merge: the client owns
    // no queue state of its own to reconcile against.
    case SERVER_EVENT.watchQueueUpdated:
      useWatchPartyStore
        .getState()
        .setQueue(event.payload.channelId, event.payload.queue);
      return;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Client singleton + lifecycle
// ---------------------------------------------------------------------------

/** Gateway websocket URL — injected into the shared RealtimeClient (ADR 0002). */
const REALTIME_URL: string =
  (import.meta.env.VITE_REALTIME_URL as string | undefined) ?? "ws://localhost:4001";

const client = new RealtimeClient(
  // `platform: "desktop"` tags this connection so co-members/friends see a plain
  // dot for us (task #47) — the phone indicator is for mobile-only presences.
  // `clientSignature` is the client-gate mark: the SAME value the
  // api client sends as a header, so the gate cannot accept one transport and
  // refuse the other. Note it is not always "desktop" — apps/web mounts this
  // exact module and resolves to `demli-web/<ver>`.
  {
    realtimeUrl: REALTIME_URL,
    platform: "desktop",
    clientSignature: CLIENT_SIGNATURE,
  },
  {
    onEvent: handleServerEvent,
    onStatus: (status) => {
      useChatStore.getState().setConnectionStatus(status);
      // The queue drains only while the socket is genuinely open. Everything
      // else ("connecting", "reconnecting", "offline") keeps items parked, and
      // going offline re-queues anything that was in flight — safe because the
      // nonce makes the replay idempotent.
      outbox.setOnline(status === "online");
    },
    onGap: refetchServerState,
    onAuthExpired: () => useAuthStore.getState().sessionExpired(),
  },
);

// ---------------------------------------------------------------------------
// Voice presence announcement (client → gateway)
//
// The channel-list "who is in each voice channel" feature is driven by the
// gateway's `voice.participant_joined/left` broadcasts, which fire only when a
// client emits `voice.join` / `voice.leave`. The media engine (LiveKit) is what
// actually connects to the room, so we DERIVE those signals from the engine's
// state instead of coupling the store to the socket: whenever we are connected
// to (or riding out a reconnect on) a room, we announce it; when we leave, we
// retract. The gateway tracks this per WS connection and forgets it on every new
// socket, so `auth.succeeded` also re-announces (see the handler above).
// ---------------------------------------------------------------------------

/**
 * A DM call runs in an ephemeral LiveKit room `dmcall:<callId>` that is NOT a
 * channel (ADR 0012 §2), so it must never be announced as voice-channel
 * occupancy. After a seamless upgrade the two originals stay on that SAME room
 * while the surface becomes a group voice channel; the call controller sets this
 * override to that channel id so their occupancy IS announced there — media never
 * moves, only the occupancy signal does (§10/§35). Null for a plain 1-1 call.
 */
let callOccupancyChannel: ChannelId | null = null;

/** True for an ephemeral DM-call room (`dmcall:<callId>`), which is not a channel. */
function isCallRoom(roomId: string): boolean {
  return roomId.startsWith("dmcall:");
}

/** The room we should currently be announced in, or null. */
function currentVoiceRoom(): ChannelId | null {
  const { roomId, status } = useVoiceStore.getState();
  if (!roomId || (status !== "connected" && status !== "reconnecting")) return null;
  // Call rooms carry no channel occupancy on their own; only the post-upgrade
  // group voice channel (via the override) is announced.
  if (isCallRoom(roomId)) return callOccupancyChannel;
  return roomId as ChannelId;
}

/**
 * Point voice-channel occupancy at the post-upgrade group voice channel (or null
 * to clear). Called by the call controller as the FSM surface changes; re-runs
 * the announcement so co-members see the originals under the group's voice
 * channel even though media stays on the call room (ADR 0012 §6).
 */
export function setCallOccupancyChannel(channelId: ChannelId | null): void {
  callOccupancyChannel = channelId;
  syncVoiceAnnouncement();
}

/**
 * Reconcile what the gateway believes about our voice presence with the engine's
 * actual room (shared `createVoiceAnnouncer`). Idempotent and cheap: a no-op
 * unless the room changed, so the per-tick voice-store notifications
 * (speaking/participants) cost one comparison. A failed send (socket not open)
 * is recovered by the `auth.succeeded` re-announce; a REFUSED join is retried
 * by the announcer (see the `error.raised` handler).
 */
const voiceAnnouncer = createVoiceAnnouncer({
  join: (channelId) => client.send(clientEvent.voiceJoin({ channelId })),
  leave: (channelId) => client.send(clientEvent.voiceLeave({ channelId })),
  desired: currentVoiceRoom,
});

function syncVoiceAnnouncement(): void {
  voiceAnnouncer.sync();
}

// Announce room changes as the engine transitions (join → connected, leave →
// idle, eviction, reconnect). Registered once for the app lifetime.
useVoiceStore.subscribe(syncVoiceAnnouncement);

// ---------------------------------------------------------------------------
// App-focus occupancy pull (state-resync HTTP path)
//
// Regaining window focus PULLS the authoritative occupancy snapshot over HTTP
// (throttled ≥15s) and REPLACES the store — the same authoritative shape as the
// `voice.resync` event — healing any desync accrued while the window was in the
// background. A 503 VOICE_OCCUPANCY_UNAVAILABLE (or any error) keeps the current
// view; we never clear occupancy when a snapshot can't be produced (§26).
// ---------------------------------------------------------------------------

const occupancyPull = createThrottledOccupancyPull({
  fetchSnapshot: () => api.getVoiceOccupancy(),
  resync: (channels) => useVoiceOccupancyStore.getState().resync(channels),
  onError: (error) =>
    console.warn("[realtime] voice occupancy pull failed; keeping current view", error),
});

// ---------------------------------------------------------------------------
// App foreground/background report (#110, WhatsApp push gate)
//
// The gateway records this connection's foreground/background state and pushes
// to a user only when NONE of their live connections is foreground. The desktop
// has no bridge event for window focus/hide, so we derive it from the DOM:
// "foreground" == the window is VISIBLE and FOCUSED. Blurring to another app, or
// hiding to the tray / minimizing, reads as background (a message then earns an
// OS push). Re-reported on every handshake (auth.succeeded) so
// a reconnect while hidden corrects the gateway's default-"foreground".
// ---------------------------------------------------------------------------

function currentAppLifecycle(): AppLifecycleState {
  return document.visibilityState === "visible" && document.hasFocus()
    ? "foreground"
    : "background";
}

function reportAppState(): void {
  client.send(clientEvent.presenceAppState({ state: currentAppLifecycle() }));
}

function handleWindowFocus(): void {
  reportAppState();
  void occupancyPull.pull();
}

function handleWindowBlur(): void {
  reportAppState();
}

function handleVisibilityChange(): void {
  reportAppState();
  // Coming back into view is also a good moment to resync occupancy.
  if (document.visibilityState === "visible") void occupancyPull.pull();
}

let typingPruneTimer: number | null = null;

export function startRealtime(token: string): void {
  hadHandshake = false;
  // A brand-new session: the gateway knows nothing about our voice presence yet.
  voiceAnnouncer.forget();
  // Reset the pull throttle so this session's first window focus refreshes
  // occupancy immediately; re-adding the same listener ref is idempotent.
  occupancyPull.reset();
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  // Auto-away: after a stretch of no pointer/keyboard/touch activity, an ONLINE
  // user is flipped to "idle" for peers (founder "boşta modu"); activity flips it
  // back. Manual dnd/invisible/idle picks are respected (idle-auto.ts). The push
  // fn is injected so idle-auto stays decoupled from the socket wiring.
  startIdleAutoPresence(pushSelfPresenceToGateway);
  client.connect(token);
  if (typingPruneTimer === null) {
    typingPruneTimer = window.setInterval(
      () => useChatStore.getState().pruneTyping(Date.now()),
      TYPING_PRUNE_INTERVAL_MS,
    );
  }
}

export function stopRealtime(): void {
  client.disconnect();
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("blur", handleWindowBlur);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  // Tear down the inactivity detector (its listeners + timer) so a logged-out
  // session never keeps ticking or sends presence for a user who is gone.
  stopIdleAutoPresence();
  // Drop occupancy so a re-login starts clean; the gateway broadcasts our leave
  // to peers when the socket closes (handleClose → leaveVoice).
  voiceAnnouncer.forget();
  useVoiceOccupancyStore.getState().reset();
  // Same reasoning for the watch party: a session we can no longer receive
  // heartbeats for must not linger as a player projecting a position forever.
  lastWatchActionChannel = null;
  useWatchPartyStore.getState().reset();
  if (typingPruneTimer !== null) {
    window.clearInterval(typingPruneTimer);
    typingPruneTimer = null;
  }
  // The queue keeps its items (that is the point of persistence) but must stop
  // draining into a socket that is gone.
  outbox.setOnline(false);
  for (const [channelId, state] of composerTyping) {
    window.clearTimeout(state.idleTimer);
    composerTyping.delete(channelId);
  }
}

/**
 * Force a fresh handshake so the gateway re-subscribes this connection.
 * Required after membership changes (group/channel created, invite redeemed)
 * because the gateway snapshots channel access at connect time.
 */
export function resubscribeRealtime(): void {
  client.reconnectNow();
}
