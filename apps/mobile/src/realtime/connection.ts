/**
 * Realtime wiring — the single place where gateway events meet client state.
 * Mobile mirror of the desktop renderer's src/realtime/connection.ts.
 *
 * Differences from desktop, all mandated by the platform (ADR 0002/0004):
 * - `RealtimeClient` is created lazily from the baked `REALTIME_URL`
 *   (lib/server-config.ts) instead of a build-time `import.meta.env` constant.
 * - Message nonces come from expo-crypto (lib/id.ts) — Hermes has no
 *   `crypto.randomUUID`.
 * - Timers use the bare `setTimeout`/`clearInterval` RN globals, not `window.*`.
 *
 * Everything else (optimistic outbox → message.created reconciliation by nonce,
 * seq-gap refetch, throttled typing notifications) matches desktop exactly, and
 * event names still come from the SERVER_EVENT constants — never string
 * literals (CLAUDE.md §24).
 */
import type { InfiniteData } from "@tanstack/react-query";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import {
  RealtimeClient,
  createVoiceAnnouncer,
  isAppInForeground,
  isStaleSelfPresence,
  shouldPlayMessageCue,
  withoutSelfPresence,
  type MessagesPage,
  type RealtimeStatus,
} from "@demli/client-core";
import {
  SERVER_EVENT,
  clientEvent,
  contentMentionsUser,
  type AppLifecycleState,
  type MessageDTO,
  type MessageReactionPayload,
  type ServerToClientEvent,
} from "@demli/protocol";
import type {
  Attachment,
  ChannelId,
  Dm,
  FriendGroup,
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
import { foldMessageEmbeds } from "./embed-fold";
import { foldMessagePin } from "./pin-fold";
import {
  outbox,
  rememberOutboxMeta,
  setOutboxChannelGoneListener,
  setOutboxTransport,
} from "./outbox";
import { useInAppNotificationStore } from "../stores/in-app-notification-store";
import { router } from "expo-router";
import { AppState, type AppStateStatus } from "react-native";
import {
  friendlyErrorMessage,
  getApi,
  type FriendWithUser,
  type GroupChatDetails,
  type GroupDetails,
} from "../lib/clients";
import { blockChangeQueryKeys } from "../lib/block-sync";
import { DM_CALL_ROOM_PREFIX } from "../lib/call-room";
import type { DmWithPreview } from "../lib/dm-preview";
import { getCallController } from "../stores/call-store";
import { newId } from "../lib/id";
import { queryClient, queryKeys } from "../lib/query-client";
import { REALTIME_URL } from "../lib/server-config";
import { CLIENT_SIGNATURE } from "../lib/client-signature";
import { playSound } from "../sounds/sound-manager";
import { showInAppNotification } from "../stores/in-app-notification-store";
import { useAuthStore } from "../stores/auth-store";
import { getSelfPresenceStatus, useSelfPresenceStore } from "../stores/self-presence-store";
import { activeMuteMode, effectiveChannelMuteMode, useChatStore } from "../stores/chat-store";
import { resetVisibleStream, visibleContext } from "../notifications/visible-context";
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

type Timer = ReturnType<typeof setTimeout>;
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
        messages: page.messages.map((m) => (m.id === message.id ? message : m)),
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
// Reactions (ADR 0011 §3) — the two `message.reaction_*` events are DELTAS, not
// summaries. We fold each into the target message's cached `reactions`, deriving
// the per-viewer `reactedByMe` client-side by comparing `payload.userId` to our
// own id (the wire never carries it). The optimistic path and the initiator's
// own echo agree because the fold is idempotent per (emoji, viewer).
// ---------------------------------------------------------------------------

/**
 * Fold a single reaction delta into a message's summary array (pure). `kind` is
 * "add"/"remove"; `isMe` is whether the acting user is the viewer. Idempotent
 * per (emoji, viewer): re-adding my own reaction (already `reactedByMe`) or
 * removing one I don't hold is a no-op — so the server echo of my own optimistic
 * change never double-counts (enrich-gateway W4 handoff). Returns a NEW array on
 * change, else the SAME reference so callers can skip a needless cache write.
 */
function foldReaction(
  reactions: MessageReactionSummary[] | undefined,
  emoji: string,
  kind: "add" | "remove",
  isMe: boolean,
): MessageReactionSummary[] | undefined {
  const list = reactions ?? [];
  const idx = list.findIndex((r) => r.emoji === emoji);
  const entry = idx >= 0 ? list[idx] : undefined;

  if (kind === "add") {
    if (!entry) return [...list, { emoji, count: 1, reactedByMe: isMe }];
    if (isMe && entry.reactedByMe) return reactions; // idempotent: my own echo
    const next = [...list];
    next[idx] = { ...entry, count: entry.count + 1, reactedByMe: entry.reactedByMe || isMe };
    return next;
  }

  // remove
  if (!entry) return reactions;
  if (isMe && !entry.reactedByMe) return reactions; // idempotent: nothing of mine
  const nextCount = entry.count - 1;
  if (nextCount <= 0) return list.filter((_, i) => i !== idx); // last reactor left
  const next = [...list];
  next[idx] = { ...entry, count: nextCount, reactedByMe: isMe ? false : entry.reactedByMe };
  return next;
}

/**
 * Patch one message's `reactions` in the channel's cached pages via `update`.
 * A no-op (both when the message isn't loaded and when `update` returns the same
 * reference), so a delta for a message not on a loaded page is safely ignored.
 */
function updateMessageReactions(
  channelId: ChannelId,
  messageId: string,
  update: (
    reactions: MessageReactionSummary[] | undefined,
  ) => MessageReactionSummary[] | undefined,
): void {
  queryClient.setQueryData<MessagesCache>(queryKeys.messages(channelId), (data) => {
    if (!data || !cacheHasMessage(data, messageId)) return data;
    let mutated = false;
    const pages = data.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => {
        if (m.id !== messageId) return m;
        const next = update(m.reactions);
        if (next === m.reactions) return m;
        mutated = true;
        return { ...m, reactions: next };
      }),
    }));
    return mutated ? { ...data, pages } : data;
  });
}

/** Fold an inbound reaction delta (from the gateway) into the message cache. */
function applyReactionDelta(payload: MessageReactionPayload, kind: "add" | "remove"): void {
  const me = useAuthStore.getState().user;
  const isMe = !!me && payload.userId === me.id;
  updateMessageReactions(payload.channelId, payload.messageId, (reactions) =>
    foldReaction(reactions, payload.emoji, kind, isMe),
  );
}

/**
 * Toggle the viewer's reaction on a message from the UI: optimistically fold the
 * change now, fire the REST call (PUT add / DELETE remove), and roll back with
 * the inverse fold if the server rejects (a failed op emits no echo, so nothing
 * else will correct it). The live echo for our own userId is idempotent, so the
 * optimistic state and the eventual echo agree; authoritative counts return on
 * the next list refetch/reconnect (deltas are the live layer, W4 handoff).
 */
