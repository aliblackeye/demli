import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, m } from "framer-motion";
import { ArrowDown, ArrowUp, CloudOff, Hash, RotateCw, Volume2 } from "lucide-react";
import { Trans, useTranslation } from "@demli/i18n";
import { Button, Skeleton, cn } from "@demli/ui";
import type { Channel } from "@demli/types";
import { useChatData } from "../data/chat-data";
import { onEditLastRequest, requestMessageEdit } from "../data/edit-request";
import { useOptionalMessageRowServices } from "../data/message-row-data";
import { toastPop } from "../motion/presets";
import { IgnoredRunRow } from "./IgnoredRunRow";
import {
  buildRows,
  firstUnreadMessageId,
  localDayStart,
  tailSentinel,
  toggleIgnoredRun,
} from "./messageRows";

/** Within this distance (px) of the bottom we auto-follow new messages. */
const STICK_THRESHOLD_PX = 80;
/** Within this distance (px) of the top we fetch the next (older) page. */
const LOAD_OLDER_THRESHOLD_PX = 120;
/** Older pages a pin/deep-link jump may load while hunting for its target. */
const JUMP_MAX_PAGE_LOADS = 5;
/** Frames the ↑-to-edit hand-off waits for the target row to mount. */
const EDIT_HANDOFF_MAX_FRAMES = 6;
/**
 * A message younger than this plays the "arrival" motion (blur → sharp, lift →
 * settle). Derived from the message's own `createdAt` rather than from React
 * state on purpose: this list is virtualized, so rows mount and unmount
 * constantly while scrolling, and a mount-triggered animation would replay on
 * every row that scrolls back into the window. Freshness is a pure function of
 * the data — history never animates, an optimistic send always does, and after
 * the window closes the class simply stops being applied (§27: no timers, no
 * extra state, no per-row subscriptions).
 */
const ARRIVAL_FRESH_MS = 1200;

/**
 * Rendered height of a folded ignored-author placeholder ({@link IgnoredRunRow}).
 * That row is `h-8` in EVERY state — collapsed, expanded and hovered — so this
 * estimate is exact and the virtualizer never has to correct it.
 */
const IGNORED_RUN_ROW_PX = 32;

/** Rendered height of a {@link DateDivider} (pt-5 + 20px pill + pb-1). */
const DATE_DIVIDER_ROW_PX = 44;

/** Stand-in viewer hook for a surface with no row services (↑-to-edit inert). */
function useNoViewer(): string | undefined {
  return undefined;
}

function ChannelIntro({ channel }: { channel: Channel }): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const Glyph = channel.kind === "voice" ? Volume2 : Hash;
  return (
    <div className="px-4 pb-4 pt-10">
      <div className="flex size-14 items-center justify-center rounded-xl bg-surface">
        <Glyph className="size-7 text-fg-muted" aria-hidden />
      </div>
      <h2 className="mt-4 font-display text-2xl font-semibold tracking-[-0.01em] text-fg-display">
        {t("desktop:chat.introTitle", { channel: channel.name })}
      </h2>
      <p className="mt-1.5 text-sm text-fg-muted">
        <Trans
          t={t}
          i18nKey="desktop:chat.introBody"
          values={{ channel: channel.name }}
          components={{ strong: <span className="font-medium text-fg" /> }}
        />
      </p>
    </div>
  );
}

/**
 * Calendar-day separator: a hairline across the thread with the day as a calm
 * pill in the middle — "Bugün", "Dün", or the full date. The day is resolved at
 * render (the row model only carries local midnight), in the APP language, so a
 * Turkish UI reads "12 Ekim Pazartesi" even on an English OS.
 */
function DateDivider({ dayStart }: { dayStart: number }): JSX.Element {
  const { t, i18n } = useTranslation(["common", "desktop"]);
  const label = useMemo(() => {
    const today = localDayStart(new Date().toISOString());
    // Round, not floor: a DST shift makes one calendar day 23h or 25h long.
    const daysAgo = Math.round((today - dayStart) / 86_400_000);
    if (daysAgo === 0) return t("desktop:chat.dateToday");
    if (daysAgo === 1) return t("desktop:chat.dateYesterday");
    const date = new Date(dayStart);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat(i18n.language, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: sameYear ? undefined : "numeric",
    }).format(date);
  }, [dayStart, i18n.language, t]);

  return (
    <div
      role="separator"
      aria-label={label}
      className="pointer-events-none flex select-none items-center px-4 pb-1 pt-5"
    >
      <div className="h-px flex-1 bg-stroke" />
      <span className="mx-3 flex h-5 items-center rounded-pill bg-surface px-2.5 text-2xs font-medium text-fg-muted">
        {label}
      </span>
      <div className="h-px flex-1 bg-stroke" />
    </div>
  );
}

