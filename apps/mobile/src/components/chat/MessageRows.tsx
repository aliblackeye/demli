/**
 * The rows of the mobile chat thread: the server-message row, the optimistic
 * (outbox) row and the DM start card, plus the stable action / display shapes
 * ChatThread hands them.
 *
 * Both rows are memoized with a field-wise comparison of their display data,
 * so a thread re-render (a new message, a users-directory refresh, a jump
 * flash) re-renders only the rows whose drawn content actually changed — the
 * FlatList cells of everything else short-circuit (§27).
 */
import { memo } from "react";
import { View } from "react-native";
import type { ChannelId, Message, User, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { outboxErrorText } from "../../lib/outbox-errors";
import type { OutboxMessage } from "../../stores/chat-store";
import { space } from "../../theme/theme";
import { Avatar } from "../Avatar";
import { MessageBubble, type DeliveryState, type ReplyPreviewProps } from "../MessageBubble";
import { Text } from "../ui/Text";
import { DateDivider, UnreadDivider } from "./ThreadParts";
import type { ThreadRowMeta } from "./thread-rows";

/**
 * A message younger than this plays the "arrival" motion. Mirrors the desktop
 * `ARRIVAL_FRESH_MS` exactly, including WHY it is derived from the message's
 * own `createdAt` instead of from mount: FlatList mounts and unmounts cells as
 * you scroll, so a mount-triggered animation would replay on every row that
 * scrolls back into the window. History never animates; an optimistic send
 * always does.
 */
export const ARRIVAL_FRESH_MS = 1200;

/** Shared freshness test for the arrival motion. */
export function isArriving(createdAt: string): boolean {
  return Date.now() - Date.parse(createdAt) < ARRIVAL_FRESH_MS;
}

/**
 * The "start of the conversation" card for a DM (ref #3) — the peer's avatar,
 * name, @username, and a friendly opener. Rendered in the inverted list's empty
 * slot AND at the top of a fully loaded DM history.
 */
export function DmConversationStartCard({
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
        paddingTop: space.xl,
        paddingBottom: space.lg,
        alignItems: "center",
        gap: space.md,
      }}
    >
      <Avatar name={name} size={80} uri={peer?.avatarUrl ?? null} />
      <View style={{ alignItems: "center", gap: 2 }}>
        <Text type="title" tone="display" style={{ textAlign: "center" }} numberOfLines={2}>
          {name}
        </Text>
        {peer?.username ? (
          <Text type="ui" tone="muted" style={{ fontWeight: "400" }}>
            @{peer.username}
          </Text>
        ) : null}
      </View>
      <Text type="ui" tone="muted" style={{ textAlign: "center", fontWeight: "400" }}>
        {t("mobile:dm.conversationStart", { name })}
      </Text>
    </View>
  );
}

/**
 * Stable thread-level handlers handed to every row. One object for the whole
 * mount (its methods read the latest closures through a ref), so a memoized row
 * re-renders only when ITS message or display data change — never because the
 * thread re-rendered (§27).
 */
export interface RowActions {
  openActions: (message: Message) => void;
  reply: (message: Message) => void;
  openAuthor: (userId: UserId) => void;
  openAuthorMenu: (userId: UserId) => void;
  toggleReaction: (messageId: string, emoji: string, reactedByMe: boolean) => void;
  addReaction: (message: Message) => void;
  jumpTo: (messageId: string) => void;
  retry: (nonce: string) => void;
  discard: (nonce: string) => void;
}

export interface RowDisplay {
  authorName: string;
  authorAvatarUrl: string | null | undefined;
  authorColor: string | undefined;
  reply: { authorName: string; authorAvatarUrl: string | null | undefined; loaded: boolean } | null;
}

/** The dividers a cell carries above its message (upright inside the inverted list). */
export function CellDividers({ meta }: { meta: ThreadRowMeta }) {
  return (
    <>
      {meta.dayStart !== null ? <DateDivider dayStart={meta.dayStart} /> : null}
      {meta.unread ? <UnreadDivider /> : null}
    </>
  );
}