export function toggleReaction(
  channelId: ChannelId,
  messageId: MessageId,
  emoji: string,
  reactedByMe: boolean,
): void {
  const kind: "add" | "remove" = reactedByMe ? "remove" : "add";
  const inverse: "add" | "remove" = reactedByMe ? "add" : "remove";

  updateMessageReactions(channelId, messageId, (r) => foldReaction(r, emoji, kind, true));

  const call =
    kind === "add"
      ? getApi().addReaction(messageId, emoji)
      : getApi().removeReaction(messageId, emoji);
  call.catch((err: unknown) => {
    updateMessageReactions(channelId, messageId, (r) => foldReaction(r, emoji, inverse, true));
    console.warn(`[realtime] reaction ${kind} failed: ${friendlyErrorMessage(err)}`);
  });
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
 * Someone we can see changed their public profile — repaint every surface that
 * shows their name/photo, without a network round-trip. Mobile mirror of the
 * desktop renderer's handler for the same event.
 *
 * Surgical `setQueryData` patches rather than `invalidateQueries` on purpose
 * (§27): a profile edit by any visible user would otherwise refetch every cached
 * roster, and the roster is exactly the hot surface. The new `User` is already in
 * hand, so patching is both cheaper AND instant. Only the profile card is
 * invalidated — it carries friendship + role context this event does not.
 *
 * Covers: the user directory (message rows read author name/avatar from it), the
 * server member list, flat group-chat rosters, the friends list, and the Home DM
 * list (each row renders `participant.avatarUrl`).
 */
function applyUserUpdate(user: User): void {
  useChatStore.getState().upsertUsers([user]);

  // Own profile changed on another device — keep this session's identity in sync.
  if (useAuthStore.getState().user?.id === user.id) {
    // Merge, never replace: `user` is the PUBLIC projection, so assigning it
    // wholesale would drop the me-only fields (friendCode/birthdate/isAdult) this
    // client legitimately holds for itself.
    const self = useAuthStore.getState().user;
    if (self) {
      const merged = { ...self, ...user };
      useAuthStore.getState().setUser(merged);
      queryClient.setQueryData(queryKeys.me, merged);
    }
  }

  // Server rosters → the group member list. The prefix also matches the
  // ["groups"] list itself (FriendGroup[]), which has no `.members` — the
  // optional chain treats that as a miss and returns it untouched.
  queryClient.setQueriesData<GroupDetails>({ queryKey: queryKeys.groups }, (details) => {
    if (!details?.members?.some((m) => m.user.id === user.id)) return details;
    return {
      ...details,
      members: details.members.map((m) => (m.user.id === user.id ? { ...m, user } : m)),
    };
  });

  // Flat group-chat rosters.
  queryClient.setQueriesData<GroupChatDetails>({ queryKey: queryKeys.groupChats }, (details) => {
    if (!details?.members?.some((m) => m.user.id === user.id)) return details;
    return {
      ...details,
      members: details.members.map((m) => (m.user.id === user.id ? { ...m, user } : m)),
    };
  });

  // Friends list.
  queryClient.setQueryData<FriendWithUser[]>(queryKeys.friends, (friends) => {
    if (!friends?.some((f) => f.user.id === user.id)) return friends;
    return friends.map((f) => (f.user.id === user.id ? { ...f, user } : f));
  });

  // DM list (the counterpart's name/photo on the Home rows). Spread-patched so
  // the API-built `lastMessagePreview` survives the swap.
  queryClient.setQueryData<DmWithPreview[]>(queryKeys.dms, (dms) => {
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
 * home group-chat list (deduped) and refetch the authoritative list, then raise a
 * visible + audible in-app heads-up. We do NOT auto-open it — the user picks it.
 */
function handleGroupChatAdded(group: Group): void {
  queryClient.setQueryData<Group[]>(queryKeys.groupChats, (list) => {
    const rest = (list ?? []).filter((g) => g.id !== group.id);
    return [group, ...rest];
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });
  playSound("message");
  showInAppNotification({
    kind: "message",
    titleKey: "mobile:notif.addedToGroupTitle",
    bodyKey: "mobile:notif.addedToGroupBody",
    bodyParams: { name: group.name },
    href: { pathname: "/group-chat/[groupChatId]", params: { groupChatId: group.id, name: group.name } },
  });
}

/** Re-surface a hidden DM on inbound at most this often (guards refetch storms). */
const DM_RESURFACE_THROTTLE_MS = 5_000;
let lastDmResurfaceAt = 0;

/**
 * A background inbound message landed on `channelId`. If that stream is NOT
 * among our visible DMs it may be a DM we had hidden/closed: the server unhides
 * it on its side but does not re-emit `dm.created` per message (gateway W3
 * note), so we refetch the DM list to re-surface it. The message itself already
 * flowed into the channel cache via insertMessage — this only fixes the LIST.
 *
 * The client can't cheaply tell a hidden-DM stream from an ordinary channel, so
 * to keep this from refetching /dms on every server-channel message (the Home
 * screen always observes the DM list) it is throttled AND skipped for streams
 * already visible as DMs. Callers only invoke it for background inbound messages
 * (never the active conversation), so the active DM never triggers it.
 */
function maybeResurfaceDm(channelId: ChannelId): void {
  const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms);
  if (dms?.some((d) => d.streamId === channelId)) return;
  const now = Date.now();
  if (now - lastDmResurfaceAt < DM_RESURFACE_THROTTLE_MS) return;
  lastDmResurfaceAt = now;
  void queryClient.invalidateQueries({ queryKey: queryKeys.dms });
}

/**
 * Refresh the DM list's last-message preview + order live (mobile Home rows).
 * If `message`'s channel is a visible DM stream, patch that DM's
 * `lastMessagePreview` from the message and hoist it to the top so the Home
 * conversation list mirrors what just arrived without a refetch. A no-op for
 * non-DM streams and for DMs not currently in the list (a hidden DM re-surfaces
 * via `maybeResurfaceDm`, whose refetch carries the API-built preview).
 */
function updateDmPreview(message: Message): void {
  queryClient.setQueryData<DmWithPreview[]>(queryKeys.dms, (list) => {
    if (!list) return list;
    const idx = list.findIndex((d) => d.streamId === message.channelId);
    if (idx === -1) return list;
    const current = list[idx];
    if (!current) return list;
    const updated: DmWithPreview = {
      ...current,
      lastMessagePreview: {
        content: message.content,
        authorId: message.authorId,
        kind: message.kind ?? "user",
        createdAt: message.createdAt,
      },
    };
    return [updated, ...list.filter((_, i) => i !== idx)];
  });
}

/**
 * A whole server / flat group chat was deleted (owner delete OR auto-deleted
 * when its last member left — task #50). Tear down anything still pointing at it
 * and drop it from every cached list.
 */
function handleGroupDeleted(groupId: GroupId): void {
  const chat = useChatStore.getState();

  // Voice teardown: if we are sitting in a voice room of the deleted server, end
  // the media session (LiveKit). channelMeta carries the room's owning groupId.
  const voice = useVoiceStore.getState();
  if (voice.roomId && voice.channelMeta?.groupId === groupId) {
    voice.leave();
  }

  // Prune the group's caches, then refresh both lists so the groups/home screens
  // drop it.
  queryClient.removeQueries({ queryKey: queryKeys.groupDetails(groupId) });
  queryClient.removeQueries({ queryKey: queryKeys.groupChatDetails(groupId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
  void queryClient.invalidateQueries({ queryKey: queryKeys.groupChats });

  // Route out of the deleted group if we are currently viewing it (a channel/
  // stream of it is active), so we never sit on a screen for a gone group.
  if (chat.activeGroupId === groupId) {
    chat.clearActiveChannel();
    router.navigate("/groups");
  }
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
/**
 * Queued messages the queue had to abandon (M17): their channel was deleted, or
 * we lost access. They can NEVER be delivered, and silently dropping them would
 * be the worst outcome — the user typed something and would assume it went
 * through. The in-app banner is the right surface precisely because the channel
 * they belonged to is gone, so there is no thread left to show it in (§26).
 */
setOutboxChannelGoneListener((_channelId, dropped) => {
  if (dropped.length === 0) return;
  useInAppNotificationStore.getState().show({
    kind: "message",
    titleKey: "mobile:message.failed",
    bodyKey: "mobile:message.queueChannelGone",
  });
});

setOutboxTransport(
  (item) =>
    client?.send(
      clientEvent.messageSend({
        channelId: item.channelId,
        content: item.content,
        nonce: item.nonce,
        ...(item.attachmentIds && item.attachmentIds.length > 0
          ? { attachmentIds: item.attachmentIds }
          : {}),
        ...(item.replyToMessageId ? { replyToMessageId: item.replyToMessageId } : {}),
      }),
    ) ?? false,
);

/**
 * Optimistically append and send a message over the gateway. `attachments` is
 * ready (uploaded + completed) metadata from the composer tray (ADR 0008);
 * content may be empty when attachments are present — the shared schema
 * enforces content-OR-attachments. `replyTo` (ADR 0011 §2) threads the reply
 * target into the send and renders the quote line on the optimistic row until
 * the server echo carries its own built preview.
 */
export function sendChatMessage(
  channelId: ChannelId,
  rawContent: string,
  attachments?: Attachment[],
  replyTo?: MessageReplyPreview,
): void {
  const content = rawContent.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if ((content.length === 0 && !hasAttachments) || content.length > MESSAGE_MAX_LENGTH) return;
  const me = useAuthStore.getState().user;
  if (!me) return;

  const nonce = newId();
  // Render-only extras (attachment metadata, the reply quote) are deliberately
  // NOT part of the persisted item — they are re-derivable from the caches — so
  // they go to the projection layer, not to the queue.
  rememberOutboxMeta(nonce, {
    ...(hasAttachments && attachments ? { attachments } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
  outbox.enqueue({
    nonce,
    channelId,
    authorId: me.id,
    content,
    createdAt: new Date().toISOString(),
    ...(hasAttachments && attachments
      ? { attachmentIds: attachments.map((a) => a.id) }
      : {}),
    ...(replyTo ? { replyToMessageId: replyTo.id } : {}),
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
// Self presence (the status picker) — mobile mirror of the desktop path.
// ---------------------------------------------------------------------------

/**
 * Set the active user's CHOSEN presence status and broadcast it. Persists the
 * pick (survives reload / account switch), repaints our own dot locally at once,
 * and tells the gateway so peers repaint — `invisible` is masked to `offline`
 * server-side, so peers only ever see online/idle/dnd/offline. Our own sockets
 * get the account's REAL status back (M16, see `presence.updated` below): the
 * derived answer across every device, so a `dnd`/`invisible` still declared on
 * the desktop outranks this pick (ADR 0020) and our dot follows it.
 *
 * `dnd` / `invisible` change only PRESENTATION + peer visibility here; no local
 * notification/call gating is wired in this wave (deferred, low-risk parity).
 */
export function setSelfPresenceStatus(status: SelectablePresenceStatus): void {
  const me = useAuthStore.getState().user;
  if (!me) return;
  // A manual pick is authoritative and overrides any auto-idle in effect.
  autoIdleActive = false;
  useSelfPresenceStore.getState().setStatus(me.id, status);
  useChatStore.getState().setPresence(me.id, status);
  client?.send(clientEvent.presenceUpdate({ userId: me.id, status }));
}

// ---------------------------------------------------------------------------
// Auto-idle (M15) — the away behavior on mobile.
//
// While the CHOSEN status is "online" we flip the broadcast presence to "idle"
// when the app is backgrounded/inactive OR after a stretch of no on-screen
// interaction, and back to online on return/interaction. A manual dnd / invisible
// / idle pick is NEVER overridden — auto-idle only ever touches an "online" user.
// The chosen status persists unchanged; auto-idle is a transient broadcast layer,
// so `getSelfPresenceStatus()` (the reconnect re-assert) still returns "online".
// ---------------------------------------------------------------------------

/** Foreground inactivity before we auto-idle (~5 min, same as desktop). */
const FOREGROUND_IDLE_MS = 5 * 60_000;
/** True while auto-idle is masking an otherwise-online user as idle. */
let autoIdleActive = false;
let foregroundIdleTimer: Timer | null = null;

/** Broadcast + repaint our own presence to `status` (no persistence). */
function broadcastSelfPresence(status: SelectablePresenceStatus): void {
  const me = useAuthStore.getState().user;
  if (!me) return;
  useChatStore.getState().setPresence(me.id, status);
  client?.send(clientEvent.presenceUpdate({ userId: me.id, status }));
}

/** Enter auto-idle — only when the chosen status is "online" and not already idle. */
function enterAutoIdle(): void {
  if (autoIdleActive) return;
  if (getSelfPresenceStatus() !== "online") return; // never override a manual pick
  autoIdleActive = true;
  broadcastSelfPresence("idle");
}

/** Leave auto-idle, restoring the chosen (online) status. No-op when not idle. */
function resumeFromAutoIdle(): void {
  if (!autoIdleActive) return;
  autoIdleActive = false;
  broadcastSelfPresence(getSelfPresenceStatus());
}

function clearForegroundIdleTimer(): void {
  if (foregroundIdleTimer !== null) {
    clearTimeout(foregroundIdleTimer);
    foregroundIdleTimer = null;
  }
}

function armForegroundIdleTimer(): void {
  clearForegroundIdleTimer();
  foregroundIdleTimer = setTimeout(enterAutoIdle, FOREGROUND_IDLE_MS);
}

/**
 * Note on-screen user activity (touches, from the authed layout's capture-phase
 * responder). While foreground it cancels any auto-idle and restarts the
 * inactivity countdown. Cheap and idempotent — safe to call on every touch.
 */
export function noteUserActivity(): void {
  if (AppState.currentState !== "active") return;
  resumeFromAutoIdle();
  armForegroundIdleTimer();
}

// ---------------------------------------------------------------------------
// Composer typing notifications
// ---------------------------------------------------------------------------

interface ComposerTypingState {
  lastStartSentAt: number;
  idleTimer: Timer;
}

const composerTyping = new Map<ChannelId, ComposerTypingState>();

function sendTypingStop(channelId: ChannelId): void {
  const me = useAuthStore.getState().user;
  if (me) client?.send(clientEvent.typingStop({ channelId, userId: me.id }));
}

/** Call on every non-empty composer change; throttles typing.start itself. */
export function notifyComposerTyping(channelId: ChannelId): void {
  const me = useAuthStore.getState().user;
  if (!me) return;

  const now = Date.now();
  const existing = composerTyping.get(channelId);
  if (existing) clearTimeout(existing.idleTimer);

  if (!existing || now - existing.lastStartSentAt >= TYPING_START_THROTTLE_MS) {
    client?.send(clientEvent.typingStart({ channelId, userId: me.id }));
  }

  composerTyping.set(channelId, {
    lastStartSentAt:
      existing && now - existing.lastStartSentAt < TYPING_START_THROTTLE_MS
        ? existing.lastStartSentAt
        : now,
    idleTimer: setTimeout(() => {
      composerTyping.delete(channelId);
      sendTypingStop(channelId);
    }, TYPING_IDLE_MS),
  });
}

/** Call when the composer empties, sends, or unmounts. */
export function notifyComposerIdle(channelId: ChannelId): void {
  const existing = composerTyping.get(channelId);
  if (!existing) return;
  clearTimeout(existing.idleTimer);
  composerTyping.delete(channelId);
  sendTypingStop(channelId);
}

// ---------------------------------------------------------------------------
// Inbound event dispatch
// ---------------------------------------------------------------------------

/** True once this app session has completed at least one WS handshake. */
let hadHandshake = false;

// ---------------------------------------------------------------------------
// Foreground message banner (#110)
//
// While the app is ACTIVE, a message on a stream the user is NOT looking at
// slides a top banner (sender + preview → tap opens the chat). The OS push owns
// the app-closed/backgrounded case, so this fires only in the foreground.
// Notification mutes are honored exactly like the push gate ("all" → never;
// "mentions" → only a direct @mention). Own messages and system notices never
// banner (gated by the caller).
// ---------------------------------------------------------------------------

type BannerTarget = { pathname: string; params: Record<string, string> };

/** Resolve the tap target for a message's stream (DM → group chat → server channel). */
function messageBannerTarget(channelId: ChannelId): BannerTarget | null {
  const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms) ?? [];
  const dm = dms.find((d) => d.streamId === channelId);
  if (dm) {
    return {
      pathname: "/dm/[dmId]",
      params: {
        dmId: dm.id,
        streamId: dm.streamId,
        name: dm.participant.displayName,
        userId: dm.participant.id,
      },
    };
  }

  const groupChats = queryClient.getQueryData<Group[]>(queryKeys.groupChats) ?? [];
  const gc = groupChats.find((g) => g.streamId === channelId);
  if (gc) {
    return { pathname: "/group-chat/[groupChatId]", params: { groupChatId: gc.id, name: gc.name } };
  }

  const groups = queryClient.getQueryData<FriendGroup[]>(queryKeys.groups) ?? [];
  for (const g of groups) {
    if (g.kind !== "server") continue;
    const details = queryClient.getQueryData<GroupDetails>(queryKeys.groupDetails(g.id));
    const channel = details?.channels.find((c) => c.id === channelId);
    if (channel) {
      return {
        pathname: "/channel/[channelId]",
        params: { channelId, groupId: g.id, name: channel.name },
      };
    }
  }
  return null;
}

/** One-line, mention-readable, length-capped message preview for the banner body. */
function bannerPreview(content: string, users: Record<UserId, User>): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  const readable = oneLine.replace(/<@([^>]+)>/g, (_m: string, id: string) => {
    const u = users[id as UserId];
    return u ? `@${u.displayName || u.username}` : "@";
  });
  return readable.length > 120 ? `${readable.slice(0, 119)}…` : readable;
}

/** Show the foreground in-app banner for a background message, honoring mutes. */
function maybeShowMessageBanner(message: Message, isMention: boolean): void {
  // Foreground only — the OS push owns the app-closed / backgrounded case.
  if (!isAppInForeground(visibleContext())) return;
  const chat = useChatStore.getState();
  const target = messageBannerTarget(message.channelId);
  // Mute check: a server channel (target carries its groupId) honors group-mute
  // precedence; a DM / group chat is muted only at its own stream scope.
  const groupId =
    target?.pathname === "/channel/[channelId]" ? (target.params.groupId as GroupId) : null;
  const muteMode = groupId
    ? effectiveChannelMuteMode(chat.notificationMutes, message.channelId, groupId)
    : activeMuteMode(chat.notificationMutes, "channel", message.channelId);
  if (muteMode === "all") return;
  if (muteMode === "mentions" && !isMention) return;

  const author = chat.users[message.authorId];
  const senderName = author?.displayName || author?.username || null;
  const preview = bannerPreview(message.content, chat.users);

  showInAppNotification({
    kind: "message",
    ...(senderName ? { titleText: senderName } : { titleKey: "mobile:notif.newMessage" }),
    ...(preview ? { bodyText: preview } : { bodyKey: "mobile:direct.attachmentPreview" }),
    ...(target ? { href: target } : {}),
  });
}

// ---------------------------------------------------------------------------
// Watch party — outbound frames (M20, ADR 0016)
//
// Mobile mirror of the desktop renderer's block. Every one of these is a plain
// send: the CLIENT never decides whether the user may do it. The gateway owns
// authority (host, or the server owner override) and re-decides every frame, so
// a second opinion here could only drift from the real one. The UI hides what
// the user cannot do so there is no dead button (§35); these functions never
// pretend to be the gate.
// ---------------------------------------------------------------------------

/**
 * The channel our last watch frame concerned.
 *
 * `error.raised` carries no channel and no correlation id, so a refusal has to be
 * attributed to something. This is that something — and it is accurate, because a
 * client can only be in ONE voice channel at a time, which is the only channel it
 * can send a `watch.*` frame for. Cleared on teardown.
 */
let lastWatchActionChannel: ChannelId | null = null;

/** Codes emitted ONLY by the watch-party coordinator — safe to attribute. */
const WATCH_ONLY_ERROR_CODES = new Set<string>([
  "NOT_IN_VOICE",
  "NOT_HOST",
  "WATCH_NOT_ACTIVE",
  // The queue's own refusal. Same property as the other three — the coordinator
  // is its only emitter in the whole gateway — and the only one of the four the
  // user can fix on the spot, so it must reach the sheet rather than a console
  // warning nobody reads.
  "WATCH_QUEUE_FULL",
]);

/** Start (or replace) the party in a voice channel with a pasted link/id. */
export function startWatchParty(channelId: ChannelId, videoRef: string): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchStart({ channelId, source: "youtube", videoRef }));
}

/** Play / pause / seek, at the position the controller's own player is at. */
export function controlWatchParty(
  channelId: ChannelId,
  action: "play" | "pause" | "seek",
  positionSec: number,
): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchControl({ channelId, action, positionSec }));
}

/** Swap the video without ending the session. */
export function setWatchPartyVideo(channelId: ChannelId, videoRef: string): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchSetVideo({ channelId, videoRef }));
}

/** Hand control to another occupant of the same voice channel. */
export function transferWatchPartyHost(channelId: ChannelId, toUserId: UserId): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchTransferHost({ channelId, toUserId }));
}

/** End the session for everyone. */
export function stopWatchParty(channelId: ChannelId): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchStop({ channelId }));
}

/**
 * Queue a video.
 *
 * The `itemId` is minted HERE, by the client, and it is a uuid because the schema
 * demands one. It is the handle every later mutation names — remove, reorder,
 * play-now — so it must exist before the server has answered, and it must survive
 * a reconnect: the gateway treats a repeated add of the same `itemId` as a no-op
 * rather than a duplicate row, which is only true if the retry carries the SAME
 * id. Generating it per attempt would turn one flaky moment on mobile data into
 * two copies of the same video in the queue — and on a phone, flaky moments are
 * the normal case.
 */
export function addToWatchQueue(
  channelId: ChannelId,
  input: { videoRef: string; title?: string; durationSeconds?: number },
): void {
  lastWatchActionChannel = channelId;
  client?.send(
    clientEvent.watchQueueAdd({
      channelId,
      itemId: newId(),
      videoRef: input.videoRef,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    }),
  );
}

/** Drop a queued item. An id that is already gone is a no-op server-side. */
export function removeFromWatchQueue(channelId: ChannelId, itemId: string): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchQueueRemove({ channelId, itemId }));
}

