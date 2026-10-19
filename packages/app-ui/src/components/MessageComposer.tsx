/**
 * MessageComposer — the SINGLE-SOURCE message composer (CLAUDE.md §8), shared by
 * the desktop renderer and (Phase 4) the web app. It owns the textarea + its
 * auto-resize, the saved-draft lifecycle (M17), @mention autocomplete, the reply
 * banner (ADR 0011 §2), attachment drag/drop + paste, the emoji picker, the
 * slow-mode note/countdown, and the send path.
 *
 * Everything store-, draft-, realtime- or desktop-coupled is read through
 * {@link useComposerServices}; the mention parsing/serialization is the shared
 * `@demli/client-core` logic. So the rendered DOM stays byte-identical to the
 * hand-written desktop surface it replaces.
 *
 * Safari-12 note: every flex `gap` here is a NON-wrapping row, so each is
 * reproduced with `space-x-*` (the two icon+text rows wrap their text in a `<span>`
 * so the margin lands on an element).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Ban, Clock, CornerUpRight, ImageUp, Paperclip, SmilePlus, X } from "lucide-react";
import { useTranslation } from "@demli/i18n";
import { Button, Tooltip, TooltipContent, TooltipTrigger, UserAvatar, cn } from "@demli/ui";
import { ATTACHMENT_MAX_PER_MESSAGE, MESSAGE_MAX_LENGTH } from "@demli/config";
import {
  applyMentionInsert,
  applyMentionPick,
  detectMentionQuery,
  rankMentionCandidates,
  serializeMentions,
  replyPreviewText,
  BROADCAST_MENTION_CANDIDATES,
  type MentionCandidate,
  type MentionQuery,
  type PendingMention,
} from "@demli/client-core";
import type { Channel } from "@demli/types";
import {
  useComposerServices,
  type ComposerReplyPayload,
  type ComposerSendAttachments,
  type ComposerSendBlock,
} from "../data/composer-data";
import { onMentionInsert } from "../data/mention-insert";
import { onComposerFocusRequest, requestEditLastMessage } from "../data/edit-request";

const MAX_HEIGHT_PX = 192;
/** Show the remaining-characters counter once the draft is this close to the cap. */
const COUNTER_THRESHOLD = 200;
/** How many mention suggestions to show at once. */
const MENTION_SUGGESTION_LIMIT = 8;

/**
 * Compact human duration for slow-mode intervals/countdowns: "5s", "1m",
 * "1m 30s", "2h". Inlined into the shared layer (moved from the desktop lib).
 */
