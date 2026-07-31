import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  View,
} from "react-native";
import { Text } from "./ui/Text";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { router, useFocusEffect, usePathname } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react-native";
import { REACTION_EMOJI, REPLY_PREVIEW_MAX } from "@demli/config";
import { contentMentionsUser } from "@demli/protocol";
import { useAppTranslation } from "@/lib/i18n";
import type {
  Channel,
  ChannelId,
  Dm,
  GroupId,
  Message,
  MessageReplyPreview,
  User,
  UserId,
} from "@demli/types";
import { clearVisibleStream, setVisibleStream } from "../notifications/visible-context";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { CustomEmojiProvider } from "./CustomEmojiContext";
import { EmojiPicker } from "./EmojiPicker";
import { MemberActionSheet, type MemberSheetTarget } from "./member/MemberActionSheet";
import { MessageActionSheet } from "./MessageActionSheet";
import { MessageBubble, type DeliveryState, type ReplyPreviewProps } from "./MessageBubble";
import { PinnedMessagesSheet, pinErrorText } from "./PinnedMessagesSheet";
import { SkeletonMessages } from "./Skeleton";
import { SystemMessage } from "./SystemMessage";
import { TypingIndicator } from "./TypingIndicator";
import { useChannelMessages, useTogglePin } from "../queries/chat-queries";
import { friendlyErrorMessage, getApi } from "../lib/clients";
import { firstUnreadMessageId } from "../lib/unread-divider";
import { onMessageJump } from "../lib/message-jump";
import { outboxErrorText } from "../lib/outbox-errors";
import { canPinMessage, useCanManageMessages } from "../lib/pin-permissions";
import { onOpenPinsSheet } from "../lib/pins-sheet";
import { queryKeys } from "../lib/query-client";
import {
  discardOutboxMessage,
  notifyComposerIdle,
  retryOutboxMessage,
  toggleReaction,
} from "../realtime/connection";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore, type OutboxMessage } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { isLiveStatus, isVoiceRoomRoute, VOICE_MINI_BAR_HEIGHT } from "./voice/VoiceMiniBar";
import { colors, elevation, radius, space, typography } from "../theme/theme";

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_OUTBOX: OutboxMessage[] = [];

/** Older pages a pin/deep-link jump may load while hunting for its target. */
const JUMP_MAX_PAGE_LOADS = 5;

/** Same-author grouping window — mirrors desktop MessageList `GROUP_WINDOW_MS`. */
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;
/** Scrolled-up distance (px) past which the jump-to-latest FAB appears. */
const JUMP_TO_LATEST_THRESHOLD_PX = 280;
/**
 * A message younger than this plays the "arrival" motion. Mirrors the desktop
 * `ARRIVAL_FRESH_MS` exactly, including WHY it is derived from the message's
 * own `createdAt` instead of from mount: FlatList mounts and unmounts cells as
 * you scroll, so a mount-triggered animation would replay on every row that
 * scrolls back into the window. History never animates; an optimistic send
 * always does.
 */
const ARRIVAL_FRESH_MS = 1200;

/** Shared freshness test for the arrival motion. */
function isArriving(createdAt: string): boolean {
  return Date.now() - Date.parse(createdAt) < ARRIVAL_FRESH_MS;
}

type ChatItem =
  | { kind: "server"; message: Message }
  | { kind: "outbox"; message: OutboxMessage };

function itemIsSystem(item: ChatItem): boolean {
  return item.kind === "server" && item.message.kind === "system";
}

/**
 * Whether `curr` renders as a compact continuation hanging under the previous
 * (older) message `prev`. Mirrors the desktop grouping rule
 * (renderer `MessageList.buildRows`): same author, within
 * `MESSAGE_GROUP_WINDOW_MS`, neither a system notice, and `prev` not a failed
 * send. Additionally a reply always renders standalone so its quoted context
 * keeps the author header.
 *
 * `prev` is the chronologically-older message. In this newest-first array (fed
 * to an inverted FlatList) that is the item at the NEXT index.
 */