/**
 * Set the queue's order. The FULL desired order, not a delta — the server applies
 * the list against whatever it is holding, so a reorder computed from a slightly
 * stale view converges instead of corrupting.
 */
export function reorderWatchQueue(channelId: ChannelId, itemIds: string[]): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchQueueReorder({ channelId, itemIds }));
}

/** Skip straight to a queued item. */
export function playWatchQueueItem(channelId: ChannelId, itemId: string): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchQueuePlay({ channelId, itemId }));
}

/**
 * Tell the server the current video finished, so it can advance the queue.
 *
 * Sent by the HOST ONLY. Every client's player reaches the end at its own moment
 * (ads, buffering, a phone that was backgrounded and resynced late), so if
 * everyone reported it the server would take the FIRST report as truth and the
 * room would advance on whichever member happened to be running ahead — and a
 * viewer whose ad ended early would skip the last seconds of the video for
 * everybody. One reporter, the same one who owns the transport. The gateway
 * enforces this too (`NOT_HOST`); the client simply does not produce frames it
 * knows will be refused.
 *
 * `videoId` makes the report idempotent: the server ignores one that does not
 * match the session's current video, so a duplicate or late report cannot eat a
 * second item off the queue.
 */
export function reportWatchEnded(channelId: ChannelId, videoId: string): void {
  lastWatchActionChannel = channelId;
  client?.send(clientEvent.watchEnded({ channelId, videoId }));
}

