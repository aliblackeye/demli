import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  View,
} from "react-native";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { router, useFocusEffect, usePathname } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, Hash, MessagesSquare } from "lucide-react-native";
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
import { Composer, type ComposerBlockedState } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { CustomEmojiProvider } from "./CustomEmojiContext";
import { EmojiPicker } from "./EmojiPicker";
import { EmptyState } from "./EmptyState";
import { MemberActionSheet, type MemberSheetTarget } from "./member/MemberActionSheet";
import { MessageActionSheet } from "./MessageActionSheet";
import { PinnedMessagesSheet, pinErrorText } from "./PinnedMessagesSheet";
import { SkeletonMessages } from "./Skeleton";
import { SystemMessage } from "./SystemMessage";
import { TypingIndicator } from "./TypingIndicator";
import { Button } from "./ui/Button";
import { toast } from "./ui/Toast";
import { ConversationStart, JumpPill, OlderPageFooter } from "./chat/ThreadParts";
import {
  CellDividers,
  DmConversationStartCard,
  MemoOutboxRow,
  MemoServerRow,
  isArriving,
  type RowActions,
  type RowDisplay,
} from "./chat/MessageRows";
import { buildThreadRows, itemKey, type ChatItem } from "./chat/thread-rows";
import { useChannelMessages, useTogglePin } from "../queries/chat-queries";
import { friendlyErrorMessage, getApi } from "../lib/clients";
import { localizeError } from "../lib/errors";
import { firstUnreadMessageId } from "../lib/unread-divider";
import { onMessageJump } from "../lib/message-jump";
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
import { colors, space } from "../theme/theme";

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_OUTBOX: OutboxMessage[] = [];

/** Older pages a pin/deep-link jump may load while hunting for its target. */
const JUMP_MAX_PAGE_LOADS = 5;