/** Stand-in for a surface that does not wire {@link ComposerServices.useSendBlock}. */
function useNoSendBlock(): ComposerSendBlock | null {
  return null;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

/**
 * Live slow-mode countdown for a channel. Renders the amber "wait Ns" badge
 * while a SLOWMODE cooldown is active, ticking once a second, and clears the
 * store entry when it elapses. Returns null when there's nothing to show.
 */
function SlowmodeCountdown({ channelId }: { channelId: string }): JSX.Element | null {
  const { t } = useTranslation(["common", "desktop"]);
  const { useSlowmodeCooldownUntil, clearSlowmodeCooldown } = useComposerServices();
  const cooldownUntil = useSlowmodeCooldownUntil(channelId);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, cooldownUntil - Date.now()));

  useEffect(() => {
    if (cooldownUntil <= Date.now()) {
      setRemainingMs(0);
      return;
    }
    const tick = (): void => {
      const left = cooldownUntil - Date.now();
      if (left <= 0) {
        setRemainingMs(0);
        clearSlowmodeCooldown(channelId);
      } else {
        setRemainingMs(left);
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [cooldownUntil, channelId, clearSlowmodeCooldown]);

  if (remainingMs <= 0) return null;
  return (
    // Safari 12: no flex `gap` → `space-x-1.5` reproduces the icon/text gutter.
    <div className="mb-2 flex">
      <span
        role="status"
        className="inline-flex h-6 items-center space-x-1.5 rounded-pill bg-warning/12 px-2.5 text-2xs font-medium tabular-nums text-warning animate-fade-in"
      >
        <Clock className="size-3.5 shrink-0" aria-hidden />
        <span>
          {t("desktop:composer.slowmodeCountdown", { duration: formatDuration(remainingMs / 1000) })}
        </span>
      </span>
    </div>
  );
}

export function MessageComposer({
  channel,
  showAttachmentButton = true,
}: {
  channel: Channel;
  /**
   * Render the attach-files button (default true). Surfaces with no attachment
   * support (e.g. the web client, §35) pass false so no permanently-disabled
   * attach button is shown; the drop/paste handlers stay inert via the services'
   * `useAttachmentsDisabled()`.
   */
  showAttachmentButton?: boolean;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const services = useComposerServices();
  // Seed from this channel's saved draft (M17) so a restored draft is on screen at
  // first paint, before the channel-change effect below runs.
  const [value, setValue] = useState(() => services.getDraft(channel.id));
  // Mirror of `value` for handlers that outlive a render (the mention-insert
  // subscription), so they never re-subscribe per keystroke to stay current.
  const valueRef = useRef(value);
  valueRef.current = value;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const slowmodeSeconds = channel.slowmodeSeconds ?? 0;

  // Reply context (ADR 0011 §2), scoped to this channel. `replyTarget` is the
  // object (drives the banner); `replyAuthorName` is a primitive so a users-map
  // change repaints only the name, not the whole composer.
  const replyTarget = services.useReplyTarget(channel.id);
  const replyAuthorName = services.useReplyAuthorName(channel.id);

  // @mention autocomplete. Candidates come from the in-memory users directory
  // (fed by the group/roster loads — reused, never refetched); `@everyone`/`@here`
  // are offered only on a multi-member surface (server channel or flat group chat,
  // not a DM). Picked mentions are remembered as `pendingMentions` and rewritten
  // to `<@id>` on send (shared serializer).
  const meId = services.useMeId();
  const users = services.useUsers();
  const allowBroadcast = services.useAllowBroadcast();
  const [pendingMentions, setPendingMentions] = useState<PendingMention[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const candidates = useMemo<MentionCandidate[]>(() => {
    const roster = Object.values(users)
      .filter((u) => u.id !== meId)
      .map((u) => ({
        id: u.id,
        label: u.displayName || u.username,
        username: u.username,
        avatarUrl: u.avatarUrl,
      }));
    return allowBroadcast ? [...BROADCAST_MENTION_CANDIDATES, ...roster] : roster;
  }, [users, meId, allowBroadcast]);

  const suggestions = useMemo(
    () =>
      mention ? rankMentionCandidates(mention.query, candidates, MENTION_SUGGESTION_LIMIT) : [],
    [mention, candidates],
  );
  const mentionOpen = mention !== null && suggestions.length > 0;

  // Known-before-send refusal (the viewer blocked this DM peer). Optional seam:
  // a surface that does not wire it simply never shows the blocked state.
  const useSendBlock = services.useSendBlock ?? useNoSendBlock;
  const sendBlock = useSendBlock(channel.id);
  const listboxId = useId();

  const attachmentsDisabled = services.useAttachmentsDisabled();
  const { drafts, hasPending, hasDrafts, addFiles, removeDraft, retryDraft, clearDrafts } =
    services.useAttachmentDrafts(channel.id);

  const atMax = drafts.length >= ATTACHMENT_MAX_PER_MESSAGE;
  const attachDisabled = attachmentsDisabled || atMax;
  const attachTooltip = attachmentsDisabled
    ? t("errors.attachmentsDisabled")
    : atMax
      ? t("desktop:composer.maxFiles", { count: ATTACHMENT_MAX_PER_MESSAGE })
      : t("desktop:composer.attachFiles");

  // Load this channel's saved draft on enter (M17), and on leave flush the outgoing
  // channel's just-typed text into the store before the next channel loads. The store
  // debounces its persist, so this flush is what guarantees the draft is saved on a
  // channel switch. Attachment drafts reset via the useAttachmentDrafts cleanup keyed
  // on channel.id; typing.stop still fires for the channel we are leaving.
  useEffect(() => {
    const draft = services.getDraft(channel.id);
    setValue(draft);
    setPendingMentions([]);
    setMention(null);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      // Re-fit for a multi-line restored draft once it has painted.
      if (draft) {
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.style.height = "auto";
          node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
        });
      }
    }
    return () => {
      services.notifyIdle(channel.id);
      services.flushDrafts();
    };
  }, [channel.id]);

  // Focus the input when a reply target is set (e.g. from the message Reply
  // action) so the user can type straight into the quote.
  useEffect(() => {
    if (replyTarget) textareaRef.current?.focus();
  }, [replyTarget?.messageId]);

  // "Mention" from the user context menu / profile card. The command arrives on
  // a module-level emitter (see data/mention-insert) because the text, caret and
  // pending-mention list are LOCAL state here — the menu cannot reach them, and
  // routing a keystroke-adjacent value through a store would re-render the world
  // (§27).
  //
  // It goes through the SHARED `applyMentionInsert` — the same client-core code
  // the autocomplete pick uses, and the same call mobile's Composer makes — so a
  // menu mention and a typed one are byte-identical: same `@Label ` token, same
  // remembered PendingMention, same `<@id>` on the wire. Hand-rolling the splice
  // here is how the two paths drift and the menu ends up inserting text that
  // pings nobody (§35).
  //
  // Side effects (draft write, focus, resize) stay OUT of the state updater: an
  // updater may be re-run by React, and persisting a draft twice from a render
  // pass is how a "phantom" draft appears. `valueRef` gives the current text
  // without putting `value` in the dependency list, which would re-subscribe the
  // emitter on every keystroke.
  useEffect(
    () =>
      onMentionInsert(({ userId, label }) => {
        const el = textareaRef.current;
        const caret = el?.selectionStart ?? valueRef.current.length;
        const res = applyMentionInsert(valueRef.current, caret, { id: userId, label });
        setValue(res.text);
        setPendingMentions((prev) => [...prev, res.pending]);
        setMention(null);
        services.setDraft(channel.id, res.text);
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(res.caret, res.caret);
          node.style.height = "auto";
          node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
        });
      }),
    [services, channel.id],
  );

  // An in-place edit that just closed hands the keyboard back here (↑ → edit →
  // Enter/Esc keeps the user typing without reaching for the mouse).
  useEffect(
    () =>
      onComposerFocusRequest((channelId) => {
        if (channelId === channel.id) textareaRef.current?.focus();
      }),
    [channel.id],
  );

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, []);

  const cancelReply = useCallback(() => {
    services.clearReplyTarget(channel.id);
  }, [services, channel.id]);

  /** Insert a quick-react emoji at the caret (the composer's text-emoji picker). */
  const insertEmoji = useCallback(
    (emoji: string) => {
      const el = textareaRef.current;
      setValue((current) => {
        if (current.length + emoji.length > MESSAGE_MAX_LENGTH) return current;
        const start = el?.selectionStart ?? current.length;
        const end = el?.selectionEnd ?? current.length;
        const next = current.slice(0, start) + emoji + current.slice(end);
        // Persist the edit as a draft (idempotent even if the updater double-runs).
        services.setDraft(channel.id, next);
        // Restore the caret after the inserted emoji and re-fit once painted.
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.focus();
          const caret = start + emoji.length;
          node.setSelectionRange(caret, caret);
          node.style.height = "auto";
          node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
        });
        return next;
      });
    },
    [services, channel.id],
  );

  const pickFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (attachmentsDisabled || !files) return;
      const list = Array.from(files);
      if (list.length > 0) addFiles(list);
    },
    [attachmentsDisabled, addFiles],
  );

  /** Re-evaluate the active `@fragment` at the given caret (open/close the picker). */
  const refreshMention = useCallback((text: string, caret: number) => {
    setMention(detectMentionQuery(text, caret));
    setMentionIndex(0);
  }, []);

  /** Insert the picked candidate, remember it for send-serialization, and restore focus. */
  const pickMention = useCallback(
    (candidate: MentionCandidate) => {
      const el = textareaRef.current;
      setMention((active) => {
        if (!active) return null;
        const caret = el?.selectionStart ?? value.length;
        const res = applyMentionPick(value, active.start, caret, candidate);
        setValue(res.text);
        services.setDraft(channel.id, res.text);
        setPendingMentions((prev) => [...prev, res.pending]);
        requestAnimationFrame(() => {
          const node = textareaRef.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(res.caret, res.caret);
          node.style.height = "auto";
          node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
        });
        return null; // close the picker
      });
    },
    [value, services, channel.id],
  );

  const submit = useCallback(() => {
    // Rewrite picked @mentions (`@Name`) to their `<@id>` wire form before send
    // (shared serializer). A mention the user edited away simply stays literal.
    const text = serializeMentions(value, pendingMentions).trim();
    // Content-OR-attachments (ADR 0008); never send while an upload is pending.
    if (hasPending) return;
    const readyDrafts = drafts.filter((d) => d.status === "ready" && d.attachment);
    if (text.length === 0 && readyDrafts.length === 0) return;

    services.notifyIdle(channel.id);

    // Thread the reply target (ADR 0011 §2) if this channel has one. The lean
    // preview lets the optimistic row render the quote before the server echo.
    const target = services.getReplyTarget(channel.id);
    const reply: ComposerReplyPayload | undefined = target
      ? {
          replyToMessageId: target.messageId,
          replyTo: {
            id: target.messageId,
            authorId: target.authorId,
            content: target.content,
            kind: target.kind,
            deleted: false,
          },
        }
      : undefined;

    if (readyDrafts.length > 0) {
      const attachments = readyDrafts.map((d) => d.attachment!);
      const attachmentIds = attachments.map((a) => a.id);
      const localAttachmentUrls: ComposerSendAttachments["localAttachmentUrls"] = {};
      const preserve = new Set<string>();
      for (const draft of readyDrafts) {
        if (draft.previewUrl) {
          localAttachmentUrls[draft.attachment!.id] = draft.previewUrl;
          preserve.add(draft.previewUrl);
        }
      }
      services.sendMessage(
        channel.id,
        text,
        { attachmentIds, attachments, localAttachmentUrls },
        reply,
      );
      clearDrafts(preserve);
    } else {
      services.sendMessage(channel.id, text, undefined, reply);
    }

    if (reply) services.clearReplyTarget(channel.id);
    // Sent — drop this channel's draft (M17) and cancel any pending debounced write.
    services.clearDraft(channel.id);
    setValue("");
    setPendingMentions([]);
    setMention(null);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  }, [value, pendingMentions, hasPending, drafts, services, channel.id, clearDrafts]);

  const showDropOverlay = dragging && !attachmentsDisabled && sendBlock === null;
  const remaining = MESSAGE_MAX_LENGTH - value.length;
  const showCounter = sendBlock === null && remaining <= COUNTER_THRESHOLD;
  const activeOptionId = mentionOpen ? `${listboxId}-opt-${mentionIndex}` : undefined;

  return (
    <div className="relative shrink-0 px-4 pb-5 pt-2">
      {mentionOpen && (
        // Strong glass over the thread, borderless (Koyu Masa menu recipe):
        // highlighted row = the raised tone, exactly like a dropdown menu row.
        <div className="absolute bottom-full left-4 right-4 z-20 mb-2 overflow-hidden rounded-xl surface-glass-strong p-1 animate-pop-in-fast">
          <p
            id={`${listboxId}-heading`}
            className="px-2.5 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint"
          >
            {t("desktop:composer.mentionHeading")}
          </p>
          <ul
            id={listboxId}
            className="max-h-56 overflow-y-auto"
            role="listbox"
            aria-labelledby={`${listboxId}-heading`}
          >
            {suggestions.map((candidate, i) => (
              <li
                key={candidate.id}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === mentionIndex}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  // mousedown (not click) fires before the textarea blurs, so the
                  // pick lands without the picker closing from a lost focus first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(candidate);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={cn(
                    // Safari 12: no flex `gap` → `space-x-2.5` for the avatar/label gutter.
                    "flex w-full cursor-pointer items-center space-x-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm",
                    "transition-colors motion-hover",
                    i === mentionIndex ? "bg-raised text-fg" : "text-fg-muted",
                  )}
                >
                  {candidate.broadcast ? (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-surface text-xs font-semibold text-accent-hover">
                      @
                    </span>
                  ) : (
                    <UserAvatar
                      name={candidate.label}
                      colorSeed={candidate.id}
                      src={candidate.avatarUrl ?? null}
                      size="xs"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {candidate.broadcast ? `@${candidate.label}` : candidate.label}
                  </span>
                  {candidate.broadcast ? (
                    <span className="shrink-0 text-2xs text-fg-faint">
                      {candidate.id === "everyone"
                        ? t("desktop:composer.mentionEveryoneHint")
                        : t("desktop:composer.mentionHereHint")}
                    </span>
                  ) : candidate.username ? (
                    <span className="shrink-0 truncate text-2xs text-fg-faint">
                      @{candidate.username}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <SlowmodeCountdown channelId={channel.id} />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={services.attachmentAccept}
        className="hidden"
        onChange={(event) => {
          pickFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <div
        className={cn(
          // Koyu Masa field recipe at composer scale: borderless, the surface tone
          // at rest, a half step up on hover, the raised tone + a faint coral
          // inner trace while focused. The reply bar and the attachment strip
          // live INSIDE this frame, so the whole box changes tone as one.
          "relative rounded-xl bg-surface px-2 transition-[background-color,box-shadow] motion-hover",
          // Hover lifts only a RESTING field: once focused the raised tone must
          // win, or the pointer that just clicked in would hold it half-lit.
          sendBlock === null && "[&:hover:not(:focus-within)]:bg-raised/60",
          "focus-within:bg-raised focus-within:shadow-[inset_0_0_0_1px_var(--color-accent-glow)]",
        )}
        onDragEnter={(event) => {
          if (attachmentsDisabled || sendBlock) return;
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            dragDepth.current += 1;
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          if (
            !attachmentsDisabled &&
            !sendBlock &&
            Array.from(event.dataTransfer.types).includes("Files")
          ) {
            event.preventDefault();
          }
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setDragging(false);
          if (attachmentsDisabled || sendBlock) return;
          if (event.dataTransfer.files.length > 0) {
            event.preventDefault();
            pickFiles(event.dataTransfer.files);
          }
        }}
      >
        {replyTarget && sendBlock === null && (
          // Safari 12: no flex `gap` → `space-x-2` reproduces the banner gutter.
          <div className="flex items-center space-x-2 px-2 pb-0.5 pt-2.5 text-xs animate-fade-in">
            <CornerUpRight className="size-3.5 shrink-0 text-accent" aria-hidden />
            {/*
             * Name AND the quoted text. The bar used to say only "X kişisine yanıt
             * veriliyor", which does not answer the question the bar exists to
             * answer: WHICH message. In a fast channel you reply, get distracted,
             * come back, and the composer cannot tell you what you were replying to
             * — you have to cancel and start over. The quote line above a sent
             * reply (MessageRow's ReplyQuote) already shows name + content, so this
             * matches the shape the user has been reading all along.
             *
             * `content` is rendered as PLAIN TEXT on purpose: no markdown, no
             * mention resolution. A preview is a reminder, not a second rendering
             * surface, and running markdown here would let a quoted message paint
             * into the composer chrome.
             */}
            <span className="shrink-0 font-semibold text-fg">
              {replyAuthorName ?? t("desktop:chat.unknownUser")}
            </span>
            <span className="min-w-0 truncate text-fg-faint">
              {replyPreviewText(replyTarget.content, t("desktop:search.attachmentOnly"))}
            </span>
            <button
              type="button"
              onClick={cancelReply}
              aria-label={t("desktop:composer.cancelReply")}
              // `!ml-auto` (not `ml-auto`): the sibling `space-x-2` margin would
              // otherwise override the auto margin and lose the right-alignment
              // (the Safari-12 space-x/ml-auto trap, same as the ChatView header).
              className="!ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-faint transition-colors motion-hover hover:bg-wash hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )}

        {hasDrafts && sendBlock === null && (
          <div className="px-1 pt-2">
            {services.renderAttachmentPreview({ drafts, onRemove: removeDraft, onRetry: retryDraft })}
          </div>
        )}

        {sendBlock ? (
          // Known-before-send refusal. Says what is true (YOU blocked them — the
          // other direction is never revealed), and offers the one action that
          // changes it, instead of a textarea whose every send would bounce.
          <div
            role="status"
            className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2"
          >
            <Ban className="size-4 shrink-0 text-fg-faint" aria-hidden />
            <p className="min-w-0 flex-1 text-sm text-fg-muted">
              {t("desktop:composer.blockedNotice", { name: sendBlock.name })}
            </p>
            <Button variant="secondary" size="sm" onClick={sendBlock.unblock}>
              {t("desktop:composer.unblock")}
            </Button>
          </div>
        ) : (
          /*
            The three controls each sit in an equal-height `h-11` box; with the row
            on `items-end` they line up on ONE vertical axis on a single line, and
            when the textarea grows the two icon boxes stay pinned to the last line.
            No per-icon "magic margin" — the shared box height is the single knob.
            Safari 12: no flex `gap` → `space-x-1` for the attach/textarea/emoji gutter.
          */
          <div className="flex items-end space-x-1">
            {showAttachmentButton && (
              <div className="flex h-11 shrink-0 items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Wrapper span keeps the tooltip working when the button is disabled. */}
                    <span className="inline-flex">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("desktop:composer.attachFiles")}
                        disabled={attachDisabled}
                        className="text-fg-faint"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Paperclip className="size-5" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{attachTooltip}</TooltipContent>
                </Tooltip>
              </div>
            )}

            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              maxLength={MESSAGE_MAX_LENGTH}
              aria-autocomplete="list"
              aria-controls={mentionOpen ? listboxId : undefined}
              aria-activedescendant={activeOptionId}
              onChange={(event) => {
                const next = event.target.value;
                setValue(next);
                resize();
                // Debounced persist (store-side) — no storage write per keystroke (§27).
                services.setDraft(channel.id, next);
                refreshMention(next, event.target.selectionStart ?? next.length);
                if (next.trim().length > 0) services.notifyTyping(channel.id);
                else services.notifyIdle(channel.id);
              }}
              onKeyUp={(event) => {
                // Arrow/click caret moves (no value change) can enter or leave an
                // @fragment — re-evaluate unless we are navigating the open picker.
                if (mentionOpen) return;
                const el = event.currentTarget;
                refreshMention(el.value, el.selectionStart ?? el.value.length);
              }}
              onClick={(event) => {
                const el = event.currentTarget;
                refreshMention(el.value, el.selectionStart ?? el.value.length);
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length > 0 && !attachmentsDisabled) {
                  event.preventDefault();
                  pickFiles(files);
                }
              }}
              onKeyDown={(event) => {
                // The mention picker takes priority over send/reply while open.
                if (mentionOpen) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((i) => (i + 1) % suggestions.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const chosen = suggestions[mentionIndex] ?? suggestions[0];
                    if (chosen) pickMention(chosen);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                // ↑ in an EMPTY composer edits your last message (Discord parity).
                // Only an empty field with nothing attached: with text in it, ↑ is
                // caret movement and must stay that. The key is swallowed only when
                // the thread actually had a message to open.
                if (
                  event.key === "ArrowUp" &&
                  value === "" &&
                  !hasDrafts &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  requestEditLastMessage(channel.id)
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                } else if (event.key === "Escape" && replyTarget) {
                  event.preventDefault();
                  cancelReply();
                }
              }}
              placeholder={t("desktop:composer.placeholder", { channel: channel.name })}
              aria-label={t("desktop:composer.placeholder", { channel: channel.name })}
              className={cn(
                // `min-h-11` + `py-3` make the single-line height exactly h-11 (44px),
                // matching the two icon boxes so `items-end` centres all three on one
                // axis; `max-h-48` (= MAX_HEIGHT_PX) caps the auto-grow. `caret-accent`
                // ties the cursor into the Demli accent.
                "max-h-48 min-h-11 flex-1 resize-none bg-transparent py-3 text-sm leading-5 text-fg caret-accent",
                "placeholder:text-fg-faint focus:outline-none",
              )}
            />

            {/* Inserts a unicode glyph, or a `:name:` shortcode for a group emoji
                (the renderer resolves the shortcode back into an image, so the
                message itself stays plain text — §28). The h-11 box wraps the whole
                picker (the Button stays the direct PopoverTrigger — no nested
                interactive) so the emoji icon shares the attach button's axis. */}
            <div className="flex h-11 shrink-0 items-center">
              {services.renderEmojiPicker({
                onSelect: insertEmoji,
                align: "end",
                side: "top",
                children: (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("desktop:composer.addEmoji")}
                    className="text-fg-faint data-[state=open]:bg-wash data-[state=open]:text-fg"
                  >
                    <SmilePlus className="size-5" />
                  </Button>
                ),
              })}
            </div>
          </div>
        )}

        {showDropOverlay && (
          // Safari 12: no flex `gap` → `space-x-2` (text wrapped so it's an element).
          // The dashed coral edge is a FUNCTIONAL line (the drop target), the one
          // place a frame is allowed on this surface.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center space-x-2 rounded-xl border-2 border-dashed border-accent surface-glass-strong text-sm font-medium text-accent animate-fade-in">
            <ImageUp className="size-5" aria-hidden />
            <span>{t("desktop:composer.dropToAttach")}</span>
          </div>
        )}
      </div>

      {(slowmodeSeconds > 0 || showCounter) && (
        <div className="mt-1.5 flex items-center px-1 text-2xs">
          {slowmodeSeconds > 0 && (
            // Safari 12: no flex `gap` → `space-x-1.5` (text wrapped so it's an element).
            <p className="flex min-w-0 items-center space-x-1.5 text-fg-faint">
              <Clock className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {t("desktop:composer.slowmodeNote", { interval: formatDuration(slowmodeSeconds) })}
              </span>
            </p>
          )}
          {showCounter && (
            <p
              aria-live="polite"
              className={cn(
                "ml-auto shrink-0 pl-3 font-medium tabular-nums",
                remaining <= 0 ? "text-danger" : "text-fg-faint",
              )}
            >
              {t("desktop:composer.charsLeft", { count: Math.max(0, remaining) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
