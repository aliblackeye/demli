/**
 * MessageRow — the SINGLE-SOURCE message row (CLAUDE.md §8), shared by the desktop
 * renderer and (Phase 4) the web app. It renders one message in the virtualized
 * thread: author/avatar/timestamp, markdown body, reply quote, attachments,
 * embeds, reactions, the outbox/queue states, the hover action toolbar (react /
 * reply / more → copy/pin/edit/delete) and the in-place editor.
 *
 * Everything store- or REST-coupled (display names, the current user, reactions,
 * edit/pin/delete, retry/discard, the profile card, attachment grid, embeds and
 * the reaction picker) is read through {@link useMessageRowServices} — the desktop
 * ChatDataProvider supplies it ONCE around the list, so the services object is a
 * stable reference that never enters this component's prop list and the `memo`
 * below still holds across data/outbox ticks.
 *
 * Per-row props (message/isContinuation/authorColor/… ) are the list's derived
 * per-row context; the surface's `renderMessage` closure adds its own surface
 * data (author color, profile group, permission) around them.
 *
 * Safari-12 notes: this file predates `flex gap` / `:has()` support on the oldest
 * target (the web surface). Non-wrapping gaps are reproduced with `space-x-*`; the
 * wrapping reactions row uses per-child `mr-1 mb-1` + a `-mb-1` container; and the
 * hover toolbar's two `:has()` visibility rules are driven from JS state instead.
 */
import { memo, useState } from "react";
import {
  ArrowRight,
  Clock,
  Copy,
  CornerUpRight,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { resolveSystemMessage, useTranslation, type TFunction, type TranslateFn } from "@demli/i18n";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { friendlyErrorMessage, type OutboxErrorKey } from "@demli/client-core";
import { contentMentionsUser } from "@demli/protocol";
import type { GroupId, MessageId, MessageReplyPreview } from "@demli/types";
import { useMessageRowServices } from "../data/message-row-data";
import type { ChatMessageView } from "../data/chat-data";
import { MessageEditor } from "./MessageEditor";
import { MessageMarkdown } from "./MessageMarkdown";
import { TimeoutBadge } from "./TimeoutBadge";

type ChatTFunction = TFunction<["common", "desktop"]>;

/* ── Inlined pure helpers (moved from the desktop lib into the shared layer) ── */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "14:32" — gutter timestamp for grouped messages. */
function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** "Today at 14:32" / "Yesterday at 09:10" / "12.05.2026 14:32". */
function formatMessageTimestamp(iso: string, t: ChatTFunction): string {
  const date = new Date(iso);
  const today = startOfDay(new Date());
  const day = startOfDay(date);
  const dayDiff = Math.round((today - day) / 86_400_000);
  const time = timeFormat.format(date);
  if (dayDiff === 0) return t("desktop:chat.timeToday", { time });
  if (dayDiff === 1) return t("desktop:chat.timeYesterday", { time });
  return `${dateFormat.format(date)} ${time}`;
}

/** Localize an offline-queue failure reason (M17) — the queue stores a KEY. */
function outboxErrorText(key: OutboxErrorKey | null, t: ChatTFunction): string {
  switch (key) {
    case "offline":
      return t("desktop:chat.queueOffline");
    case "timeout":
      return t("desktop:chat.queueTimeout");
    case "rejected":
      return t("desktop:chat.queueRejected");
    case "channel_gone":
      return t("desktop:chat.queueChannelGone");
    case "attempts_exhausted":
      return t("desktop:chat.queueExhausted");
    default:
      return t("desktop:chat.sendFailed");
  }
}

/**
 * Whether the viewer may pin/unpin a message authored by `authorId` (COSMETIC —
 * the API re-checks). True for a manager/owner (or any member on a surface with no
 * role system), or the message's own author.
 */
function canPinMessage(
  canManageMessages: boolean,
  authorId: string,
  currentUserId: string | undefined,
): boolean {
  if (canManageMessages) return true;
  return currentUserId !== undefined && authorId === currentUserId;
}

/** Compact "pinned" marker drawn on a pinned message row in the scrollback. */
function PinnedMarker(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <span
      // Safari 12: no flex `gap` → `space-x-1` reproduces the icon/label gutter.
      className="mb-0.5 flex items-center space-x-1 text-2xs font-medium text-fg-faint"
      aria-label={t("desktop:pins.title")}
    >
      <Pin className="size-3 shrink-0" aria-hidden />
      <span>{t("desktop:pins.title")}</span>
    </span>
  );
}

