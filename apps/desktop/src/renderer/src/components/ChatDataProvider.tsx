/**
 * Desktop → shared message-center data bridge (Phase 1 step 3, tek-kaynak UI).
 *
 * Assembles the desktop's channel-messages query + optimistic outbox + read
 * marker into the single {@link ChatData} contract that the shared
 * @demli/app-ui <MessageList> reads via useChatData(). Every platform-coupled
 * derivation — the ascending page/outbox merge, error localization, the
 * read-marker advance, the module-level jump emitter, the permission gate and
 * member colors — is resolved HERE, so the shared list stays presentational and
 * its scroll/virtualization behavior is byte-identical to the desktop component
 * it replaces. The mutation-coupled ROW (edit/delete/pin/react/attachments/
 * profile card) is passed as the `renderMessage` slot — the desktop <MessageRow>.
 *
 * Mounted PER OPEN CHANNEL by each surface (server channel, DM, flat group chat);
 * the shared list under it is keyed by channel id so its scroll/divider state
 * resets on a channel switch, exactly as before.
 */
import { useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import {
  ChatDataProvider as AppChatDataProvider,
  MessageRow,
  MessageRowServicesProvider,
  type ChatData,
  type ChatHeaderControls,
  type ChatMessageRowContext,
  type ChatMessageView,
  type MessageRowServices,
} from "@demli/app-ui";
import { REPLY_PREVIEW_MAX } from "@demli/config";
import type { Channel, GroupId } from "@demli/types";
import { toSentChatMessage, type ChatMessage } from "../lib/chat-message";
import { localizeError } from "../lib/errors";
import { onMessageJump } from "../lib/message-jump";
import { useAppTranslation } from "../lib/i18n";
import { api } from "../lib/api-client";
import { useChannelMessages } from "../queries/chat-queries";
import { useCanManageMessages } from "../lib/pin-permissions";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import {
  discardOutboxMessage,
  retryOutboxMessage,
  toggleMessageReaction,
} from "../realtime/connection";
import { isInviteLinkUrl } from "../lib/invite-link";
import { useNameOverrides } from "../lib/use-name-overrides";
import { useTimedOutMembers } from "../lib/use-timed-out-members";
import { useIgnoredUserIds } from "../queries/social-queries";
import { AttachmentGrid } from "./AttachmentGrid";
import { MessageInviteEmbeds } from "./InviteEmbedCard";
import { MessageEmbeds } from "./LinkEmbedCard";
import { pinErrorText } from "./PinnedMessagesPanel";
import { MemberContextMenu } from "./MemberContextMenu";
import { ProfileCard } from "./ProfileCard";
import { ReactionEmojiGlyph, ReactionEmojiPickerSlot } from "./ReactionEmoji";

/* ── Stable MessageRowServices members (defined once at module scope) ───────── */

/**
 * Reactive: subscribe to a user's display name (null when unknown).
 *
 * NOTE: the nickname-aware version is built per-provider below
 * ({@link ChatDataProvider}) because the override map is server-scoped. This
 * module-scope one is the plain fallback the overrides close over.
 */
function useDisplayName(userId: string): string | null {
  return useChatStore((s) => s.users[userId]?.displayName ?? null);
}

/** Reactive: subscribe to a user's profile photo (null → initials fallback). */
function useAvatarUrl(userId: string): string | null {
  return useChatStore((s) => s.users[userId]?.avatarUrl ?? null);
}

/** Reactive: subscribe to the signed-in user's id. */
function useCurrentUserId(): string | undefined {
  return useAuthStore((s) => s.user?.id);
}

/** Non-reactive: resolve a mentioned user id to a name for the in-place editor. */
function resolveMentionName(userId: string): string | null {
  const u = useChatStore.getState().users[userId];
  return u?.displayName ?? u?.username ?? null;
}

/** Set this channel's reply target (banner + optimistic quote), sliced to the preview cap. */
function startReply(message: ChatMessageView): void {
  useChatStore.getState().setReplyTarget(message.channelId, {
    messageId: message.id,
    authorId: message.authorId,
    content: message.content.slice(0, REPLY_PREVIEW_MAX),
    kind: message.kind ?? "user",
  });
}

export function ChatDataProvider({
  channel,
  authorColors,
  profileGroupId,
  header,
  children,
}: {
  channel: Channel;
  /** userId → member-name color (server surface); omitted for DMs / flat group chats. */
  authorColors?: ReadonlyMap<string, string>;
  /** Server group id for the message-avatar / mention profile card's role list. */
  profileGroupId?: GroupId;
  /**
   * Header controls for the shared <ChatView> (server-channel surface only). The
   * flat-group-chat / DM surfaces render their own header and omit this.
   */
  header?: ChatHeaderControls;
  children: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data, error, isPending, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useChannelMessages(channel.id);
  const outbox = useChatStore((s) => s.outbox[channel.id]);
  // Hoisted ONCE for the whole list (§27): the roles/members queries behind this
  // must not be subscribed by every mounted row. The row combines it with authorship.
  const canManageMessages = useCanManageMessages(profileGroupId ?? null);
  // Nickname overrides, also hoisted once (ADR 0019 §2) — see the row services below.
  const nameOverrides = useNameOverrides(profileGroupId ?? null);
  // Who the viewer ignores (ADR 0019 §4). One cached list for the whole app, read
  // here so the shared list can fold their rows; nothing was hidden server-side.
  const ignoredAuthorIds = useIgnoredUserIds();
  // Timeouts in force in THIS server, with a single expiry timer (ADR 0019 §3).
  const timedOutMembers = useTimedOutMembers(profileGroupId ?? null);

  /**
   * Ascending (oldest→newest) view of the cache. Pages are newest-first and each
   * page is newest-first internally, so walk both backwards. Dedupe by id — a
   * realtime insert racing a refetch must never render twice. Optimistic sends
   * render after everything confirmed. (Moved verbatim from the former MessageList.)
   */
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const ascending: ChatMessage[] = [];
    const pages = data?.pages ?? [];
    for (let p = pages.length - 1; p >= 0; p--) {
      const page = pages[p];
      if (!page) continue;
      for (let i = page.messages.length - 1; i >= 0; i--) {
        const message = page.messages[i];
        if (!message || seen.has(message.id)) continue;
        seen.add(message.id);
        ascending.push(toSentChatMessage(message));
      }
    }
    for (const pending of outbox ?? []) {
      ascending.push({
        id: `outbox-${pending.nonce}`,
        channelId: pending.channelId,
        authorId: pending.authorId,
        content: pending.content,
        createdAt: pending.createdAt,
        updatedAt: null,
        deletedAt: null,
        deliveryState: pending.deliveryState,
        errorKey: pending.errorKey,
        nonce: pending.nonce,
        attachments: pending.attachments,
        localAttachmentUrls: pending.localAttachmentUrls,
        replyTo: pending.replyTo,
      });
    }
    return ascending;
  }, [data, outbox]);

  // Advance (and persist) the read watermark to the newest message while the
  // channel is open — mirrors the "mark read on open" badge behavior, so the NEXT
  // visit's divider starts fresh. Runs after the child list has frozen its divider
  // anchor (child render → effects run bottom-up), so the anchor is unaffected.
  const newestServerId = data?.pages[0]?.messages[0]?.id ?? null;
  useEffect(() => {
    if (newestServerId) {
      useChatStore.getState().setChannelReadMarker(channel.id, newestServerId);
    }
  }, [channel.id, newestServerId]);

  // Imperative watermark read (never a subscription) so the frozen divider anchor
  // in the list never re-renders it on a watermark change (§27).
  const getReadWatermark = useCallback(
    () => useChatStore.getState().lastReadMessageId[channel.id] ?? null,
    [channel.id],
  );

  // The mutation-coupled row is the slot. Stable across data/outbox ticks — its
  // deps (colors / group / permission) change rarely — so MessageRow's memo holds.
  const renderMessage = useCallback(
    (row: ChatMessageRowContext): ReactNode => (
      <MessageRow
        message={row.message}
        isContinuation={row.isContinuation}
        authorColor={authorColors?.get(row.message.authorId)}
        profileGroupId={profileGroupId}
        onJumpToMessage={row.onJumpToMessage}
        isHighlighted={row.isHighlighted}
        canManageMessages={canManageMessages}
        isArriving={row.isArriving}
        authorTimedOutUntil={timedOutMembers[row.message.authorId] ?? null}
      />
    ),
    [authorColors, profileGroupId, canManageMessages, timedOutMembers],
  );

  /**
   * The row's store/mutation/slot bindings, provided ONCE around the list so it is
   * a single stable reference — it never enters MessageRow's prop list, so the
   * row's `memo` is untouched. Only `t` (pin-error localization) and
   * `profileGroupId` (the avatar profile card's role list) are render-scoped; the
   * rest are module-stable, so this changes only on a locale / channel switch.
   */
  const rowServices = useMemo<MessageRowServices>(
    () => ({
      // Nickname-aware author name (ADR 0019 §2). The override map is built ONCE
      // for the whole list, so a row's name lookup stays a plain object read and
      // a rename repaints names without refetching a thing (§27). The base hook
      // is called UNCONDITIONALLY — the override is applied to its result, not
      // in place of the call, or the hook count would vary per row.
      useDisplayName: (userId: string) => {
        const base = useDisplayName(userId);
        return nameOverrides[userId] ?? base;
      },
      useAvatarUrl,
      useCurrentUserId,
      // Same override layer for the in-place editor's `<@id>` → `@Name` pass, so
      // editing a message shows the SAME name the row above it renders.
      resolveMentionName: (userId: string) => nameOverrides[userId] ?? resolveMentionName(userId),
      startReply,
      toggleReaction: toggleMessageReaction,
      editMessage: (messageId, content) => api.editMessage(messageId, content),
      pinMessage: (channelId, messageId) => api.pinMessage(channelId, messageId),
      unpinMessage: (channelId, messageId) => api.unpinMessage(channelId, messageId),
      deleteMessage: (messageId) => api.deleteMessage(messageId),
      retryOutbox: retryOutboxMessage,
      discardOutbox: discardOutboxMessage,
      pinErrorText: (err) => pinErrorText(err, t),
      // Avatar: profile card on click, the FULL user menu on right-click /
      // long-press — the same component the roster uses, so the two can never
      // offer different things. The menu must wrap a real DOM element (Radix
      // needs a ref), hence the `display:contents` span: it takes the trigger
      // ref and bubbled events without adding a box to the layout.
      renderProfileCard: (userId, node) => (
        <MemberContextMenu target={{ userId }} groupId={profileGroupId ?? null}>
          <span className="contents">
            <ProfileCard userId={userId} groupId={profileGroupId}>
              {node}
            </ProfileCard>
          </span>
        </MemberContextMenu>
      ),
      renderAuthorName: (userId, node) => (
        <MemberContextMenu target={{ userId }} groupId={profileGroupId ?? null}>
          <span className="contents">
            <ProfileCard userId={userId} groupId={profileGroupId}>
              <button
                type="button"
                className="cursor-pointer rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                {node}
              </button>
            </ProfileCard>
          </span>
        </MemberContextMenu>
      ),
      renderAttachments: (channelIdArg, attachments, localUrls) => (
        <AttachmentGrid channelId={channelIdArg} attachments={attachments} localUrls={localUrls} />
      ),
      renderEmbeds: (embeds) => {
        // Invite links get the dedicated invite card below — a generic unfurl
        // of the same URL would double-render it, so it is filtered out here.
        const external = embeds.filter((embed) => !isInviteLinkUrl(embed.url));
        return external.length > 0 ? <MessageEmbeds embeds={external} /> : null;
      },
      renderInviteEmbeds: (content) => <MessageInviteEmbeds content={content} />,
      renderReactionPicker: ({ onSelect, align, onOpenChange, children: trigger }) => (
        <ReactionEmojiPickerSlot onSelect={onSelect} align={align} onOpenChange={onOpenChange}>
          {trigger}
        </ReactionEmojiPickerSlot>
      ),
      renderReactionEmoji: (emoji) => <ReactionEmojiGlyph emoji={emoji} />,
    }),
    [t, profileGroupId, nameOverrides],
  );

  const value: ChatData = useMemo(
    () => ({
      channel,
      messages,
      hasMore: hasNextPage ?? false,
      isLoadingMore: isFetchingNextPage,
      isPending,
      errorMessage: error ? localizeError(error, t) : null,
      loadMore: () => fetchNextPage(),
      retry: () => void refetch(),
      getReadWatermark,
      subscribeJump: onMessageJump,
      renderMessage,
      ignoredAuthorIds,
      header,
    }),
    [
      channel,
      messages,
      hasNextPage,
      isFetchingNextPage,
      isPending,
      error,
      t,
      fetchNextPage,
      refetch,
      getReadWatermark,
      renderMessage,
      ignoredAuthorIds,
      header,
    ],
  );

  return (
    <AppChatDataProvider value={value}>
      <MessageRowServicesProvider value={rowServices}>{children}</MessageRowServicesProvider>
    </AppChatDataProvider>
  );
}