/** Scrolled-up distance (px) past which the jump-to-latest pill appears. */
const JUMP_TO_LATEST_THRESHOLD_PX = 280;
/** How long a jumped-to message keeps its coral flash mark. */
const HIGHLIGHT_MS = 1800;
/**
 * The message list + composer for one stream of messages, keyed by `channelId`.
 * A text channel, a voice channel's chat, a flat group chat and a DM (ADR 0005:
 * their stream id IS a channel id) all render this one component — no
 * duplicated pagination / optimistic-send logic.
 *
 * Merges the paginated server messages (newest-first) with the optimistic outbox
 * for an inverted list. Pages are keyset-disjoint and the realtime layer
 * reconciles by nonce, so no message appears twice (CLAUDE.md §22).
 *
 * Every state is designed (M16): skeleton on first load; an honest error with a
 * retry when the first page fails; an empty card that names the place; two
 * skeleton rows while an older page loads and an inline retry when it fails; and
 * once the whole history is in, the "start of the conversation" header.
 *
 * Message enrichment (ADR 0011): long-press → action sheet (react / reply /
 * copy / pin / edit / delete-with-confirm); swipe right → reply; reaction pills
 * toggle inline; a reply quote taps to its target, which flashes coral.
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
  blocked,
}: {
  channelId: string;
  groupId: string;
  name: string;
  /**
   * The kind of channel this stream belongs to. Only the store's active-channel
   * gate reads it (a voice channel is chat-capable since M20, so it must be
   * reported honestly or its chat would never count as "the one you are
   * reading"). Everything below this line is deliberately kind-agnostic.
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
   * message authors render in their role color. Stable per members/roles change,
   * never on presence ticks.
   */
  authorColors?: ReadonlyMap<UserId, string>;
  /**
   * The server id to thread into a tapped author's profile so it can render that
   * server's roles (audit A2/A3). ONLY the server-channel route passes it.
   */
  serverGroupId?: string;
  /**
   * DM only: the viewer has blocked the peer. The composer is replaced by an
   * honest notice with the unblock action (desktop parity).
   */
  blocked?: ComposerBlockedState;
}) {
  const { t } = useAppTranslation();
  const keyboardHeight = useKeyboardHeight();
  const query = useChannelMessages(channelId);
  const outbox = useChatStore((s) => s.outbox[channelId]) ?? EMPTY_OUTBOX;
  // NOT `presence`: each row's avatar subscribes to its own author's status, so
  // a presence tick never re-renders the whole thread (§27).
  const users = useChatStore((s) => s.users);
  // The whole session user (not just its id): it doubles as the self-fallback for
  // author resolution below.
  const me = useAuthStore((s) => s.user);
  const meId = me?.id;
  const queryClient = useQueryClient();
  const cid = channelId as ChannelId;

  // A 1:1 DM (the only surface passing `allowMentionBroadcast={false}`) shows a
  // profile-summary card at its start (ref #3).
  const isDm = allowMentionBroadcast === false;
  const startKind: "channel" | "group" = serverGroupId ? "channel" : "group";
  const dmPeer = useMemo<User | null>(() => {
    if (!isDm) return null;
    const dms = queryClient.getQueryData<Dm[]>(queryKeys.dms);
    return dms?.find((d) => d.id === groupId)?.participant ?? null;
  }, [isDm, groupId, queryClient]);

  // While a voice session is live, the global VoiceMiniBar floats over the bottom
  // of this screen. Reserve that height in the composer so the bar never covers
  // the text input — except on the voice room route, where the bar hides itself
  // (both sides read `isVoiceRoomRoute`, so they cannot drift).
  const pathname = usePathname();
  const voiceRoomId = useVoiceStore((s) => s.roomId);
  const voiceStatus = useVoiceStore((s) => s.status);
  const miniBarShown =
    voiceRoomId !== null && isLiveStatus(voiceStatus) && !isVoiceRoomRoute(pathname);
  const composerBottomReserve = miniBarShown ? VOICE_MINI_BAR_HEIGHT + space.sm : 0;

  const listRef = useRef<FlatList<ChatItem>>(null);
  /** The message a long-press opened the action sheet for, or null when closed. */
  const [actionTarget, setActionTarget] = useState<Message | null>(null);
  /** The message the FULL emoji picker is reacting to, or null when closed. */
  const [reactionPickerTarget, setReactionPickerTarget] = useState<Message | null>(null);
  /** Jump-to-latest pill visibility (audit B4) — shown once scrolled up. */
  const [showJump, setShowJump] = useState(false);
  /** Newest server id at the moment the pill appeared — what "new" counts from. */
  const [jumpSince, setJumpSince] = useState<string | null>(null);
  /** Pin board sheet (M17), opened from the route header. */
  const [pinsOpen, setPinsOpen] = useState(false);
  /** The message a jump just landed on — it flashes coral, then the mark clears. */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Hoisted ONCE for the whole thread (§27).
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
   * above: it is held only while this screen is actually focused (a pushed
   * profile or voice room does not unmount the thread).
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

  // --- "New Messages" divider ---------------------------------------------
  const newestServerId = serverMessages[0]?.id ?? null;

  // Compute the divider anchor ONCE, the first render server messages exist, and
  // hold it for this mount. The watermark is read imperatively from the store at
  // that instant — before the advance effect below bumps it — so the marker never
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
  // channel is open, so the NEXT visit's divider starts fresh.
  useEffect(() => {
    if (newestServerId) {
      useChatStore.getState().setChannelReadMarker(channelId, newestServerId);
    }
  }, [channelId, newestServerId]);

  const historyComplete = query.data !== undefined && !query.hasNextPage;

  // Grouping + day separators + the unread line, one pass (thread-rows.ts).
  const rows = useMemo(
    () => buildThreadRows(items, dividerAnchorId, historyComplete),
    [items, dividerAnchorId, historyComplete],
  );

  // O(1) "is this reply target loaded?" lookup so a quote tap is only offered
  // when scrolling to the target can actually succeed (no dead affordance).
  const loadedServerIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) if (item.kind === "server") set.add(item.message.id);
    return set;
  }, [items]);

  /**
   * Author lookup with a SELF fallback — the second line of defense behind the
   * store's self-seed invariant (chat-store `users`), for the beat right after
   * an account switch wipes the directory.
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

  /** Long-press an author → the USER action sheet; a tap still opens the profile. */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);

  const scrollToMessage = useCallback(
    (targetId: string) => {
      const index = items.findIndex(
        (item) => item.kind === "server" && item.message.id === targetId,
      );
      if (index < 0) return;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      setHighlightId(targetId);
    },
    [items],
  );

  // The flash mark clears itself; a second jump restarts it.
  useEffect(() => {
    if (highlightId === null) return;
    const id = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [highlightId]);

  /**
   * External jump requests (the pin board today) arrive through the module-level
   * emitter in lib/message-jump. A pinned message is usually far up the
   * scrollback, so this walks older pages until it finds it — bounded, because
   * paging forever into a long channel would be a render storm (§27).
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

  // Jump-to-latest pill (audit B4). In an inverted list offset 0 is the newest
  // message (bottom); a positive offset means the user has scrolled up.
  const newestRef = useRef(newestServerId);
  newestRef.current = newestServerId;
  const showJumpRef = useRef(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = e.nativeEvent.contentOffset.y > JUMP_TO_LATEST_THRESHOLD_PX;
    if (next === showJumpRef.current) return;
    showJumpRef.current = next;
    setShowJump(next);
    setJumpSince(next ? newestRef.current : null);
  }, []);

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    showJumpRef.current = false;
    setShowJump(false);
    setJumpSince(null);
  }, []);

  // Messages that landed while scrolled up — other people's only (your own sends
  // from another device are not news to you).
  const missedCount = useMemo(() => {
    if (!showJump || jumpSince === null) return 0;
    let n = 0;
    for (const m of serverMessages) {
      if (m.id === jumpSince) break;
      if (m.authorId !== meId) n += 1;
    }
    return serverMessages.some((m) => m.id === jumpSince) ? n : 0;
  }, [showJump, jumpSince, serverMessages, meId]);

  // Toggle a reaction on a specific message — the shared path for the quick
  // palette AND the full picker.
  const reactTo = useCallback(
    (target: Message, emoji: string) => {
      const mine = target.reactions?.find((r) => r.emoji === emoji)?.reactedByMe ?? false;
      toggleReaction(channelId, target.id, emoji, mine);
    },
    [channelId],
  );

  const startReply = useCallback(
    (target: Message) => {
      const preview: MessageReplyPreview = {
        id: target.id,
        authorId: target.authorId,
        content: target.content.slice(0, REPLY_PREVIEW_MAX),
        kind: target.kind ?? "user",
        deleted: target.deletedAt !== null,
      };
      useChatStore.getState().setReplyDraft(channelId, preview);
    },
    [channelId],
  );

  // ONE stable actions object for every row (see RowActions).
  const latest = useRef({ startReply, scrollToMessage, resolveUser, serverGroupId, channelId });
  latest.current = { startReply, scrollToMessage, resolveUser, serverGroupId, channelId };
  const actions = useMemo<RowActions>(
    () => ({
      openActions: (message) => setActionTarget(message),
      reply: (message) => latest.current.startReply(message),
      openAuthor: (userId) => {
        const gid = latest.current.serverGroupId;
        router.push({
          pathname: "/user/[userId]",
          params: gid ? { userId, groupId: gid } : { userId },
        });
      },
      openAuthorMenu: (userId) => {
        const user = latest.current.resolveUser(userId);
        setMemberTarget({ userId, displayName: user?.displayName, username: user?.username });
      },
      toggleReaction: (messageId, emoji, reactedByMe) =>
        toggleReaction(latest.current.channelId, messageId, emoji, reactedByMe),
      addReaction: (message) => setReactionPickerTarget(message),
      jumpTo: (messageId) => latest.current.scrollToMessage(messageId),
      retry: (nonce) => retryOutboxMessage(latest.current.channelId, nonce),
      discard: (nonce) => discardOutboxMessage(latest.current.channelId, nonce),
    }),
    [],
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

  const openReactionPicker = useCallback(() => {
    setReactionPickerTarget(actionTarget);
    setActionTarget(null);
  }, [actionTarget]);

  const copyFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);
    void Clipboard.setStringAsync(target.content).then(
      () => toast({ title: t("mobile:chat.textCopied"), variant: "success", key: "chat-copy", duration: 2000 }),
      () => toast({ title: t("mobile:chat.copyFailed"), variant: "danger", key: "chat-copy" }),
    );
  }, [actionTarget, t]);

  const replyFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    startReply(target);
    setActionTarget(null);
  }, [actionTarget, startReply]);

  // Edit (Feature A): seed the composer's edit draft from the tapped message.
  const editFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    useChatStore.getState().setEditDraft(channelId, target.id, target.content);
    setActionTarget(null);
  }, [actionTarget, channelId]);

  // Delete (Feature A): the sheet already asked for confirmation. The inbound
  // `message.deleted` removes the row from the cache (no tombstone — matches
  // desktop). Author-only for now (the server enforces it).
  const deleteFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);
    void getApi()
      .deleteMessage(target.id)
      .catch((err: unknown) =>
        toast({
          title: t("mobile:message.deleteError"),
          description: friendlyErrorMessage(err),
          variant: "danger",
        }),
      );
  }, [actionTarget, t]);

  // Pin / unpin from the sheet (M17). The authoritative UI update arrives over
  // the socket, so there is nothing optimistic to write — only a failure to show.
  const togglePin = useTogglePin(channelId);
  const pinFromSheet = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);
    togglePin.mutate(
      { messageId: target.id, pinned: target.pinned ?? false },
      {
        onError: (err) =>
          toast({ title: t("mobile:pins.error"), description: pinErrorText(err, t), variant: "danger" }),
      },
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
  const targetReactions = useMemo(
    () => new Set((actionTarget?.reactions ?? []).filter((r) => r.reactedByMe).map((r) => r.emoji)),
    [actionTarget],
  );

  const displayFor = useCallback(
    (
      authorId: UserId,
      replyAuthorId: UserId | undefined,
      replyTargetId: string | undefined,
      optimistic: boolean,
    ): RowDisplay => {
      const author = resolveUser(authorId);
      const replyAuthor = replyAuthorId !== undefined ? resolveUser(replyAuthorId) : undefined;
      return {
        authorName:
          author?.displayName ??
          author?.username ??
          // An optimistic row is always ours, so the self-fallback in
          // `resolveUser` resolves it; "You" only remains for the impossible
          // case of no session user at all.
          (optimistic ? t("mobile:common.you") : t("mobile:chat.unknownAuthor")),
        authorAvatarUrl: author?.avatarUrl,
        authorColor: authorColors?.get(authorId),
        reply:
          replyAuthorId !== undefined && replyTargetId !== undefined
            ? {
                authorName: resolveName(replyAuthorId),
                authorAvatarUrl: replyAuthor?.avatarUrl,
                loaded: loadedServerIds.has(replyTargetId),
              }
            : null,
      };
    },
    [resolveUser, resolveName, authorColors, loadedServerIds, t],
  );

  const renderItem = useCallback<ListRenderItem<ChatItem>>(
    ({ item, index }) => {
      const meta = rows[index] ?? { grouped: false, dayStart: null, unread: false };
      const message = item.message;
      const rt = message.replyTo;
      // Display data is shaped per render, but the memoized rows compare it
      // field-wise (`sameDisplay` below) — so only rows whose name, photo,
      // colour or reply target actually changed re-render.
      const display = displayFor(message.authorId, rt?.authorId, rt?.id, item.kind === "outbox");
      if (item.kind === "server") {
        if (item.message.kind === "system") {
          return (
            <>
              <CellDividers meta={meta} />
              <SystemMessage
                content={item.message.content}
                authorName={display.authorName}
                createdAt={item.message.createdAt}
              />
            </>
          );
        }
        // Subtle "mentions you" emphasis — pre-gated on `<@` so the scan only
        // runs for a message that actually carries a mention (§27).
        const mentionsMe =
          meId !== undefined &&
          item.message.authorId !== meId &&
          item.message.content.includes("<@") &&
          contentMentionsUser(item.message.content, meId);
        return (
          <MemoServerRow
            message={item.message}
            meta={meta}
            display={display}
            channelId={cid}
            serverGroupId={serverGroupId}
            mentioned={mentionsMe}
            // Your own server echo replaces the optimistic row that already
            // played the arrival; playing it again would flash the row twice.
            arriving={item.message.authorId !== meId && isArriving(item.message.createdAt)}
            highlighted={highlightId === item.message.id}
            actions={actions}
          />
        );
      }
      return (
        <MemoOutboxRow
          message={item.message}
          meta={meta}
          display={display}
          channelId={cid}
          serverGroupId={serverGroupId}
          actions={actions}
        />
      );
    },
    [rows, displayFor, meId, cid, serverGroupId, highlightId, actions],
  );

  const showInitialSkeleton = query.isLoading && items.length === 0;
  const showLoadError = query.isError && items.length === 0;

  const listFooter = query.isFetchingNextPage || query.isFetchNextPageError ? (
    <OlderPageFooter
      loading={query.isFetchingNextPage}
      failed={query.isFetchNextPageError}
      onRetry={() => void query.fetchNextPage()}
    />
  ) : historyComplete && items.length > 0 ? (
    isDm ? (
      <DmConversationStartCard peer={dmPeer} fallbackName={name} />
    ) : (
      <ConversationStart name={name} kind={startKind} />
    )
  ) : null;

  return (
    // ONE emoji subscription for the whole thread (§27).
    <CustomEmojiProvider groupId={serverGroupId ?? null}>
      <ConnectionBanner />
      {/* Android + edgeToEdge: neither adjustResize nor KAV's padding gets a
          keyboard inset, so we pad by the MEASURED keyboard height ourselves
          (use-keyboard-height.ts). iOS keeps KAV's native padding. */}
      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: Platform.OS === "android" ? keyboardHeight : 0 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {showInitialSkeleton ? (
          <SkeletonMessages />
        ) : showLoadError ? (
          <View style={{ flex: 1, justifyContent: "center" }}>
            <EmptyState
              tone="error"
              icon={<CloudOff size={22} color={colors.danger} />}
              title={t("mobile:chat.loadFailedTitle")}
              subtitle={localizeError(query.error, t)}
              action={
                <Button
                  label={t("buttons.retry")}
                  variant="secondary"
                  loading={query.isRefetching}
                  onPress={() => void query.refetch()}
                />
              }
            />
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList<ChatItem>
              ref={listRef}
              data={items}
              inverted
              onScroll={onScroll}
              scrollEventThrottle={16}
              keyExtractor={itemKey}
              contentContainerStyle={[
                { paddingTop: space.sm, paddingBottom: space.sm },
                // Lets the empty card centre itself in the free space.
                items.length === 0 ? { flexGrow: 1 } : null,
              ]}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onEndReachedThreshold={0.4}
              onEndReached={() => {
                if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                  void query.fetchNextPage();
                }
              }}
              // A reply target may sit just outside the measured window; fall back
              // to an estimated offset instead of throwing.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: true,
                });
              }}
              ListFooterComponent={listFooter}
              ListEmptyComponent={
                // MUST be a style-accepting host View: VirtualizedList counter-
                // inverts the empty component by injecting a `style` prop. A
                // function component that ignores `style` renders UPSIDE DOWN in
                // this inverted list (founder-reported).
                <View style={{ flexGrow: 1, justifyContent: "center" }}>
                  {isDm ? (
                    <DmConversationStartCard peer={dmPeer} fallbackName={name} />
                  ) : (
                    <EmptyState
                      icon={
                        startKind === "channel" ? (
                          <Hash size={22} color={colors.fgMuted} />
                        ) : (
                          <MessagesSquare size={22} color={colors.fgMuted} />
                        )
                      }
                      title={t("mobile:chat.emptyTitle")}
                      subtitle={
                        startKind === "channel"
                          ? t("mobile:chat.emptyChannel", { name })
                          : t("mobile:chat.emptyGroup")
                      }
                    />
                  )}
                </View>
              }
              renderItem={renderItem}
              // Virtualization tuned for chat rows (§27): a short first batch so
              // the thread paints fast, a modest window above/below the fold.
              initialNumToRender={16}
              maxToRenderPerBatch={12}
              windowSize={11}
            />
            <View
              pointerEvents="box-none"
              style={{ position: "absolute", left: 0, right: 0, bottom: space.md, alignItems: "center" }}
            >
              {showJump ? <JumpPill count={missedCount} onPress={jumpToLatest} /> : null}
            </View>
          </View>
        )}
        {/* TypingIndicator owns its own selector, so it never rerenders the
            FlatList above (CLAUDE.md §27). */}
        <TypingIndicator channelId={cid} />
        <Composer
          channelId={cid}
          slowmodeSeconds={slowmodeSeconds}
          allowBroadcast={allowMentionBroadcast}
          bottomReserve={composerBottomReserve}
          blocked={blocked}
        />
      </KeyboardAvoidingView>
      <MessageActionSheet
        visible={actionTarget !== null}
        preview={
          actionTarget
            ? {
                authorName: resolveName(actionTarget.authorId),
                authorAvatarUrl: resolveUser(actionTarget.authorId)?.avatarUrl,
                content: actionTarget.content,
              }
            : null
        }
        emojis={REACTION_EMOJI}
        myReactions={targetReactions}
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
          the same EmojiPicker the composer opens. Picking closes it and toggles
          the reaction on the held target. */}
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
          (null in a DM / flat group chat), and passing this channel enables
          "Mention" — the composer below is where the inserted `@name` lands. */}
      <MemberActionSheet
        target={memberTarget}
        groupId={(serverGroupId as GroupId | undefined) ?? null}
        channelId={cid}
        onClose={() => setMemberTarget(null)}
      />
    </CustomEmojiProvider>
  );
}