export interface MessageRowProps {
  message: ChatMessageView;
  /** Compact row — same author within the grouping window, avatar hidden. */
  isContinuation: boolean;
  /** Author's highest colored-role color (server surface only); undefined = default. */
  authorColor?: string;
  /** Server group id — enables the profile card's role list (server surface only). */
  profileGroupId?: GroupId;
  /** Scroll to (and briefly flash) the quoted message when its preview is clicked. */
  onJumpToMessage?: (messageId: MessageId) => void;
  /** True while this row is the flash target of a reply-preview jump. */
  isHighlighted?: boolean;
  /**
   * Viewer holds MANAGE_MESSAGES on this surface (M17 pins). Hoisted to the list
   * so the roles/members queries are subscribed ONCE, not once per row (§27).
   */
  canManageMessages?: boolean;
  /**
   * This message landed moments ago → play the "arrival" motion instead of
   * appearing instantly. Computed by MessageList from the message's own
   * timestamp, so scrolling a virtualized row back into view never replays it.
   */
  isArriving?: boolean;
  /**
   * The author is currently timed out in this server (ADR 0019 §3) — renders a
   * small clock beside their name. Resolved ONCE for the whole list by the
   * surface (a single expiry timer, not one per row, §27) and passed down as a
   * plain boolean, so an expiring mute repaints only the rows it names.
   */
  authorTimedOutUntil?: string | null;
}

/**
 * System notice (member joined/left) — centered, dimmed, single line, no
 * avatar and no message affordances (hover actions / retry).
 *
 * Content is a language-neutral `@sys:*` token (ADR 0009). `resolveSystemMessage`
 * localizes it with the author's CURRENT display name (so renames reflect
 * everywhere); legacy plain-text rows fall through verbatim.
 */