/**
 * The "new messages start here" line: a coral hairline with a solid coral
 * "YENİ" chip at its right end. Coral is the colour this thread reserves for
 * "this is for you" — the same light as a mention of you and your own
 * reactions — so the line reads as a place to resume, never as an error.
 * Non-interactive; positioned by `buildRows` directly above the first message
 * received since the last visit.
 */
function UnreadDivider(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <div
      className="pointer-events-none flex select-none items-center px-4 py-1"
      role="separator"
      aria-label={t("desktop:chat.newMessagesDivider")}
    >
      <div className="h-px flex-1 bg-accent/50" />
      <span className="ml-2 flex h-4 items-center rounded-pill bg-accent px-1.5 text-badge font-bold uppercase leading-none tracking-wide text-on-accent">
        {t("desktop:chat.newChip")}
      </span>
    </div>
  );
}

/** One placeholder message: a header (avatar + name + body) or a continuation line. */
function SkeletonMessage({
  header,
  body,
  media = false,
}: {
  header: boolean;
  body: string;
  media?: boolean;
}): JSX.Element {
  return (
    <div className={cn("flex px-4", header ? "mt-5" : "mt-1.5")}>
      <div className="w-10 shrink-0">{header && <Skeleton shape="circle" width={40} />}</div>
      <div className="ml-3 min-w-0 flex-1 pt-0.5">
        {header && <Skeleton shape="line" width={112} height={12} />}
        <Skeleton shape="line" height={12} className={cn(header && "mt-2", body)} />
        {media && <Skeleton shape="rect" width={260} height={150} className="mt-2 rounded-xl" />}
      </div>
    </div>
  );
}

function MessageListSkeleton(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <div
      aria-label={t("desktop:chat.loadingMessages")}
      role="status"
      className="flex-1 overflow-hidden pt-4"
    >
      <SkeletonMessage header body="w-3/5" />
      <SkeletonMessage header={false} body="w-2/5" />
      <SkeletonMessage header body="w-4/5" />
      <SkeletonMessage header body="w-1/3" media />
      <SkeletonMessage header body="w-2/3" />
      <SkeletonMessage header={false} body="w-1/2" />
      <span className="sr-only">{t("desktop:chat.loadingMessages")}</span>
    </div>
  );
}

/**
 * The virtualized message thread (CLAUDE.md §7, §27) — shared by every surface
 * (server channel, DM, flat group chat). It owns ONLY the list mechanics:
 * grouping, the unread + date dividers, load-older-on-scroll-up with viewport
 * anchoring, stick-to-bottom / jump-to-present, the pin/deep-link jump, the
 * ↑-to-edit hand-off and the flash highlight. Everything data-shaped (the
 * assembled messages, paging, read marker, error localization, the jump
 * emitter) comes from {@link useChatData}; the mutation-coupled ROW is the
 * surface's `renderMessage` slot.
 */
