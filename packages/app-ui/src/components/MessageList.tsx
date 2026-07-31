import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Hash, Loader2 } from "lucide-react";
import { Trans, useTranslation } from "@demli/i18n";
import { Button, cn } from "@demli/ui";
import type { Channel } from "@demli/types";
import { useChatData } from "../data/chat-data";
import { IgnoredRunRow } from "./IgnoredRunRow";
import { buildRows, firstUnreadMessageId, tailSentinel, toggleIgnoredRun } from "./messageRows";

/** Within this distance (px) of the bottom we auto-follow new messages. */
const STICK_THRESHOLD_PX = 80;
/** Within this distance (px) of the top we fetch the next (older) page. */
const LOAD_OLDER_THRESHOLD_PX = 120;
/** Older pages a pin/deep-link jump may load while hunting for its target. */
const JUMP_MAX_PAGE_LOADS = 5;
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

function ChannelIntro({ channel }: { channel: Channel }): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <div className="px-4 pb-3 pt-8">
      <div className="flex size-14 items-center justify-center rounded-full bg-raised">
        <Hash className="size-7 text-fg-muted" />
      </div>
      <h2 className="mt-3 text-xl font-bold text-fg">
        {t("desktop:chat.introTitle", { channel: channel.name })}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
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
 * The "New Messages" separator: a thin accent hairline across the
 * thread with a small label on the right. Non-interactive; positioned by
 * `buildRows` directly above the first message received since the last visit.
 */
function UnreadDivider(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  return (
    <div
      // Safari 12 has no flex `gap`; `space-x-2` reproduces the gutter while the
      // flex row is kept so the two hairlines still `flex-1`-stretch to the edges.
      className="pointer-events-none flex select-none items-center space-x-2 px-4 py-1"
      role="separator"
      aria-label={t("desktop:chat.newMessagesDivider")}
    >
      {/* UI overhaul spec: unread divider is ACCENT, not danger — red reads as
          error; blurple reads as "resume here" (mockup: Okunmamış mesajlar). */}
      <div className="h-px flex-1 bg-accent/70" />
      <span className="text-badge font-bold uppercase tracking-wide text-accent-hover">
        {t("desktop:chat.newMessages")}
      </span>
      <div className="h-px flex-1 bg-accent/70" />
    </div>
  );
}

function MessageListSkeleton(): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const widths = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-2/3", "w-1/3"];
  return (
    <div
      aria-label={t("desktop:chat.loadingMessages")}
      role="status"
      className="flex-1 overflow-hidden px-4 pt-6"
    >
      {widths.map((width, index) => (
        // Safari 12: no flex `gap` → `space-x-3` reproduces the avatar/text gutter.
        <div key={index} className="mt-5 flex animate-pulse space-x-3">
          <div className="size-9 shrink-0 rounded-full bg-raised" />
          <div className="flex-1 pt-0.5">
            <div className="h-3.5 w-28 rounded bg-raised" />
            <div className={cn("mt-2 h-3.5 rounded bg-raised/70", width)} />
          </div>
        </div>
      ))}
      <span className="sr-only">{t("desktop:chat.loadingMessages")}</span>
    </div>
  );
}

/**
 * The virtualized message thread (CLAUDE.md §7, §27) — shared by every surface
 * (server channel, DM, flat group chat). It owns ONLY the list mechanics:
 * grouping, the unread divider, load-older-on-scroll-up with viewport anchoring,
 * stick-to-bottom / jump-to-present, the pin/deep-link jump, and the flash
 * highlight. Everything data-shaped (the assembled messages, paging, read
 * marker, error localization, the jump emitter) comes from {@link useChatData};
 * the mutation-coupled ROW is the surface's `renderMessage` slot.
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
  if (!anchorRef.current.computed && messages.length > 0) {
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
      if (!row || row.kind === "intro") return 140;
      if (row.kind === "older-loading") return 36;
      if (row.kind === "unread-divider") return 28;
      // Exact, not an estimate — the fold is a fixed-height bar in every state,
      // so toggling it never re-measures this row (only inserts/removes rows
      // after it).
      if (row.kind === "ignored-run") return IGNORED_RUN_ROW_PX;
      if (row.message.kind === "system") return 30;
      let base = row.isContinuation ? 26 : 54;
      // Reserve rough space for the enrichment rows so the initial estimate stays
      // close (measureElement corrects it; reserving prevents a scroll jump, §27).
      if (row.message.replyTo) base += 20; // quote line above the content
      if (row.message.reactions && row.message.reactions.length > 0) base += 28; // pill row
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
      <div className="flex flex-1 flex-col items-center justify-center space-y-3 px-4">
        <p className="text-sm text-fg-muted">{errorMessage}</p>
        <Button variant="secondary" size="sm" onClick={() => retry()}>
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
       */}
      <div ref={parentRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto">
        <div
          className="relative w-full"
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
                  <div
                    role="status"
                    // Safari 12: no flex `gap` → `space-x-2` keeps the spinner/text gutter.
                    className="flex items-center justify-center space-x-2 py-2 text-xs text-fg-faint"
                  >
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("desktop:chat.loadingOlder")}
                  </div>
                ) : row.kind === "unread-divider" ? (
                  <UnreadDivider />
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

      {showUnreadJump && (
        <button
          type="button"
          onClick={jumpToUnread}
          className={cn(
            // Safari 12: no flex `gap` → `space-x-1.5` for the icon/label gutter.
            "absolute left-1/2 top-3 z-10 flex -translate-x-1/2 cursor-pointer items-center space-x-1.5",
            "rounded-full border border-danger/40 bg-danger/15 px-3 py-1.5",
            "text-xs font-medium text-danger shadow-lg transition-colors hover:bg-danger/25",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/70",
          )}
        >
          <ArrowUp className="size-3.5" />
          {t("desktop:chat.jumpToNew")}
        </button>
      )}

      {/* Scrolled away from the newest message is enough on its own — a new
          message arriving is a reason to OFFER the jump, not the only one.
          `atBottom` already tracks this on every scroll with the same
          STICK_THRESHOLD_PX the auto-follow uses, so the button appears exactly
          when auto-follow has let go. */}
      {(jumpVisible || !atBottom) && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            // Safari 12: no flex `gap` → `space-x-1.5` for the icon/label gutter.
            "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center space-x-1.5",
            "rounded-full border border-stroke-strong bg-overlay px-3 py-1.5",
            "text-xs font-medium text-fg shadow-lg transition-colors hover:bg-raised",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          <ArrowDown className="size-3.5" />
          {t("desktop:chat.jumpToPresent")}
        </button>
      )}
    </div>
  );
}