function isContinuationRow(curr: ChatItem, prev: ChatItem | undefined): boolean {
  if (!prev) return false;
  if (itemIsSystem(curr) || itemIsSystem(prev)) return false;
  if (curr.message.replyTo != null) return false;
  if (prev.kind === "outbox" && prev.message.deliveryState === "failed") return false;
  if (curr.message.authorId !== prev.message.authorId) return false;
  return (
    Date.parse(curr.message.createdAt) - Date.parse(prev.message.createdAt) <
    MESSAGE_GROUP_WINDOW_MS
  );
}

/**
 * The "start of the conversation" card for an empty DM (ref #3) — the peer's
 * avatar, name, @username, and a friendly opener. Rendered in the inverted
 * list's empty slot so it reads as the first thing above the composer.
 */
function DmConversationStartCard({
  peer,
  fallbackName,
}: {
  peer: User | null;
  fallbackName: string;
}) {
  const { t } = useAppTranslation();
  const name = peer?.displayName || peer?.username || fallbackName;
  return (
    <View
      style={{
        paddingHorizontal: space.xl,
        paddingVertical: space.xl,
        alignItems: "center",
        gap: space.md,
      }}
    >
      <Avatar name={name} size={88} uri={peer?.avatarUrl ?? null} />
      <View style={{ alignItems: "center", gap: 2 }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 20, fontWeight: "800", textAlign: "center" }}>
          {name}
        </Text>
        {peer?.username ? (
          <Text style={{ color: colors.fgMuted, fontSize: 14 }}>@{peer.username}</Text>
        ) : null}
      </View>
      <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
        {t("mobile:dm.conversationStart", { name })}
      </Text>
    </View>
  );
}

/**
 * The "New Messages" separator: a thin red hairline with a small label,
 * rendered directly above the first message received since the last visit. In the
 * inverted FlatList each cell's content is upright, so stacking this above the
 * bubble places it correctly between the last-read and first-unread message.
 */
function UnreadDivider() {
  const { t } = useAppTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("mobile:chat.newMessagesDivider")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.xs,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.danger, opacity: 0.55 }} />
      <Text
        style={{
          color: colors.danger,
          fontSize: typography.size.badge,
          fontWeight: "800",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {t("mobile:chat.newMessages")}
      </Text>
    </View>
  );
}

/**
 * The message list + composer for one stream of messages, keyed by `channelId`.
 * A text channel and a flat group chat (ADR 0005: a group's `streamId` IS a
 * channel id) render the exact same conversation UI, so both surfaces share this
 * one component — no duplicated pagination / optimistic-send logic.
 *
 * Merges the paginated server messages (newest-first) with the optimistic outbox
 * for an inverted list. Pages are keyset-disjoint and the realtime layer
 * reconciles by nonce, so no message appears twice (CLAUDE.md §22).
 *
 * Message enrichment (ADR 0011): long-press a server message → action sheet
 * (react / reply); reaction pills toggle inline; a reply renders its quoted
 * preview and, when the target is on a loaded page, taps scroll to it.
 */