function ServerRow({
  message,
  meta,
  display,
  channelId,
  serverGroupId,
  mentioned,
  arriving,
  highlighted,
  actions,
}: {
  message: Message;
  meta: ThreadRowMeta;
  display: RowDisplay;
  channelId: ChannelId;
  serverGroupId: string | undefined;
  mentioned: boolean;
  arriving: boolean;
  highlighted: boolean;
  actions: RowActions;
}) {
  const rt = message.replyTo;
  const reply: ReplyPreviewProps | undefined =
    rt && display.reply
      ? {
          authorName: display.reply.authorName,
          authorAvatarUrl: display.reply.authorAvatarUrl,
          content: rt.content,
          deleted: rt.deleted,
          onPress: display.reply.loaded ? () => actions.jumpTo(rt.id) : undefined,
        }
      : undefined;
  return (
    <>
      <CellDividers meta={meta} />
      <MessageBubble
        authorId={message.authorId}
        authorName={display.authorName}
        authorAvatarUrl={display.authorAvatarUrl}
        authorColor={display.authorColor}
        content={message.content}
        createdAt={message.createdAt}
        edited={message.updatedAt !== null}
        delivery="sent"
        grouped={meta.grouped}
        channelId={channelId}
        attachments={message.attachments}
        embeds={message.embeds}
        reactions={message.reactions}
        reply={reply}
        mentionGroupId={serverGroupId}
        mentioned={mentioned}
        pinned={message.pinned ?? false}
        highlighted={highlighted}
        arriving={arriving}
        onLongPress={() => actions.openActions(message)}
        onReply={() => actions.reply(message)}
        onPressAuthor={() => actions.openAuthor(message.authorId)}
        onLongPressAuthor={() => actions.openAuthorMenu(message.authorId)}
        onToggleReaction={(emoji, reactedByMe) => actions.toggleReaction(message.id, emoji, reactedByMe)}
        onAddReaction={() => actions.addReaction(message)}
      />
    </>
  );
}

function OutboxRow({
  message,
  meta,
  display,
  channelId,
  serverGroupId,
  actions,
}: {
  message: OutboxMessage;
  meta: ThreadRowMeta;
  display: RowDisplay;
  channelId: ChannelId;
  serverGroupId: string | undefined;
  actions: RowActions;
}) {
  const { t } = useAppTranslation();
  // `queued` renders like `sending` (faint) but gets its own calm note — it is
  // not a failure, it just has not left the device yet.
  const delivery: DeliveryState = message.deliveryState === "failed" ? "failed" : "sending";
  const queued = message.deliveryState === "queued";
  const rt = message.replyTo;
  return (
    <>
      <CellDividers meta={meta} />
      <MessageBubble
        authorId={message.authorId}
        authorName={display.authorName}
        authorAvatarUrl={display.authorAvatarUrl}
        authorColor={display.authorColor}
        content={message.content}
        createdAt={message.createdAt}
        delivery={delivery}
        grouped={meta.grouped}
        arriving={isArriving(message.createdAt)}
        queueNote={
          queued
            ? message.errorKey === "offline"
              ? t("mobile:message.queueOffline")
              : t("mobile:message.queued")
            : undefined
        }
        failureNote={outboxErrorText(message.errorKey, t)}
        // §35: a message whose channel is gone can never be delivered, so
        // "retry" would be a button that cannot work.
        canRetry={message.errorKey !== "channel_gone"}
        onRetry={() => actions.retry(message.nonce)}
        onDiscard={() => actions.discard(message.nonce)}
        channelId={channelId}
        attachments={message.attachments}
        mentionGroupId={serverGroupId}
        onPressAuthor={() => actions.openAuthor(message.authorId)}
        reply={
          rt && display.reply
            ? {
                authorName: display.reply.authorName,
                authorAvatarUrl: display.reply.authorAvatarUrl,
                content: rt.content,
                deleted: rt.deleted,
                onPress: display.reply.loaded ? () => actions.jumpTo(rt.id) : undefined,
              }
            : undefined
        }
      />
    </>
  );
}

/** Field-wise equality for the per-render display object. */
function sameDisplay(a: RowDisplay, b: RowDisplay): boolean {
  return (
    a.authorName === b.authorName &&
    a.authorAvatarUrl === b.authorAvatarUrl &&
    a.authorColor === b.authorColor &&
    (a.reply === b.reply ||
      (a.reply !== null &&
        b.reply !== null &&
        a.reply.authorName === b.reply.authorName &&
        a.reply.authorAvatarUrl === b.reply.authorAvatarUrl &&
        a.reply.loaded === b.reply.loaded))
  );
}

function sameMeta(a: ThreadRowMeta, b: ThreadRowMeta): boolean {
  return a.grouped === b.grouped && a.dayStart === b.dayStart && a.unread === b.unread;
}

/** ServerRow, re-rendered only when what it draws changed. */
export const MemoServerRow = memo(ServerRow, (prev, next) => {
  const { display: pd, meta: pm, ...pr } = prev;
  const { display: nd, meta: nm, ...nr } = next;
  if (!sameDisplay(pd, nd) || !sameMeta(pm, nm)) return false;
  return (Object.keys(nr) as (keyof typeof nr)[]).every((k) => pr[k] === nr[k]);
});

export const MemoOutboxRow = memo(OutboxRow, (prev, next) => {
  const { display: pd, meta: pm, ...pr } = prev;
  const { display: nd, meta: nm, ...nr } = next;
  if (!sameDisplay(pd, nd) || !sameMeta(pm, nm)) return false;
  return (Object.keys(nr) as (keyof typeof nr)[]).every((k) => pr[k] === nr[k]);
});