export function MessageList(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const {
    channel,
    messages,
    hasMore,
    isLoadingMore,
    isPending,
    errorMessage,
    loadMore,
    retry,
    getReadWatermark,
    subscribeJump,
    renderMessage,
    ignoredAuthorIds,
  } = useChatData();
  // Optional: only the ↑-to-edit hand-off needs the viewer's id.
  // The hook is picked once per provider (a provider is mounted for the list's
  // whole life), so the same hook runs on every render either way.
  const rowServices = useOptionalMessageRowServices();
  const useViewerId = rowServices?.useCurrentUserId ?? useNoViewer;
  const currentUserId = useViewerId();

  /**
   * Runs the viewer chose to reveal, keyed by the run's first message id (ADR
   * 0019 §4). Component state, not a store: the list is keyed by channel id, so
   * a channel switch remounts it and every run folds back — an ignore is about
   * "not right now", so a reveal is a per-visit act, not a stored preference.
   */
  const [expandedIgnoredRuns, setExpandedIgnoredRuns] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const onToggleIgnoredRun = useCallback((runId: string) => {
    setExpandedIgnoredRuns((current) => toggleIgnoredRun(current, runId));
  }, []);

  // Compute the divider anchor ONCE, the first render messages are available, and
  // hold it for this mount (the list is keyed by channel id, so a fresh mount ==
  // a fresh channel open). The watermark is read imperatively via getReadWatermark
  // at that instant — before the surface's advance effect bumps it — so the marker
  // never resubscribes/rerenders the list (§27), and freezing here keeps the
  // divider from sliding down as new messages stream in while you read.
  const anchorRef = useRef<{ computed: boolean; id: string | null }>({
    computed: false,
    id: null,
  });
  // Wait for the FIRST PAGE, not merely for any message: the persistent outbox
  // (M17) is in the list before the server page lands, and anchoring on a list
  // of only queued sends froze the divider at "none" for that whole visit.
  if (!anchorRef.current.computed && !isPending && messages.length > 0) {
    anchorRef.current = {
      computed: true,
      id: firstUnreadMessageId(
        messages.map((m) => m.id),
        getReadWatermark(),
      ),
    };
  }
  const dividerBeforeId = anchorRef.current.id;

  const rows = useMemo(
    () =>
      buildRows(messages, {
        atChannelStart: !hasMore,
        loadingOlder: isLoadingMore,
        dividerBeforeId,
        ignoredAuthorIds,
        expandedIgnoredRuns,
        dateDividers: true,
      }),
    [messages, hasMore, isLoadingMore, dividerBeforeId, ignoredAuthorIds, expandedIgnoredRuns],
  );

  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row || row.kind === "intro") return 150;
      if (row.kind === "older-loading") return 112;
      if (row.kind === "unread-divider") return 24;
      if (row.kind === "date-divider") return DATE_DIVIDER_ROW_PX;
      // Exact, not an estimate — the fold is a fixed-height bar in every state,
      // so toggling it never re-measures this row (only inserts/removes rows
      // after it).
      if (row.kind === "ignored-run") return IGNORED_RUN_ROW_PX;
      if (row.message.kind === "system") return 30;
      let base = row.isContinuation ? 26 : 54;
      // Reserve rough space for the enrichment rows so the initial estimate stays
      // close (measureElement corrects it; reserving prevents a scroll jump, §27).
      if (row.message.replyTo) base += 22; // quote line above the content
      if (row.message.reactions && row.message.reactions.length > 0) base += 34; // pill row
      // Reserve rough space for attachment tiles so the initial estimate is
      // close (measureElement corrects it; the reserved boxes prevent reflow).
      const attachments = row.message.attachments?.length ?? 0;
      return base + (attachments > 0 ? 240 : 0);
    },
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  // Stable jump handler: read the latest rows via a ref so the callback identity
  // never changes (keeps the row memoization intact). Scrolls the quoted message
  // into view and flashes it briefly; a no-op if it isn't loaded yet.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const index = rowsRef.current.findIndex(
        (row) => row.kind === "message" && row.message.id === messageId,
      );
      if (index < 0) return;
      virtualizer.scrollToIndex(index, { align: "center" });
      setHighlightId(messageId);
      window.setTimeout(
        () => setHighlightId((current) => (current === messageId ? null : current)),
        1600,
      );
    },
    [virtualizer],
  );

  /**
   * External jump requests (the pin panel today; search / deep links later) come
   * in through the chat-data seam. Unlike a reply quote — whose target is almost
   * always on a loaded page — a pinned message is usually FAR up the scrollback,
   * so this walks older pages until it finds the target. Bounded on purpose:
   * paging forever into a huge channel would be a render storm (§27); after the
   * cap we simply give up, and the user still sees the message's content in the
   * pin panel itself.
   */
  const pagingRef = useRef({ hasMore, loadMore });
  pagingRef.current = { hasMore, loadMore };
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeJump((messageId) => {
      void (async () => {
        for (let attempt = 0; attempt <= JUMP_MAX_PAGE_LOADS; attempt++) {
          if (cancelled) return;
          const found = rowsRef.current.some(
            (row) => row.kind === "message" && row.message.id === messageId,
          );
          if (found) {
            jumpToMessage(messageId);
            return;
          }
          if (!pagingRef.current.hasMore) return;
          await pagingRef.current.loadMore();
        }
      })();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [jumpToMessage, subscribeJump]);

  /**
   * ↑ in an empty composer → edit the viewer's newest message (Discord parity).
   * The composer cannot see rows, and the row it wants may be outside the
   * virtual window, so the list finds it, scrolls it in, then hands the open
   * command to the row once it has mounted (a few frames at most).
   */
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  useEffect(
    () =>
      onEditLastRequest((channelId) => {
        if (channelId !== channel.id) return false;
        const me = currentUserIdRef.current;
        if (!me) return false;
        const list = rowsRef.current;
        let index = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          const row = list[i];
          if (
            row?.kind === "message" &&
            row.message.authorId === me &&
            row.message.kind !== "system" &&
            row.message.deliveryState === "sent" &&
            row.message.content.length > 0
          ) {
            index = i;
            break;
          }
        }
        const target = list[index];
        if (!target || target.kind !== "message") return false;
        const messageId = target.message.id;
        virtualizer.scrollToIndex(index, { align: "auto" });
        let frames = 0;
        const handOff = (): void => {
          if (requestMessageEdit(messageId) || ++frames > EDIT_HANDOFF_MAX_FRAMES) return;
          requestAnimationFrame(handOff);
        };
        requestAnimationFrame(handOff);
        return true;
      }),
    [channel.id, virtualizer],
  );

  // Optional affordance: scroll up to the "New Messages" divider (where the user
  // left off). Safe in the virtualized list — scrollToIndex is the same primitive
  // the reply-jump uses. Reads rows via the ref so its identity stays stable.
  const jumpToUnread = useCallback(() => {
    const index = rowsRef.current.findIndex((row) => row.kind === "unread-divider");
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
  }, [virtualizer]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Second pass after dynamic measurements settle.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    stickToBottomRef.current = true;
    setJumpVisible(false);
    setAtBottom(true);
  }, []);

  const loaded = !isPending && errorMessage === null;
  // NOT simply the last row's key — see `tailSentinel`: revealing a fold, and a
  // new message from an ignored author, must both leave this unchanged.
  const lastRowKey = tailSentinel(rows);

  // Follow the conversation while pinned to the bottom; otherwise surface a
  // "jump to present" affordance instead of yanking the scroll position.
  //
  // NOTE: this effect is NOT the only reason the button shows — see the render.
  // It used to be, and that was the bug: `jumpVisible` only flipped true when a
  // NEW message arrived while the user was scrolled up. Scroll up in a quiet
  // channel and there was no way back down but dragging the scrollbar, which is
  // exactly what a virtualized list makes hard to aim.
  useEffect(() => {
    if (!loaded) return;
    if (stickToBottomRef.current) {
      scrollToBottom();
    } else {
      setJumpVisible(true);
    }
  }, [loaded, lastRowKey, scrollToBottom]);

  const loadOlder = useCallback(() => {
    const el = parentRef.current;
    if (!el || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    const previousHeight = el.scrollHeight;
    const previousTop = el.scrollTop;
    void loadMore().finally(() => {
      // Keep the viewport anchored on the same messages after the prepend.
      requestAnimationFrame(() => {
        const node = parentRef.current;
        if (node) node.scrollTop = previousTop + (node.scrollHeight - previousHeight);
        loadingOlderRef.current = false;
      });
    });
  }, [loadMore]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_THRESHOLD_PX;
    if (stickToBottomRef.current) setJumpVisible(false);
    setAtBottom((prev) => (prev === stickToBottomRef.current ? prev : stickToBottomRef.current));
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !isLoadingMore) {
      loadOlder();
    }
  }, [hasMore, isLoadingMore, loadOlder]);

  if (isPending) return <MessageListSkeleton />;

  if (errorMessage !== null) {
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center px-6 text-center animate-fade-in"
      >
        <div className="flex size-12 items-center justify-center rounded-xl bg-surface">
          <CloudOff className="size-6 text-fg-muted" aria-hidden />
        </div>
        <p className="mt-4 font-display text-base font-semibold text-fg">
          {t("desktop:chat.loadFailedTitle")}
        </p>
        <p className="mt-1 max-w-sm text-sm text-fg-muted">{errorMessage}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => retry()}>
          <RotateCw className="size-3.5" aria-hidden />
          {t("buttons.retry")}
        </Button>
      </div>
    );
  }

  // "Jump to new messages" pill: only when a divider exists, the user is parked
  // at the bottom, AND the divider is scrolled out of the rendered window above
  // (i.e. the unread block is longer than a screen). For a small unread run the
  // divider is already on screen, so the pill would be redundant — keep it hidden.
  const dividerRowIndex = dividerBeforeId
    ? rows.findIndex((row) => row.kind === "unread-divider")
    : -1;
  const dividerRendered =
    dividerRowIndex >= 0 &&
    virtualizer.getVirtualItems().some((item) => item.index === dividerRowIndex);
  const showUnreadJump = dividerRowIndex >= 0 && !dividerRendered && atBottom;
  // Scrolled away from the newest message is enough on its own — a new message
  // arriving is a reason to OFFER the jump, not the only one. `atBottom` already
  // tracks this on every scroll with the same STICK_THRESHOLD_PX the auto-follow
  // uses, so the button appears exactly when auto-follow has let go.
  const showPresentJump = jumpVisible || !atBottom;

  return (
    <div className="relative min-h-0 flex-1">
      {/*
       * Scroll viewport fills the relative parent via absolute inset-0 rather than
       * h-full (percentage height). The virtualizer's sizer is an explicit-height,
       * absolutely-positioned block; with a percentage-height (h-full) viewport the
       * height fails to resolve through the ChatView row/column nesting, collapses
       * to the sizer's full content height, and pushes the composer off-screen with
       * no scroll (P0 regression). Absolute positioning keeps the viewport out of
       * flow so it neither depends on percentage resolution nor leaks the sizer
       * height up the flex chain.
       *
       * Focusable (tabIndex 0) so a keyboard user can scroll the thread with the
       * arrow / Page keys — a scroll region with no focus stop is a WCAG 2.1.1
       * gap. The ring is inset and keyboard-only.
       */}
      <div
        ref={parentRef}
        onScroll={handleScroll}
        tabIndex={0}
        aria-label={t("desktop:chat.listLabel", { channel: channel.name })}
        className="absolute inset-0 overflow-y-auto pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        {/* A thread shorter than the viewport sits on the composer, not under
            the header (a conversation grows upward). `justify-end` only acts
            while the content is shorter than the viewport — once it overflows,
            `min-h-full` equals the content and the virtualizer's offsets are
            untouched. */}
        <div className="flex min-h-full flex-col justify-end">
        <div
          className="relative w-full shrink-0"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "intro" ? (
                  <ChannelIntro channel={channel} />
                ) : row.kind === "older-loading" ? (
                  <div role="status" aria-label={t("desktop:chat.loadingOlder")} className="pb-2">
                    <SkeletonMessage header body="w-1/2" />
                    <SkeletonMessage header body="w-2/3" />
                  </div>
                ) : row.kind === "unread-divider" ? (
                  <UnreadDivider />
                ) : row.kind === "date-divider" ? (
                  <DateDivider dayStart={row.dayStart} />
                ) : row.kind === "ignored-run" ? (
                  <IgnoredRunRow
                    count={row.count}
                    authorCount={row.authorCount}
                    expanded={row.expanded}
                    onToggle={() => onToggleIgnoredRun(row.runId)}
                  />
                ) : (
                  renderMessage({
                    message: row.message,
                    isContinuation: row.isContinuation,
                    isHighlighted: row.message.id === highlightId,
                    isArriving: Date.now() - Date.parse(row.message.createdAt) < ARRIVAL_FRESH_MS,
                    onJumpToMessage: jumpToMessage,
                  })
                )}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      <AnimatePresence>
        {showUnreadJump && (
          <m.button
            key="jump-unread"
            type="button"
            onClick={jumpToUnread}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "absolute left-1/2 top-3 z-10 flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-pill px-3.5",
              "bg-accent text-xs font-semibold text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-app",
            )}
          >
            <ArrowUp className="size-3.5" aria-hidden />
            {t("desktop:chat.jumpToNew")}
          </m.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPresentJump && (
          <m.button
            key="jump-present"
            type="button"
            onClick={scrollToBottom}
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
              "absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-pill px-3.5",
              "surface-glass-strong text-xs font-medium text-fg hover:bg-raised active:bg-raised-pressed",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {t("desktop:chat.jumpToPresent")}
          </m.button>
        )}
      </AnimatePresence>
    </div>
  );
}