export function ChatThread({
  channelId,
  groupId,
  name,
  channelKind = "text",
  slowmodeSeconds,
  authorColors,
  serverGroupId,
  allowMentionBroadcast = true,
}: {
  channelId: string;
  groupId: string;
  name: string;
  /**
   * The kind of channel this stream belongs to. Only the store's active-channel
   * gate reads it (a voice channel is chat-capable since M20, so it must be
   * reported honestly or its chat would never count as "the one you are
   * reading"). Everything below this line is deliberately kind-agnostic: there is
   * ONE chat implementation, and a voice channel's conversation is the same
   * list, composer, pins, search, reactions and outbox as a text channel's.
   * DMs and flat group chats keep the default — ADR 0005 makes their stream id a
   * channel id of kind "text".
   */
  channelKind?: Channel["kind"];
  /** Shows the composer's slow-mode indicator when > 0 (both channel kinds). */
  slowmodeSeconds?: number;
  /**
   * Offer `@everyone`/`@here` in the composer's mention picker. True on server
   * channels and flat group chats (multi-member); the DM route passes false.
   */
  allowMentionBroadcast?: boolean;
  /**
   * Server channels only: `userId → highest colored-role hex` (ADR 0007), so
   * message authors render in their role color. Omitted for DMs / group chats
   * (no roles). Stable per members/roles change, never on presence ticks.
   */
  authorColors?: ReadonlyMap<UserId, string>;
  /**
   * The server id to thread into a tapped author's profile so it can render that
   * server's roles (audit A2/A3). ONLY the server-channel route passes it — a DM
   * / flat group chat has no server roles, and `groupId` there is the dm/group id
   * (not a server), so it must NOT be forwarded as the profile's server context.
   */
  serverGroupId?: string;
}) {
  const { t } = useAppTranslation();
  const keyboardHeight = useKeyboardHeight();
  const query = useChannelMessages(channelId);
  const outbox = useChatStore((s) => s.outbox[channelId]) ?? EMPTY_OUTBOX;
  const users = useChatStore((s) => s.users);
  const presence = useChatStore((s) => s.presence);
  // The whole session user (not just its id): it doubles as the self-fallback for
  // author resolution below. Its reference only changes on sign-in / profile
  // update, so this is no chattier than subscribing to `user?.id`.
  const me = useAuthStore((s) => s.user);
  const meId = me?.id;
  const queryClient = useQueryClient();

  // A 1:1 DM (the only surface passing `allowMentionBroadcast={false}`) shows a
  // profile-summary card in its empty slot (ref #3). The peer is read from the
  // DM list cache by dmId (=== groupId here); a cache miss degrades to the title.
  const isDm = allowMentionBroadcast === false;
  const dmPeer = useMemo<User | null>(() => {
    if (!isDm) return null;
    const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms);
    return dms?.find((d) => d.id === groupId)?.participant ?? null;
  }, [isDm, groupId, queryClient]);

  // While a voice session is live, the global VoiceMiniBar floats over the bottom
  // of this screen. Reserve that height in the composer so the bar never covers
  // the text input (the composer collapses the reserve when the keyboard is up).
  //
  // …except on the voice room route, where the bar hides itself in favour of that
  // screen's own controls. Since M20 that route renders THIS thread (a voice
  // channel's chat), so reserving there would open a 64px hole above the composer
  // for a bar that is not on screen. Both sides read `isVoiceRoomRoute`, so the
  // reserve cannot drift from the bar's actual visibility. A DM call is
  // deliberately still reserved: it shows the CallMiniBar on its own route.
  const pathname = usePathname();
  const voiceRoomId = useVoiceStore((s) => s.roomId);
  const voiceStatus = useVoiceStore((s) => s.status);
  const miniBarShown =
    voiceRoomId !== null && isLiveStatus(voiceStatus) && !isVoiceRoomRoute(pathname);
  const composerBottomReserve = miniBarShown ? VOICE_MINI_BAR_HEIGHT + space.sm : 0;

  const listRef = useRef<FlatList<ChatItem>>(null);
  /** The message a long-press opened the action sheet for, or null when closed. */
  const [actionTarget, setActionTarget] = useState<Message | null>(null);
  /**
   * The message the FULL emoji picker is reacting to (M17 widening), or null when
   * closed. Held separately from `actionTarget` so the picker can open as the
   * action sheet closes without losing which message the reaction lands on.
   */
  const [reactionPickerTarget, setReactionPickerTarget] = useState<Message | null>(null);
  /** Jump-to-latest FAB visibility (audit B4) — shown once scrolled up. */
  const [showJump, setShowJump] = useState(false);
  /** Pin board sheet (M17), opened from the route header. */
  const [pinsOpen, setPinsOpen] = useState(false);
  // Hoisted ONCE for the whole thread (§27): the roles/members queries behind
  // this must not be subscribed by every message row.
  const canManageMessages = useCanManageMessages(serverGroupId ?? null);

  // Mark active/read while MOUNTED; stop typing + clear selection/reply on leave.
  useEffect(() => {
    const chat = useChatStore.getState();
    chat.setActiveChannel({
      id: channelId,
      groupId,
      kind: channelKind,
      name,
      position: 0,
      createdAt: "",
    });
    chat.markChannelRead(channelId);
    return () => {
      notifyComposerIdle(channelId);
      const leaving = useChatStore.getState();
      leaving.clearActiveChannel();
      leaving.clearReplyDraft();
      leaving.clearEditDraft();
    };
  }, [channelId, groupId, name, channelKind]);

  /**
   * Notification visibility, which is a STRICTER claim than the mount effect
   * above: it is held only while this screen is actually focused. Pushing the
   * voice room / channel settings / a profile on top of the thread does not
   * unmount it, so the mount effect keeps `activeChannelId` set — and before
   * this, every alert for the conversation stayed suppressed while the user was
   * looking at a different screen. Alerts are the one thing that must not be
   * silenced on a guess (see client-core notify-policy).
   */
  useFocusEffect(
    useCallback(() => {
      setVisibleStream(channelId);
      return () => clearVisibleStream(channelId);
    }, [channelId]),
  );

  const serverMessages = useMemo(
    () => query.data?.pages.flatMap((page) => page.messages) ?? [],
    [query.data],
  );

  // Newest-first for the inverted FlatList: outbox (newest send first) then
  // server messages (already newest-first).
  const items = useMemo<ChatItem[]>(() => {
    const list: ChatItem[] = [];
    for (let i = outbox.length - 1; i >= 0; i -= 1) {
      const message = outbox[i];
      if (message) list.push({ kind: "outbox", message });
    }
    for (const message of serverMessages) list.push({ kind: "server", message });
    return list;
  }, [outbox, serverMessages]);

  // Per-row continuation flag (audit B1). Compared against the next index — the
  // chronologically-older neighbor in this newest-first array — so the FIRST
  // (oldest) message of a run keeps the header and newer ones collapse under it.
  const continuations = useMemo(
    () => items.map((item, i) => isContinuationRow(item, items[i + 1])),
    [items],
  );

  // --- "New Messages" divider ---------------------------------------------
  const newestServerId = serverMessages[0]?.id ?? null;

  // Compute the divider anchor ONCE, the first render server messages exist, and
  // hold it for this mount (the screen mounts per navigation, so a fresh mount ==
  // a fresh open). The watermark is read imperatively from the store at that
  // instant — before the advance effect below bumps it — so the marker never
  // resubscribes/rerenders the list (§27), and freezing keeps the divider from
  // sliding down as new messages stream in.
  const anchorRef = useRef<{ computed: boolean; id: string | null }>({
    computed: false,
    id: null,
  });
  if (!anchorRef.current.computed && serverMessages.length > 0) {
    const ascendingIds: string[] = [];
    for (let i = serverMessages.length - 1; i >= 0; i -= 1) {
      ascendingIds.push(serverMessages[i]!.id);
    }
    const watermark = useChatStore.getState().lastReadMessageId[channelId] ?? null;
    anchorRef.current = {
      computed: true,
      id: firstUnreadMessageId(ascendingIds, watermark),
    };
  }
  const dividerAnchorId = anchorRef.current.id;

  // Advance (and persist) the read watermark to the newest message while the
  // channel is open — mirrors the "mark read on focus" badge behavior so the NEXT
  // visit's divider starts fresh. The frozen anchor above is unaffected.
  useEffect(() => {
    if (newestServerId) {
      useChatStore.getState().setChannelReadMarker(channelId, newestServerId);
    }
  }, [channelId, newestServerId]);

  // O(1) "is this reply target loaded?" lookup so a quote tap is only offered
  // when scrolling to the target can actually succeed (no dead affordance).
  const loadedServerIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.kind === "server") set.add(item.message.id);
    return set;
  }, [items]);

  /**
   * Author lookup with a SELF fallback — the second line of defense behind the
   * store's self-seed invariant (chat-store `users`). The directory can be
   * legitimately empty for a beat right after an account switch wipes it, and a
   * DM has no roster query to refill it, so our own id resolves from the session
   * user instead of dropping to "unknown author" on the user's own messages.
   */
  const resolveUser = useCallback(
    (userId: UserId): User | undefined =>
      users[userId] ?? (me !== null && userId === me.id ? me : undefined),
    [users, me],
  );

  const resolveName = useCallback(
    (userId: UserId): string => {
      const user = resolveUser(userId);
      return user?.displayName ?? user?.username ?? t("mobile:chat.unknownAuthor");
    },
    [resolveUser, t],
  );

  /**
   * Open a tapped author's profile (audit A2). Threads `serverGroupId` when this
   * is a server channel so the profile can render that server's roles; a DM /
   * group chat passes no server context (there are no server roles there).
   */
  const openAuthor = useCallback(
    (userId: UserId) => {
      router.push({
        pathname: "/user/[userId]",
        params: serverGroupId ? { userId, groupId: serverGroupId } : { userId },
      });
    },
    [serverGroupId],
  );

  /**
   * Long-press an author's avatar/name → the USER action sheet (the mobile twin
   * of desktop's right-click-on-a-name menu). A short press still opens the
   * profile, so the cheap gesture stays the harmless one.
   */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);
  const openAuthorMenu = useCallback(
    (userId: UserId) => {
      const user = resolveUser(userId);
      setMemberTarget({
        userId,
        displayName: user?.displayName,
        username: user?.username,
      });
    },
    [resolveUser],
  );

  const scrollToMessage = useCallback((targetId: string) => {
    const index = items.findIndex(
      (item) => item.kind === "server" && item.message.id === targetId,
    );
    if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [items]);

  /**
   * External jump requests (the pin board today) arrive through the module-level
   * emitter in lib/message-jump. Unlike a reply quote — whose target is almost
   * always loaded — a pinned message is usually far up the scrollback, so this
   * walks older pages until it finds it. Bounded on purpose: paging forever into
   * a long channel would be a render storm (§27); after the cap we give up, and
   * the user still has the message's text in the pin sheet.
   */
  const pagingRef = useRef({ query, items });
  pagingRef.current = { query, items };
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onMessageJump((targetId) => {
      void (async () => {
        for (let attempt = 0; attempt <= JUMP_MAX_PAGE_LOADS; attempt += 1) {
          if (cancelled) return;
          const loaded = pagingRef.current.items.some(
            (item) => item.kind === "server" && item.message.id === targetId,
          );
          if (loaded) {
            scrollToMessage(targetId);
            return;
          }
          if (!pagingRef.current.query.hasNextPage) return;
          await pagingRef.current.query.fetchNextPage();
        }
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scrollToMessage]);

  // The pin board lives here (it needs the channel id) while its button lives in
  // the route header — the header publishes a one-shot open command.
  useEffect(() => onOpenPinsSheet(() => setPinsOpen(true)), []);

  // Jump-to-latest FAB (audit B4). In an inverted list offset 0 is the newest
  // message (bottom); a positive offset means the user has scrolled up.
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = e.nativeEvent.contentOffset.y > JUMP_TO_LATEST_THRESHOLD_PX;
    setShowJump((prev) => (prev === next ? prev : next));
  }, []);

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setShowJump(false);
  }, []);

  const onToggleReaction = useCallback(
    (messageId: string, emoji: string, reactedByMe: boolean) => {
      toggleReaction(channelId, messageId, emoji, reactedByMe);
    },
    [channelId],
  );

  // Toggle a reaction on a specific message — the shared path for the quick
  // palette AND the full picker. `reactedByMe` is read off the target so the
  // optimistic fold knows which way to go.
  const reactTo = useCallback(
    (target: Message, emoji: string) => {
      const mine = target.reactions?.find((r) => r.emoji === emoji)?.reactedByMe ?? false;
      toggleReaction(channelId, target.id, emoji, mine);
    },
    [channelId],
  );

  // Action-sheet handlers (operate on the currently long-pressed message).
  const reactFromSheet = useCallback(
    (emoji: string) => {
      if (!actionTarget) return;
      reactTo(actionTarget, emoji);
      setActionTarget(null);
    },
    [actionTarget, reactTo],
  );

  // "More" → hand the long-pressed message to the full picker as the sheet closes.
  const openReactionPicker = useCallback(() => {
    setReactionPickerTarget(actionTarget);
    setActionTarget(null);
  }, [actionTarget]);

  // Copy (B2): copy the tapped message's raw text to the clipboard, then close.
  // expo-clipboard is already bundled (used by the invite screen), so this pulls
  // in no new native module. Offered only when the message has text content.
  const copyFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    void Clipboard.setStringAsync(target.content);
    setActionTarget(null);
  }, [actionTarget]);

  const replyFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    const preview: MessageReplyPreview = {
      id: target.id,
      authorId: target.authorId,
      content: target.content.slice(0, REPLY_PREVIEW_MAX),
      kind: target.kind ?? "user",
      deleted: target.deletedAt !== null,
    };
    useChatStore.getState().setReplyDraft(channelId, preview);
    setActionTarget(null);
  }, [actionTarget, channelId]);

  // Edit (Feature A): seed the composer's edit draft from the tapped message;
  // the composer prefills its text and, on send, PATCHes it. Own messages only.
  const editFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    useChatStore.getState().setEditDraft(channelId, target.id, target.content);
    setActionTarget(null);
  }, [actionTarget, channelId]);

  // Delete (Feature A): confirm with a native alert, then DELETE over the shared
  // client. The inbound `message.deleted` removes the row from the cache (no
  // tombstone — matches desktop). Author-only for now (the server enforces it).
  const deleteFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);
    Alert.alert(t("mobile:message.deleteConfirmTitle"), t("mobile:message.deleteConfirmBody"), [
      { text: t("buttons.cancel"), style: "cancel" },
      {
        text: t("buttons.delete"),
        style: "destructive",
        onPress: () => {
          void getApi()
            .deleteMessage(target.id)
            .catch((err: unknown) =>
              Alert.alert(t("mobile:message.deleteError"), friendlyErrorMessage(err)),
            );
        },
      },
    ]);
  }, [actionTarget, t]);

  // Pin / unpin from the sheet (M17). The authoritative UI update arrives over
  // the socket (`message.pinned` → foldMessagePin + a pins invalidation), so
  // there is nothing optimistic to write here — only a failure to surface.
  const togglePin = useTogglePin(channelId);
  const pinFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);
    togglePin.mutate(
      { messageId: target.id, pinned: target.pinned ?? false },
      { onError: (err) => Alert.alert(t("mobile:pins.error"), pinErrorText(err, t)) },
    );
  }, [actionTarget, togglePin, t]);

  // Own-message gating for the sheet's edit/delete rows (server enforces the
  // same). Edit needs text content (an attachment-only message has none).
  const targetIsOwn =
    actionTarget !== null && meId !== undefined && actionTarget.authorId === meId;
  const targetHasText = (actionTarget?.content.length ?? 0) > 0;
  const canEditTarget = targetIsOwn && targetHasText;
  // §35: an unauthorized member never sees the pin row at all.
  const canPinTarget =
    actionTarget !== null && canPinMessage(canManageMessages, actionTarget.authorId, meId);

  const showInitialSpinner = query.isLoading && items.length === 0;

  return (
    // ONE emoji subscription for the whole thread (§27) — every row's `:name:`
    // resolver reads this context, never its own query.
    <CustomEmojiProvider groupId={serverGroupId ?? null}>
      <ConnectionBanner />
      {/* Android + edgeToEdge: neither adjustResize nor KAV's padding gets a
          keyboard inset, so we pad by the MEASURED keyboard height ourselves
          (use-keyboard-height.ts) — the composer rides exactly on top of the
          IME. iOS keeps KAV's native padding (smooth will* animations); the
          manual pad is 0 there to avoid double-lifting. */}
      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: Platform.OS === "android" ? keyboardHeight : 0 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {showInitialSpinner ? (
          <SkeletonMessages />
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList<ChatItem>
            ref={listRef}
            data={items}
            inverted
            onScroll={onScroll}
            scrollEventThrottle={16}
            keyExtractor={(item) =>
              item.kind === "server" ? item.message.id : `nonce-${item.message.nonce}`
            }
            contentContainerStyle={{ paddingVertical: space.sm }}
            keyboardDismissMode="interactive"
            onEndReachedThreshold={0.4}
            onEndReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
            }}
            // A reply target may sit just outside the measured window; fall back
            // to an estimated offset instead of throwing.
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({
                offset: info.averageItemLength * info.index,
                animated: true,
              });
            }}
            ListFooterComponent={
              query.isFetchingNextPage ? (
                <View style={{ paddingVertical: space.md }}>
                  <ActivityIndicator color={colors.fgFaint} size="small" />
                </View>
              ) : null
            }
            ListEmptyComponent={
              // MUST be a style-accepting host View: VirtualizedList counter-
              // inverts the empty component by injecting a `style` prop
              // (cloneElement + StyleSheet.compose). A function component that
              // ignores `style` (the start card) silently drops that injection
              // and renders UPSIDE DOWN in this inverted list (founder-reported).
              <View>
                {isDm ? (
                  <DmConversationStartCard peer={dmPeer} fallbackName={name} />
                ) : (
                  <View style={{ padding: space.xl, alignItems: "center" }}>
                    <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
                      {t("mobile:chat.empty")}
                    </Text>
                  </View>
                )}
              </View>
            }
            renderItem={({ item, index }) => {
              // The first message received since the last visit gets the divider
              // above it and always keeps its author header (never a continuation).
              const isAnchor =
                dividerAnchorId !== null &&
                item.kind === "server" &&
                item.message.id === dividerAnchorId;
              const grouped = isAnchor ? false : (continuations[index] ?? false);
              const withDivider = (node: JSX.Element): JSX.Element =>
                isAnchor ? (
                  <>
                    <UnreadDivider />
                    {node}
                  </>
                ) : (
                  node
                );
              if (item.kind === "server") {
                if (item.message.kind === "system") {
                  return withDivider(
                    <SystemMessage
                      content={item.message.content}
                      authorName={resolveName(item.message.authorId)}
                      createdAt={item.message.createdAt}
                    />,
                  );
                }
                const message = item.message;
                const author = resolveUser(message.authorId);
                // Subtle "mentions you" emphasis — pre-gated on `<@` so the scan
                // only runs for a message that actually carries a mention (§27).
                const mentionsMe =
                  meId !== undefined &&
                  message.authorId !== meId &&
                  message.content.includes("<@") &&
                  contentMentionsUser(message.content, meId);
                const rt = message.replyTo;
                const reply: ReplyPreviewProps | undefined = rt
                  ? {
                      authorName: resolveName(rt.authorId),
                      content: rt.content,
                      deleted: rt.deleted,
                      onPress: loadedServerIds.has(rt.id)
                        ? () => scrollToMessage(rt.id)
                        : undefined,
                    }
                  : undefined;
                return withDivider(
                  <MessageBubble
                    authorName={resolveName(message.authorId)}
                    authorAvatarUrl={author?.avatarUrl}
                    authorColor={authorColors?.get(message.authorId)}
                    content={message.content}
                    createdAt={message.createdAt}
                    edited={message.updatedAt !== null}
                    presence={presence[message.authorId]}
                    delivery="sent"
                    grouped={grouped}
                    channelId={channelId}
                    attachments={message.attachments}
                    embeds={message.embeds}
                    reactions={message.reactions}
                    reply={reply}
                    mentionGroupId={serverGroupId}
                    mentioned={mentionsMe}
                    pinned={message.pinned ?? false}
                    arriving={isArriving(message.createdAt)}
                    onLongPress={() => setActionTarget(message)}
                    onPressAuthor={() => openAuthor(message.authorId)}
                    onLongPressAuthor={() => openAuthorMenu(message.authorId)}
                    onToggleReaction={(emoji, reactedByMe) =>
                      onToggleReaction(message.id, emoji, reactedByMe)
                    }
                  />,
                );
              }
              const author = resolveUser(item.message.authorId);
              // `queued` renders like `sending` (dimmed) but gets its own calm
              // note — it is not a failure, it just has not left the device yet.
              const delivery: DeliveryState =
                item.message.deliveryState === "failed" ? "failed" : "sending";
              const queued = item.message.deliveryState === "queued";
              const outboxReply = item.message.replyTo;
              return (
                <MessageBubble
                  // An optimistic row is always ours, so the self-fallback in
                  // `resolveUser` resolves it; "You" only remains for the
                  // impossible case of no session user at all.
                  authorName={
                    author?.displayName ?? author?.username ?? t("mobile:common.you")
                  }
                  authorAvatarUrl={author?.avatarUrl}
                  authorColor={authorColors?.get(item.message.authorId)}
                  content={item.message.content}
                  createdAt={item.message.createdAt}
                  delivery={delivery}
                  grouped={grouped}
                  arriving={isArriving(item.message.createdAt)}
                  queueNote={
                    queued
                      ? item.message.errorKey === "offline"
                        ? t("mobile:message.queueOffline")
                        : t("mobile:message.queued")
                      : undefined
                  }
                  failureNote={outboxErrorText(item.message.errorKey, t)}
                  // §35: a message whose channel is gone can never be delivered,
                  // so "retry" would be a button that cannot work.
                  canRetry={item.message.errorKey !== "channel_gone"}
                  onRetry={() => retryOutboxMessage(channelId, item.message.nonce)}
                  onDiscard={() => discardOutboxMessage(channelId, item.message.nonce)}
                  channelId={channelId}
                  attachments={item.message.attachments}
                  mentionGroupId={serverGroupId}
                  onPressAuthor={() => openAuthor(item.message.authorId)}
                  reply={
                    outboxReply
                      ? {
                          authorName: resolveName(outboxReply.authorId),
                          content: outboxReply.content,
                          deleted: outboxReply.deleted,
                          onPress: loadedServerIds.has(outboxReply.id)
                            ? () => scrollToMessage(outboxReply.id)
                            : undefined,
                        }
                      : undefined
                  }
                />
              );
            }}
            />
            {showJump ? (
              <View
                pointerEvents="box-none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: space.md,
                  alignItems: "center",
                }}
              >
                <Pressable
                  onPress={jumpToLatest}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile:chat.jumpToLatest")}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: colors.strokeStrong,
                    backgroundColor: colors.surfaceRaised,
                    opacity: pressed ? 0.85 : 1,
                    ...elevation.raised,
                  })}
                >
                  <ArrowDown size={16} color={colors.fg} />
                  <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>
                    {t("mobile:chat.jumpToLatest")}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}
        {/* TypingIndicator owns its own selector, so it never rerenders the
            FlatList above (CLAUDE.md §27). */}
        <TypingIndicator channelId={channelId} />
        <Composer
          channelId={channelId}
          slowmodeSeconds={slowmodeSeconds}
          allowBroadcast={allowMentionBroadcast}
          bottomReserve={composerBottomReserve}
        />
      </KeyboardAvoidingView>
      <MessageActionSheet
        visible={actionTarget !== null}
        emojis={REACTION_EMOJI}
        onReact={reactFromSheet}
        onMore={openReactionPicker}
        onReply={replyFromSheet}
        onCopy={targetHasText ? copyFromSheet : undefined}
        onTogglePin={canPinTarget ? pinFromSheet : undefined}
        pinned={actionTarget?.pinned ?? false}
        onEdit={canEditTarget ? editFromSheet : undefined}
        onDelete={targetIsOwn ? deleteFromSheet : undefined}
        onClose={() => setActionTarget(null)}
      />
      {/* The FULL reaction picker (all unicode + this surface's custom emoji),
          reusing the same EmojiPicker the composer opens (DRY). Picking closes
          it and toggles the reaction on the held target. */}
      <EmojiPicker
        visible={reactionPickerTarget !== null}
        onSelect={(emoji) => {
          if (reactionPickerTarget) reactTo(reactionPickerTarget, emoji);
        }}
        onClose={() => setReactionPickerTarget(null)}
      />
      <PinnedMessagesSheet
        visible={pinsOpen}
        channelId={channelId}
        serverGroupId={serverGroupId}
        onClose={() => setPinsOpen(false)}
      />
      {/* The user menu for a long-pressed author. `groupId` is the SERVER id
          (null in a DM / flat group chat, where there is nothing to moderate),
          and passing this channel enables "Mention" — the composer below is
          exactly where the inserted `@name` lands. */}
      <MemberActionSheet
        target={memberTarget}
        groupId={(serverGroupId as GroupId | undefined) ?? null}
        channelId={channelId as ChannelId}
        onClose={() => setMemberTarget(null)}
      />
    </CustomEmojiProvider>
  );
}