function handleMessageCreated(payload: MessageDTO): void {
  const chat = useChatStore.getState();
  const me = useAuthStore.getState().user;
  const { nonce, ...message } = payload;

  chat.clearTyping(message.channelId, message.authorId);

  // Our own echo confirms the queued item — it leaves the queue (and its
  // persisted file) here, and the drain moves on to the next one.
  if (nonce && me && message.authorId === me.id) {
    outbox.confirm(message.channelId, nonce);
  }

  insertMessage(message);
  // Keep the Home DM list's preview + ordering current (no-op off DM streams).
  updateDmPreview(message);

  if (!me || message.authorId !== me.id) {
    // Tag the unread as a mention when it directly @mentions us so a
    // "mentions"-muted channel still surfaces an indicator (fast-path gated on
    // the marker).
    const isMention =
      !!me && message.content.includes("<@") && contentMentionsUser(message.content, me.id);

    // UNREAD is about the thread being open at all: a mounted-but-covered thread
    // will show the message the moment the user comes back to it, so
    // `activeChannelId` remains the right question here.
    if (message.channelId !== chat.activeChannelId) {
      // Background inbound: flag unread, and (throttled) re-surface a DM the
      // server unhid on its side without re-emitting dm.created (gateway W3).
      chat.markChannelUnread(message.channelId, isMention);
      maybeResurfaceDm(message.channelId);
    }

    // ALERTING asks a stricter question — is the user actually LOOKING at this
    // conversation — and it is now the shared client-core rule, the same one
    // desktop uses. `activeChannelId` was wrong for this: a chat covered by a
    // pushed screen (voice room, settings, a profile) still claimed it, so the
    // sound and banner were silently dropped while the user was elsewhere.
    // Never for our own messages, never for system notices (member joined/left).
    // Enable/volume gating lives in the manager (CLAUDE.md §26).
    //
    // Do Not Disturb (the status picker) silences the in-app message sound +
    // banner exactly like desktop's notification manager — the unread marker
    // above still fires, so the message is not lost, just quiet. The OS push and
    // the call ring are intentionally NOT gated here.
    const alertable =
      message.kind !== "system" &&
      shouldPlayMessageCue({
        doNotDisturb: getSelfPresenceStatus() === "dnd",
        streamId: message.channelId,
        visible: visibleContext(),
      });
    if (alertable) {
      playSound("message");
      // Foreground in-app banner (#110): sender + preview → tap opens the chat.
      // Mute-filtered inside; never fires when backgrounded (OS push covers that).
      maybeShowMessageBanner(message, isMention);
    }
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
      // Seed our own dot from the persisted CHOSEN status, not a hardcoded
      // "online" — so a reload/reconnect keeps the picked dnd/invisible/idle. The
      // echo of the re-assert below then replaces it with the account's derived
      // status.
      const chosen = getSelfPresenceStatus();
      // If auto-idle is masking an online user (backgrounded / inactive), re-assert
      // "idle" on this fresh socket instead of "online" — a reconnect while away
      // must not repaint the phone as awake.
      const effective = autoIdleActive && chosen === "online" ? "idle" : chosen;
      if (me) {
        // Our own custom status is not in the snapshot (it excludes us), so seed
        // it from the durable copy on the session user — otherwise a reconnect
        // would blank our own status line until someone else's presence tick
        // happened to carry it.
        entries.push({ userId: me.id, status: effective, customStatus: me.customStatus ?? null });
        // Self-heal the author directory on EVERY (re)connect — including the
        // account-switch bringup, which reconnects with the new identity before
        // its profile refresh lands. A missing self entry is user-visible: own
        // messages would render as "unknown author" (founder P0).
        chat.upsertUsers([me]);
      }
      chat.replacePresence(entries);
      chat.setConnectionStatus("online");
      // Re-assert the effective status to the gateway so peers repaint (invisible
      // is masked to offline server-side).
      //
      // ALWAYS — including "online", for the reason spelled out in the desktop
      // twin: `presence:status:<user>` is per-USER, has no TTL, and is only
      // deleted when the user's LAST connection goes. A device that auto-flipped
      // to "idle" and then vanished leaves that behind, and a client that skips
      // asserting "online" silently inherits it — an active user showing away to
      // their friends while their own picker reads "Çevrimiçi".
      //
      // The phone matters most here: it is usually the session that OUTLIVES the
      // desktop, so it is what keeps the stale value alive.
      if (me) {
        client?.send(clientEvent.presenceUpdate({ userId: me.id, status: effective }));
      }
      // Seed "who is in each voice channel" from the handshake snapshot, so
      // occupancy renders immediately (and re-seeds on reconnect — self-healing a
      // missed delta). Absent from pre-occupancy servers → treated as empty.
      useVoiceOccupancyStore.getState().seed(event.payload.voiceOccupancy ?? []);
      // Seed notification mutes on (re)connect so muted channels/servers dim and
      // drop their unread badge immediately (and self-heal any missed
      // `notification_mute.updated`). Best-effort — a failure just leaves the
      // last-known set in place.
      void getApi()
        .listNotificationMutes()
        .then(({ mutes }) => useChatStore.getState().replaceNotificationMutes(mutes))
        .catch(() => undefined);
      // The gateway tracks our voice presence per WS connection and forgot it on
      // this fresh socket, so re-announce our current room — otherwise peers would
      // stop seeing us under the channel after a reconnect (§10).
      voiceAnnouncer.reset();
      // Re-report our foreground/background state on every (re)connect (#110):
      // the gateway defaults a fresh socket to "foreground", so a reconnect that
      // happened while backgrounded MUST correct that or the phone looks awake.
      reportAppState();
      if (hadHandshake) {
        // Reconnect: anything could have happened while we were away.
        refetchServerState();
        // Calls included (call-UX plan K2.2). `call.accepted` is fan-out to the
        // sockets connected AT THAT INSTANT with no queue and no replay, so a
        // socket that blinked between invite and accept — a phone changing from
        // wifi to mobile data, a screen-off doze, a gateway restart on deploy —
        // used to lose the answer FOREVER: the caller rang into a timeout while
        // the callee sat in a live room, and the row stayed `active` so every
        // retry was locked out too. Re-read the authoritative call and settle FSM
        // + media onto it. No-op when nothing is live.
        void getCallController().resyncActiveCall("reconnect");
      }
      hadHandshake = true;
      return;
    }

    case SERVER_EVENT.errorRaised: {
      const { code, nonce, message, retryAfterSeconds, channelId } = event.payload;
      // Our own voice.join refused (e.g. the gateway has not caught up with a
      // DM → group upgrade yet): the announcer retries it on a short backoff.
      if (channelId && voiceAnnouncer.refused(channelId, code)) return;
      if (nonce) {
        const queued = findQueuedItem(nonce);
        if (queued) {
          // The channel is gone, or we are no longer a member: retrying can only
          // fail again, so the item goes terminal and the user is told rather
          // than watching it burn its attempts into a mystery failure.
          const terminal = code === "CHANNEL_NOT_FOUND" || code === "NOT_A_MEMBER";
          outbox.reject(queued.channelId, nonce, terminal ? "channel_gone" : "rejected");
          // SLOWMODE carries how long until this member may send again — arm the
          // composer countdown so the failure explains itself (CLAUDE.md §26).
          if (code === "SLOWMODE" && typeof retryAfterSeconds === "number") {
            chat.startSlowmodeCooldown(queued.channelId, retryAfterSeconds);
          }
        }
      } else if (WATCH_ONLY_ERROR_CODES.has(code) && lastWatchActionChannel) {
        // A watch-party refusal (M20). These four codes have exactly one emitter
        // in the whole gateway, so attributing them here cannot steal another
        // feature's error — and each needs its OWN wording ("join the room",
        // "ask the host", "nothing is running", "the queue is full"), which is
        // why the ADR split them apart in the first place. The stage renders the
        // copy; this layer never formats a message (the gateway's English string
        // is for logs, not for a Turkish-speaking user, §26).
        useWatchPartyStore.getState().refuse(lastWatchActionChannel, code as WatchRefusal);
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
    // those in the room), so the group channel list shows occupants under each
    // voice channel and updates as people join/leave (incl. single-session
    // eviction, which the gateway broadcasts as a leave).
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
    // missed delta left behind. Channels absent from the snapshot are
    // authoritatively empty; the subsequent participant_joined/left deltas then
    // process as usual on top of this baseline.
    case SERVER_EVENT.voiceResync:
      useVoiceOccupancyStore.getState().resync(event.payload.channels);
      return;

    // Single-active-session eviction (user-scoped): the user joined voice on
    // another device, so this device leaves the named room. Engine-guarded — a
    // no-op unless we are in it (the device that just joined ignores it). The
    // clean leave + localized notice surface off the voice store's endedReason
    // (VoiceEvictionWatcher), never as an error (§26).
    case SERVER_EVENT.voiceSessionReplaced:
      // Voice-store first (the engine leaves the named room), THEN the call
      // controller so a live DM call on that room ends cleanly WITHOUT a second
      // leave (the engine already evicted itself — ADR 0012 §5).
      useVoiceStore.getState().sessionReplaced(event.payload.roomId);
      getCallController().applyServerEvent(event);
      return;

    // Roles/permissions events (M9). No-op stopgap so the exhaustive switch
    // compiles; a mobile roles wave adds real handling later.
    case SERVER_EVENT.roleCreated:
    case SERVER_EVENT.roleUpdated:
    case SERVER_EVENT.roleDeleted:
    case SERVER_EVENT.memberRolesUpdated:
    case SERVER_EVENT.channelAccessChanged:
      return;

    // Channel & member lifecycle (task #43). All group-scoped. Mobile keeps a
    // single combined groupDetails query (channels + members), so invalidating it
    // refetches both the visibility-filtered channel list and the roster.
    // channel.created is the fix for a freshly created channel staying invisible
    // until you navigate away and back — the gateway also subscribes this
    // connection to the new channel so its messages start flowing at once.
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
    case SERVER_EVENT.friendRequestReceived: {
      // Someone asked me → a new incoming request. Seed the requester so the
      // pending row renders a name/avatar without a round-trip.
      const { requester } = event.payload;
      chat.upsertUsers([requester]);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.friendRequests("incoming"),
      });
      // Founder fix: give a VISIBLE + audible heads-up while the app is open —
      // previously this event was silent (invalidation only). Push notifications
      // (app closed) stay a separate concern (push/*).
      playSound("message");
      showInAppNotification({
        kind: "friend-request",
        titleKey: "mobile:friends.notif.requestTitle",
        bodyKey: "mobile:friends.notif.requestBody",
        bodyParams: { name: requester.displayName || requester.username },
        href: "/friends",
      });
      return;
    }

    case SERVER_EVENT.friendRequestAccepted: {
      // They accepted my request → we are friends; the outgoing request is gone.
      const { friend } = event.payload;
      chat.upsertUsers([friend]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.friendRequests("outgoing"),
      });
      playSound("message");
      showInAppNotification({
        kind: "friend-accepted",
        titleKey: "mobile:friends.notif.acceptedTitle",
        bodyKey: "mobile:friends.notif.acceptedBody",
        bodyParams: { name: friend.displayName || friend.username },
        href: "/friends",
      });
      return;
    }

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
    // in the home list and raise an in-app heads-up. The twin of `dm.created`.
    case SERVER_EVENT.groupChatAdded:
      handleGroupChatAdded(event.payload.group);
      return;

    // Notification mute changed on ANOTHER of our devices (migration 0013).
    // User-scoped; upsert the local lookup, or drop it when `mute` is null
    // (unmuted). Drives dimming + unread suppression across devices at once.
    case SERVER_EVENT.notificationMuteUpdated: {
      const { scope, targetId, mute } = event.payload;
      if (mute) chat.setNotificationMute(scope, targetId, mute);
      else chat.clearNotificationMute(scope, targetId);
      return;
    }

    // Reaction deltas (ADR 0011 §3, M14 W6). Channel-scoped; fold each into the
    // target message's cached `reactions`, deriving `reactedByMe` from our id.
    // A delta for a message not on a loaded page is a safe no-op.
    case SERVER_EVENT.messageReactionAdded:
      applyReactionDelta(event.payload, "add");
      return;

    case SERVER_EVENT.messageReactionRemoved:
      applyReactionDelta(event.payload, "remove");
      return;

    // Link previews arrived for a message (M17). Channel-scoped, additive: fold
    // the full replacement card set onto the cached message (a no-op if it is not
    // on a loaded page — the embeds still arrive on the next GET, whose MessageDTO
    // carries `embeds`). Rendered below the message text by MessageBubble.
    case SERVER_EVENT.messageEmbedsUpdated: {
      const { channelId, messageId, embeds } = event.payload;
      applyEmbedsUpdate(channelId, messageId, embeds);
      return;
    }

    // Pin board changed (M17), channel-scoped. Two independent effects: flip
    // `pinned` on the cached message so its row draws the marker (a no-op when
    // the message is not on a loaded page — pinning something far up the
    // scrollback is normal), and invalidate the channel's pin query so an open
    // pin sheet refetches. The event carries no message body on purpose, so the
    // sheet (not the socket) fetches the pinned message's content.
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
    // emoji list so both the picker and the `:name:` resolver pick it up; signed
    // image URLs hang off their own query and are minted lazily, so there is
    // nothing else to do. A deleted emoji simply stops resolving and its
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
    // it drops out of the home list. The localized "you were removed/banned" toast
    // is a mobile-moderation-wave concern — this stopgap keeps the exhaustive
    // switch honest and the caches correct without inventing UI copy.
    case SERVER_EVENT.memberKicked:
    case SERVER_EVENT.memberBanned:
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // The server disconnected US from a voice room (migration 0017, user-scoped),
    // and `reason` says why. Media teardown is driven server-side by the SFU
    // force-remove, so this event's job is the WORDING: it names the reason the
    // raw LiveKit disconnect cannot carry, so an alone-idle close never reads as
    // "you joined on another device" (§26). Unmapped reasons (`moderator`, and
    // anything a newer server sends) fall through to the existing behavior.
    case SERVER_EVENT.voiceDisconnected:
      useVoiceStore.getState().voiceDisconnected(event.payload);
      return;

    // DM call signalling (ADR 0012, Wave 7). All user-scoped, control-only —
    // media rides LiveKit, never this bus (§10/§35). The shared call controller
    // drives the ring/in-call FSM; the global IncomingCallOverlay + /call screen
    // render off it. `call.invite` also cues the in-app ring (background delivery
    // is handled by the server's offline push).
    case SERVER_EVENT.callInvite:
      playSound("message");
      getCallController().applyServerEvent(event);
      return;
    case SERVER_EVENT.callAccepted:
    case SERVER_EVENT.callEnded:
    case SERVER_EVENT.callUpgraded:
      getCallController().applyServerEvent(event);
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

    // A visible user changed their public profile (name/avatar/banner/bio).
    // Repaint everywhere they appear (founder P0: a new photo must show up in the
    // member list and on message rows without a restart).
    case SERVER_EVENT.userUpdated:
      applyUserUpdate(event.payload.user);
      return;

    // M18 categories (migration 0019). A category is pure organization — it grants
    // no permissions and never changes who can see a channel (ADR 0007) — so these
    // never resubscribe the gateway; they only refresh what the sidebar reads.
    // Create/rename touch the category cache alone.
    case SERVER_EVENT.categoryCreated:
    case SERVER_EVENT.categoryUpdated:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.categories(event.payload.category.groupId),
      });
      return;

    // Delete and reorder additionally move CHANNELS: a deleted category frees its
    // channels back to the uncategorized list (FK ON DELETE SET NULL) and a
    // reorder rewrites `categoryId`/`position` outright. Both live on the channel
    // records inside `groupDetails`, so refreshing categories alone would leave
    // the list filing channels under a category that is gone or stale.
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
    // through `presence.updated`; this case is what keeps THIS device in sync
    // after the status was set on the desktop or another phone.
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

    // A block changed on ANOTHER of this user's devices (user-scoped). Everything
    // a block touches is server-filtered, so the honest response is to refetch
    // rather than patch: the block list, the target's profile card (`blocked`),
    // the friend lists and any pending request (a block severs both), the DM list,
    // and the message caches — shared-server history is hidden SERVER-side.
    case SERVER_EVENT.blocksUpdated: {
      for (const queryKey of blockChangeQueryKeys(event.payload.userId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
      return;
    }

    // Migration 0020 (ADR 0019). USER-scoped: this viewer set a private nickname
    // or an ignore on their OTHER device, so the phone must agree — a private
    // label that only exists on one device is exactly the drift the single
    // resolution order was extracted to prevent.
    case SERVER_EVENT.userNicknameUpdated: {
      const { targetId, nickname } = event.payload;
      queryClient.setQueryData<Record<UserId, string>>(queryKeys.userNicknames, (prev) => {
        const next = { ...(prev ?? {}) };
        if (nickname) next[targetId] = nickname;
        else delete next[targetId];
        return next;
      });
      return;
    }

    case SERVER_EVENT.ignoresUpdated:
      void queryClient.invalidateQueries({ queryKey: queryKeys.ignores });
      return;

    // GROUP-scoped: the per-server nickname and the timeout are PUBLIC, so every
    // member's roster row has to change. Both live on the group details payload,
    // which the roster, the member menu and the profile screen all read.
    case SERVER_EVENT.memberNicknameUpdated:
    case SERVER_EVENT.memberTimeoutUpdated:
      void queryClient.invalidateQueries({
        queryKey: queryKeys.groupDetails(event.payload.groupId),
      });
      return;

    // Watch party (M20, ADR 0016). `started` and `state` share one payload and
    // ONE client path: both are an upsert-by-channelId, so the opening frame, the
    // 5 s drift heartbeat, the join push and the reconnect snapshot all seat the
    // player on server truth without a "first frame" special case. On a phone
    // that last one carries the most weight — the socket dies in every tunnel,
    // and the reconnect snapshot is the entire recovery story.
    case SERVER_EVENT.watchStarted:
    case SERVER_EVENT.watchState:
      useWatchPartyStore.getState().upsert(event.payload);
      return;

    // Explicit transfer OR the automatic handoff when the host leaves the room.
    // Silent by design: the controls simply appear/disappear where they belong.
    case SERVER_EVENT.watchHostChanged:
      useWatchPartyStore.getState().setHost(event.payload.channelId, event.payload.hostId);
      return;

    // The host stopped it, or the room emptied. Either way the session is gone
    // server-side, so the stage clears rather than leaving an orphaned WebView
    // running against state nobody will ever refresh.
    case SERVER_EVENT.watchStopped:
      useWatchPartyStore.getState().stop(event.payload.channelId, event.payload.reason);
      return;

    // The queue. The server sends the COMPLETE list — on every change and again
    // on voice.join — so this is a replace, never a merge: the client owns no
    // queue state of its own to reconcile against.
    case SERVER_EVENT.watchQueueUpdated:
      useWatchPartyStore.getState().setQueue(event.payload.channelId, event.payload.queue);
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

const handlers = {
  onEvent: handleServerEvent,
  onStatus: (status: RealtimeStatus) => {
    useChatStore.getState().setConnectionStatus(status);
    // The queue drains only while the socket is genuinely open. Everything else
    // ("connecting", "reconnecting", "offline") keeps items parked, and going
    // offline re-queues anything in flight — safe because the nonce makes the
    // replay idempotent.
    outbox.setOnline(status === "online");
  },
  onGap: refetchServerState,
  onAuthExpired: () => useAuthStore.getState().sessionExpired(),
};

/** Lazily (re)built per session against the baked REALTIME_URL. */
let client: RealtimeClient | null = null;
let typingPruneTimer: Timer | null = null;

// ---------------------------------------------------------------------------
// Voice presence announcement (client → gateway)
//
// The channel-list "who is in each voice channel" feature is driven by the
// gateway's `voice.participant_joined/left` broadcasts, which fire only when a
// client emits `voice.join` / `voice.leave`. The media engine (LiveKit) is what
// actually connects to the room, so we DERIVE those signals from the engine's
// state: whenever we are connected to (or riding out a reconnect on) a room, we
// announce it; when we leave, we retract. The gateway tracks this per WS
// connection and forgets it on every new socket, so `auth.succeeded` also
// re-announces (see the handler above). Mirrors the desktop wiring exactly.
// ---------------------------------------------------------------------------

/** The room we should currently be announced in, or null. */
function currentVoiceRoom(): ChannelId | null {
  const { roomId, status } = useVoiceStore.getState();
  if (!roomId || !(status === "connected" || status === "reconnecting")) return null;
  // A DM-call room ("dmcall:<callId>", ADR 0012 §2) is NOT a real channel, so we
  // never announce it for occupancy. Only once a call has UPGRADED into a group
  // voice channel does the call controller set `callOccupancyChannel` (media stays
  // on the same LiveKit room — §6), which we then announce so the two originals
  // show up under the new group's voice channel.
  if (roomId.startsWith(DM_CALL_ROOM_PREFIX)) return callOccupancyChannel;
  return roomId as ChannelId;
}

/** The group voice channel a live, upgraded DM call is announced under (else null). */
let callOccupancyChannel: ChannelId | null = null;

/**
 * Set (or clear) the group voice channel a live DM call announces for OCCUPANCY.
 * Called by the call controller's `signalVoiceJoin` on a seamless group upgrade
 * (ADR 0012 §6): media never moves off the `dmcall:` room, so this is the only
 * way the group's occupancy learns the two originals are present. Null on a plain
 * 1-1 call and when no call is live. Idempotent — reconciled by
 * `syncVoiceAnnouncement`, a no-op when nothing changed.
 */
export function announceCallOccupancy(channelId: ChannelId | null): void {
  if (callOccupancyChannel === channelId) return;
  callOccupancyChannel = channelId;
  syncVoiceAnnouncement();
}

/**
 * Reconcile what the gateway believes about our voice presence with the engine's
 * actual room (shared `createVoiceAnnouncer`). Idempotent and cheap — a no-op
 * unless the room changed. A failed send (socket down) is recovered by the
 * `auth.succeeded` re-announce; a REFUSED join is retried by the announcer (see
 * the `error.raised` handler).
 */
const voiceAnnouncer = createVoiceAnnouncer({
  join: (channelId) => client?.send(clientEvent.voiceJoin({ channelId })),
  leave: (channelId) => client?.send(clientEvent.voiceLeave({ channelId })),
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
// Returning to the foreground (AppState "active") PULLS the authoritative
// occupancy snapshot over HTTP (throttled ≥15s) and REPLACES the store — the same
// authoritative shape as the `voice.resync` event — healing any desync accrued
// while the app was backgrounded. A 503 VOICE_OCCUPANCY_UNAVAILABLE (or any error)
// keeps the current view; occupancy is never cleared when a snapshot can't be
// produced (§26). Mirrors the desktop's window-focus pull.
// ---------------------------------------------------------------------------

const occupancyPull = createThrottledOccupancyPull({
  fetchSnapshot: () => getApi().getVoiceOccupancy(),
  resync: (channels) => useVoiceOccupancyStore.getState().resync(channels),
  onError: (error) =>
    console.warn("[realtime] voice occupancy pull failed; keeping current view", error),
});

let appStateSub: { remove: () => void } | null = null;

/**
 * Map RN's AppState to the push-gate lifecycle (#110). "active" is the only
 * foreground; "background" and "inactive" (and the momentary "unknown") all read
 * as background — a backgrounded phone must be treated as away so the sender's
 * message earns an OS push.
 */
function appLifecycleFrom(status: AppStateStatus): AppLifecycleState {
  return status === "active" ? "foreground" : "background";
}

/**
 * Tell the gateway our foreground/background state (#110, WhatsApp push gate).
 * The gateway records it PER CONNECTION and pushes to a user only when NONE of
 * their live connections is foreground. Sent on every AppState transition AND
 * once per handshake (see auth.succeeded) so a socket that connected/reconnected
 * WHILE backgrounded is still known as "background". Best-effort: a send while
 * the socket is down is healed by the next handshake's re-report.
 */
function reportAppState(status: AppStateStatus = AppState.currentState): void {
  client?.send(clientEvent.presenceAppState({ state: appLifecycleFrom(status) }));
}

function handleAppStateChange(next: AppStateStatus): void {
  reportAppState(next);
  if (next === "active") {
    void occupancyPull.pull();
    // Returned to the foreground: leave auto-idle and restart the inactivity
    // countdown (auto-idle only ever un-does an "online" mask).
    noteUserActivity();
  } else {
    // Backgrounded / inactive: stop the inactivity timer and go idle now.
    clearForegroundIdleTimer();
    enterAutoIdle();
  }
}

export function startRealtime(token: string): void {
  hadHandshake = false;
  // A brand-new session: the gateway knows nothing about our voice presence yet.
  voiceAnnouncer.forget();
  callOccupancyChannel = null;
  // Fresh session starts in the foreground and active: clear any stale auto-idle
  // and arm the inactivity countdown (a backgrounded start corrects itself on the
  // first AppState change / handshake).
  autoIdleActive = false;
  if (AppState.currentState === "active") armForegroundIdleTimer();
  // Refresh authoritative occupancy whenever the app returns to the foreground
  // (throttled); reset the throttle so this session's first "active" pulls now.
  occupancyPull.reset();
  appStateSub?.remove();
  appStateSub = AppState.addEventListener("change", handleAppStateChange);
  // Rebuild against the baked gateway URL each session (cleared on stop).
  client?.disconnect();
  // `platform: "mobile"` tags this connection so co-members/friends see the phone
  // indicator for us when we are their only mobile-connected presence (task #47).
  // `clientSignature` is the client-gate mark — the same value
  // the api client sends as a header, so the gate cannot accept one transport
  // and refuse the other.
  client = new RealtimeClient(
    { realtimeUrl: REALTIME_URL, platform: "mobile", clientSignature: CLIENT_SIGNATURE },
    handlers,
  );
  client.connect(token);
  if (typingPruneTimer === null) {
    typingPruneTimer = setInterval(
      () => useChatStore.getState().pruneTyping(Date.now()),
      TYPING_PRUNE_INTERVAL_MS,
    );
  }
}

export function stopRealtime(): void {
  client?.disconnect();
  client = null;
  appStateSub?.remove();
  appStateSub = null;
  // Drop occupancy so a re-login starts clean; the gateway broadcasts our leave
  // to peers when the socket closes (handleClose → leaveVoice).
  voiceAnnouncer.forget();
  callOccupancyChannel = null;
  useVoiceOccupancyStore.getState().reset();
  // Same reasoning for the watch party: a session we can no longer receive
  // heartbeats for must not linger as a player projecting a position forever —
  // on a phone that would be a WebView decoding video against a clock nobody is
  // correcting.
  lastWatchActionChannel = null;
  useWatchPartyStore.getState().reset();
  // A stale "the user is looking at channel X" claim must never outlive the
  // session — on a re-login it would silence that conversation's alerts.
  resetVisibleStream();
  // Drop the auto-idle inactivity timer + mask so a re-login starts clean.
  clearForegroundIdleTimer();
  autoIdleActive = false;
  if (typingPruneTimer !== null) {
    clearInterval(typingPruneTimer);
    typingPruneTimer = null;
  }
  // The queue keeps its items (that is the point of persistence) but must stop
  // draining into a socket that is gone.
  outbox.setOnline(false);
  for (const [channelId, state] of composerTyping) {
    clearTimeout(state.idleTimer);
    composerTyping.delete(channelId);
  }
}

/**
 * Force a fresh handshake so the gateway re-subscribes this connection.
 * Required after membership changes (group/channel created, invite redeemed)
 * because the gateway snapshots channel access at connect time.
 */
export function resubscribeRealtime(): void {
  client?.reconnectNow();
}