function SystemMessageRow({
  message,
  authorName,
}: {
  message: ChatMessageView;
  authorName: string;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const text = resolveSystemMessage(message.content, authorName, t as unknown as TranslateFn);
  return (
    // Safari 12: no flex `gap` → `space-x-2` reproduces the icon/text gutter.
    <div className="flex items-center justify-center space-x-2 px-4 py-1 text-xs text-fg-faint">
      <ArrowRight className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
      <span className="min-w-0 truncate text-fg-muted">{text}</span>
      <span className="shrink-0 tabular-nums text-fg-faint">{formatTime(message.createdAt)}</span>
    </div>
  );
}

/**
 * The dimmed quote line above a reply's content (ADR 0011 §2). Resolves the
 * quoted author's name from the users directory by id (the preview carries only
 * `authorId`). Clicking scrolls to the target; a soft-deleted target renders the
 * "deleted" stub and is not clickable.
 */
function ReplyPreviewLine({
  replyTo,
  onJump,
}: {
  replyTo: MessageReplyPreview;
  onJump?: (messageId: MessageId) => void;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const { useDisplayName } = useMessageRowServices();
  const name = useDisplayName(replyTo.authorId) ?? t("desktop:chat.unknownUser");
  const clickable = !replyTo.deleted && onJump !== undefined;

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? () => onJump?.(replyTo.id) : undefined}
      aria-label={
        replyTo.deleted
          ? t("desktop:chat.replyDeleted")
          : t("desktop:chat.replyPreviewAria", { name })
      }
      className={cn(
        // Safari 12: no flex `gap` → `space-x-1` reproduces the icon/name gutter.
        "group/reply mb-0.5 flex max-w-full items-center space-x-1 text-left text-xs text-fg-faint",
        "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        clickable && "cursor-pointer hover:text-fg-muted",
        !clickable && "cursor-default",
      )}
    >
      <CornerUpRight className="size-3 shrink-0 text-fg-faint" aria-hidden />
      {replyTo.deleted ? (
        <span className="truncate italic">{t("desktop:chat.replyDeleted")}</span>
      ) : (
        <>
          <span className="shrink-0 font-medium text-fg-muted group-hover/reply:text-fg">
            {name}
          </span>
          <span className="min-w-0 truncate opacity-90">{replyTo.content}</span>
        </>
      )}
    </button>
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  isContinuation,
  authorColor,
  profileGroupId,
  onJumpToMessage,
  isHighlighted = false,
  canManageMessages = false,
  isArriving = false,
  authorTimedOutUntil = null,
}: MessageRowProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const services = useMessageRowServices();
  const name = services.useDisplayName(message.authorId) ?? t("desktop:chat.unknownUser");
  const avatarUrl = services.useAvatarUrl(message.authorId);
  const currentUserId = services.useCurrentUserId();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinPending, setPinPending] = useState(false);
  // The hover toolbar's two `:has()` visibility rules become JS state so the
  // shared component works on the Safari-12 web target: `pickerOpen`/`menuOpen`
  // replace `:has([data-state=open])` (keep it open while a menu is open) and
  // `toolbarFocus` replaces `has-[:focus-visible]` (keep it open on keyboard focus).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toolbarFocus, setToolbarFocus] = useState(false);

  if (message.kind === "system") {
    return <SystemMessageRow message={message} authorName={name} />;
  }

  // `queued` and `sending` both dim the text; only `queued` gets the explicit
  // "waiting to send" line, because that is the state a user can be surprised by
  // (typed offline, still not delivered) — an in-flight send resolves in ms.
  const queued = message.deliveryState === "queued";
  const sending = queued || message.deliveryState === "sending";
  const failed = message.deliveryState === "failed";
  // Only a confirmed, server-persisted message can be reacted to / replied to /
  // quoted — an optimistic (sending) or failed row has no real id yet.
  const isConfirmed = message.deliveryState === "sent";
  const reactions = message.reactions ?? [];
  // Edit/delete affordances are author-only (the server enforces the same); the
  // "(edited)" marker keys off the row's `updatedAt` (null until first edit).
  const isOwn = currentUserId !== undefined && message.authorId === currentUserId;
  const isEdited = message.updatedAt !== null;
  // Pin gating mirrors the server rule (author ∨ MANAGE_MESSAGES ∨ owner; anyone
  // in a DM / flat group chat, which is what `canManageMessages` resolves to
  // there). §35: an unauthorized member never sees the item at all.
  const isPinned = message.pinned ?? false;
  const canPin = canPinMessage(canManageMessages, message.authorId, currentUserId);
  // Subtle "this message mentions you" emphasis. Pre-gated on the cheap `<@`
  // substring so the scan runs only for the rare message that carries a mention
  // (§27) — never for our own messages.
  const mentionsMe =
    !isOwn &&
    currentUserId !== undefined &&
    message.content.includes("<@") &&
    contentMentionsUser(message.content, currentUserId);

  const startReply = (): void => services.startReply(message);

  const pickReaction = (emoji: string): void => {
    const existing = reactions.find((r) => r.emoji === emoji);
    services.toggleReaction(message.channelId, message.id, emoji, existing?.reactedByMe ?? false);
  };

  const copyText = (): void => {
    if (message.content) void navigator.clipboard?.writeText(message.content);
  };

  // Edit is committed over REST; the `message.updated` broadcast reconciles the
  // cache (adds the "(edited)" marker), so on success we just leave edit mode.
  const saveEdit = async (content: string): Promise<void> => {
    await services.editMessage(message.id, content);
    setIsEditing(false);
  };

  /**
   * Pin / unpin over REST, deliberately NOT through a `useMutation`: this
   * component is the virtualized row, ~50 of them are mounted, and one mutation
   * observer per row is pure overhead for an action taken once in a while (§27).
   * Delete right below takes the same direct-call shape for the same reason.
   *
   * No optimistic write either — the authoritative update arrives over the
   * socket (`message.pinned` → foldMessagePin + a pins invalidation).
   */
  const togglePin = (): void => {
    setPinError(null);
    setPinPending(true);
    const request = isPinned
      ? services.unpinMessage(message.channelId, message.id)
      : services.pinMessage(message.channelId, message.id);
    void request.then(
      () => setPinPending(false),
      (err: unknown) => {
        setPinPending(false);
        setPinError(services.pinErrorText(err));
      },
    );
  };

  // Delete over REST; the inbound `message.deleted` removes the row from the
  // cache (no tombstone — matches the realtime handler on both platforms).
  const confirmDelete = (): void => {
    setDeletePending(true);
    setDeleteError(null);
    void services.deleteMessage(message.id).then(
      () => {
        setConfirmingDelete(false);
        setDeletePending(false);
      },
      (err: unknown) => {
        setDeletePending(false);
        setDeleteError(friendlyErrorMessage(err));
      },
    );
  };

  return (
    <div
      className={cn(
        "group relative border-l-2 border-transparent px-4 py-0.5 transition-colors motion-instant hover:bg-white/[0.025]",
        // UI overhaul spec: 18px rhythm between message groups (was 10px) —
        // now the shared `4.5` spacing step rather than an arbitrary literal.
        !isContinuation && "mt-4.5",
        // A message that arrived seconds ago resolves into place (blur → sharp,
        // lift → settle) instead of blinking in. Default fill-mode, so the row
        // drops back to plain styles the instant the animation ends — no
        // lingering filter, and therefore no lingering containing block for the
        // absolutely positioned hover toolbar below.
        isArriving && "animate-arrival",
        mentionsMe && "border-accent bg-accent/[0.06]",
        isHighlighted && "bg-accent/10",
      )}
    >
      {/* Safari 12: no flex `gap` → `space-x-3` reproduces the avatar/content gutter. */}
      <div className="flex space-x-3">
        <div className="relative w-10 shrink-0 pt-0.5">
          {isContinuation ? (
            // Reveal the gutter timestamp on hover WITHOUT changing the row's
            // measured height. A display `hidden`→`flex` swap here makes the
            // gutter (h-5) taller than a single-line text column, so the row's
            // border-box grows on hover; the virtualized list observes each row
            // with a ResizeObserver (measureElement), re-measures, and shifts
            // every row below (founder: "hover edince yukarı aşağı kayıyor").
            // Absolute + opacity keeps offsetHeight constant → no re-measure.
            <span className="pointer-events-none absolute inset-x-0 top-0.5 flex h-5 items-center justify-end text-badge tabular-nums text-fg-faint opacity-0 transition-opacity motion-instant group-hover:opacity-100">
              {formatTime(message.createdAt)}
            </span>
          ) : (
            services.renderProfileCard(
              message.authorId,
              <button
                type="button"
                aria-label={name}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <UserAvatar
                  src={avatarUrl ?? undefined}
                  name={name}
                  colorSeed={message.authorId}
                  size="md"
                />
              </button>,
            )
          )}
        </div>
        <div className="min-w-0 flex-1">
          {isPinned && <PinnedMarker />}
          {message.replyTo && (
            <ReplyPreviewLine replyTo={message.replyTo} onJump={onJumpToMessage} />
          )}
          {!isContinuation && (
            // The gutter is set by MARGIN ON THE LATER ITEMS, not by `space-x-*`
            // on this container and not by `gap`.
            //
            // `gap` is out because the web build still targets Safari 12, which
            // has no flex gap. `space-x-2` was the workaround and it silently did
            // NOTHING: it puts the margin on the sibling, and the surface wraps
            // the author name in a `display: contents` span (ChatDataProvider) so
            // the name/menu/profile-card plumbing does not add a box. An element
            // that generates no box cannot carry a margin — so the name and the
            // timestamp rendered glued together ("KeremBugün 13:59"), in every
            // channel and DM, for as long as that wrapper has existed.
            //
            // Marking the later items instead is immune to what the surface does
            // with the earlier ones.
            <div className="flex items-baseline">
              {/* The author's name is an affordance, not a label: it opens the
                  same profile card and the same user menu the avatar does. The
                  surface supplies the wrapper (it owns the popover/menu); an
                  un-wired surface just renders the name. */}
              {services.renderAuthorName?.(
                message.authorId,
                <span className="text-sm font-semibold text-fg" style={{ color: authorColor }}>
                  {name}
                </span>,
              ) ?? (
                <span className="text-sm font-semibold text-fg" style={{ color: authorColor }}>
                  {name}
                </span>
              )}
              {/* Timed-out marker (ADR 0019 §3). `self-center` keeps it out of the
                  baseline box, so a 14px glyph never grows this 20px line and the
                  virtualized row keeps its measured height. */}
              {authorTimedOutUntil && (
                <TimeoutBadge timedOutUntil={authorTimedOutUntil} className="ml-2" />
              )}
              <span className="ml-2 text-2xs text-fg-faint">
                {formatMessageTimestamp(message.createdAt, t)}
              </span>
            </div>
          )}
          {isEditing ? (
            <MessageEditor
              initialValue={message.content}
              onSave={saveEdit}
              onCancel={() => setIsEditing(false)}
              resolveMentionName={services.resolveMentionName}
            />
          ) : (
            message.content && (
              <MessageMarkdown
                content={message.content}
                groupId={profileGroupId}
                className={cn("text-fg/90", sending && "text-fg-faint", failed && "text-danger/90")}
                append={
                  isEdited ? (
                    <span className="ml-1 select-none align-baseline text-badge text-fg-faint">
                      {t("desktop:chat.edited")}
                    </span>
                  ) : undefined
                }
              />
            )
          )}
          {message.attachments && message.attachments.length > 0 &&
            services.renderAttachments(
              message.channelId,
              message.attachments,
              message.localAttachmentUrls,
            )}

          {message.embeds && message.embeds.length > 0 && services.renderEmbeds(message.embeds)}

          {/* Invite cards (davet embed kartı): detected from the TEXT of confirmed
              messages by the surface — optimistic/outbox rows skip it so an unsent
              paste never fires preview requests. */}
          {isConfirmed &&
            message.content !== "" &&
            services.renderInviteEmbeds !== undefined &&
            services.renderInviteEmbeds(message.content)}

          {isConfirmed && reactions.length > 0 && (
            // Safari 12: a WRAPPING flex has no `gap` substitute in `space-x-*`, so
            // the gutter is per-child `mr-1 mb-1` with a `-mb-1` container to cancel
            // the last row's bottom margin (identical spacing, no extra DOM).
            <div className="mt-1 -mb-1 flex flex-wrap items-center">
              {reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  aria-pressed={r.reactedByMe}
                  aria-label={t("desktop:chat.reactionToggle", { emoji: r.emoji, count: r.count })}
                  onClick={() =>
                    services.toggleReaction(message.channelId, message.id, r.emoji, r.reactedByMe)
                  }
                  className={cn(
                    // Safari 12: no flex `gap` → `space-x-1` for the emoji/count gutter.
                    "mr-1 mb-1 inline-flex items-center space-x-1 rounded-full border px-1.5 py-0.5",
                    "transition-colors motion-instant focus-visible:outline-none",
                    "focus-visible:ring-2 focus-visible:ring-accent/70",
                    r.reactedByMe
                      ? "border-accent/60 bg-accent/15 text-fg"
                      : "border-stroke bg-raised/60 text-fg-muted hover:border-stroke-strong hover:bg-raised",
                  )}
                >
                  <span aria-hidden className="flex items-center text-sm leading-none">
                    {services.renderReactionEmoji(r.emoji)}
                  </span>
                  <span className="text-xs font-medium tabular-nums">{r.count}</span>
                </button>
              ))}
              {services.renderReactionPicker({
                onSelect: pickReaction,
                align: "start",
                children: (
                  <button
                    type="button"
                    aria-label={t("desktop:chat.addReaction")}
                    className={cn(
                      "mr-1 mb-1 inline-flex h-[22px] items-center justify-center rounded-full border border-stroke px-1.5",
                      "text-fg-faint transition-colors motion-instant hover:border-stroke-strong hover:text-fg-muted",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                    )}
                  >
                    <SmilePlus className="size-3.5" />
                  </button>
                ),
              })}
            </div>
          )}

          {pinError && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {pinError}
            </p>
          )}

          {/* Persistent queue (M17): "waiting to send" is its own calm state —
              it is NOT a failure, it just has not left the device yet. */}
          {queued && (
            // Safari 12: no flex `gap` → `space-x-1.5` (text wrapped so it's an element).
            <p className="mt-0.5 flex items-center space-x-1.5 text-2xs text-fg-faint">
              <Clock className="size-3 shrink-0" aria-hidden />
              <span>
                {message.errorKey === "offline"
                  ? t("desktop:chat.queueOffline")
                  : t("desktop:chat.queued")}
              </span>
            </p>
          )}

          {failed && message.nonce !== null && (
            // Safari 12: no flex `gap` → `space-x-2` reproduces the control gutter.
            <div className="mt-1 flex items-center space-x-2 text-xs">
              <span className="text-danger">{outboxErrorText(message.errorKey, t)}</span>
              {/* §35: a message whose channel is gone can never be delivered —
                  offering "retry" there would be a button that cannot work. */}
              {message.errorKey !== "channel_gone" && (
                <button
                  type="button"
                  onClick={() => services.retryOutbox(message.channelId, message.nonce ?? "")}
                  className="cursor-pointer font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 rounded-sm"
                >
                  {t("desktop:chat.retry")}
                </button>
              )}
              <button
                type="button"
                onClick={() => services.discardOutbox(message.channelId, message.nonce ?? "")}
                className="cursor-pointer font-medium text-fg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 rounded-sm"
              >
                {t("desktop:chat.discard")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Hover actions — live only on confirmed messages (ADR 0011). */}
      {isConfirmed && (
        <div
          // JS mirror of the former `has-[:focus-visible]` + `:has([data-state=open])`
          // CSS: a data attribute the variant selector keys off, so it wins over
          // `hidden` exactly like `group-hover:flex` does (and works on Safari 12).
          data-open={pickerOpen || menuOpen || toolbarFocus ? "true" : undefined}
          onFocus={(event) => {
            // Only keyboard focus keeps the toolbar open (mirrors `:focus-visible`);
            // `.matches` throws on browsers without the pseudo — treat focus as
            // visible there so a keyboard user is never stranded on a hidden button.
            try {
              if (event.target.matches(":focus-visible")) setToolbarFocus(true);
            } catch {
              setToolbarFocus(true);
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setToolbarFocus(false);
            }
          }}
          className={cn(
            // Safari 12: no flex `gap` → `space-x-0.5` for the toolbar button gutter.
            "absolute -top-3 right-4 hidden items-center space-x-0.5 rounded-lg border border-stroke",
            "bg-overlay p-0.5 shadow-md group-hover:flex data-[open]:flex",
          )}
        >
          {services.renderReactionPicker({
            onSelect: pickReaction,
            onOpenChange: setPickerOpen,
            children: (
              <Button variant="ghost" size="icon-sm" aria-label={t("desktop:chat.addReaction")}>
                <SmilePlus className="size-4" />
              </Button>
            ),
          })}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("desktop:chat.reply")}
                onClick={startReply}
              >
                <Reply className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("desktop:chat.reply")}</TooltipContent>
          </Tooltip>

          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("desktop:chat.more")}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onSelect={startReply}>
                <Reply className="size-4" />
                {t("desktop:chat.reply")}
              </DropdownMenuItem>
              {message.content && (
                <DropdownMenuItem onSelect={copyText}>
                  <Copy className="size-4" />
                  {t("desktop:chat.copyText")}
                </DropdownMenuItem>
              )}
              {canPin && (
                <DropdownMenuItem disabled={pinPending} onSelect={togglePin}>
                  {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                  {isPinned ? t("desktop:pins.unpin") : t("desktop:pins.pin")}
                </DropdownMenuItem>
              )}
              {isOwn && message.content && (
                <DropdownMenuItem onSelect={() => setIsEditing(true)}>
                  <Pencil className="size-4" />
                  {t("desktop:chat.edit")}
                </DropdownMenuItem>
              )}
              {isOwn && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => setConfirmingDelete(true)}>
                    <Trash2 className="size-4" />
                    {t("desktop:chat.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {isOwn && (
        <Dialog
          open={confirmingDelete}
          onOpenChange={(open) => {
            setConfirmingDelete(open);
            if (!open) setDeleteError(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("desktop:chat.deleteConfirmTitle")}</DialogTitle>
              <DialogDescription>{t("desktop:chat.deleteConfirmBody")}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              {message.content && (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-stroke bg-raised/50 p-2.5 text-sm text-fg-muted">
                  {message.content}
                </div>
              )}
              {deleteError && <p className="mt-2 text-sm text-danger">{deleteError}</p>}
              {/* Safari 12: no flex `gap` → `space-x-2` reproduces the button gutter. */}
              <div className="mt-5 flex space-x-2">
                <Button
                  variant="danger"
                  disabled={deletePending}
                  onClick={confirmDelete}
                  className="flex-1"
                >
                  {t("buttons.delete")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={deletePending}
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1"
                >
                  {t("buttons.cancel")}
                </Button>
              </div>
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});
