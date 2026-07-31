import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Button, Input, UserAvatar, cn } from "@demli/ui";
import { ApiClientError } from "@demli/client-core";
import type { Channel, Message } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { MESSAGE_SEARCH_MIN_CHARS, useChannelSearch } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { requestMessageJump } from "../lib/message-jump";
import {
  searchCursorDown,
  searchCursorTarget,
  searchCursorUp,
  type SearchCursorInput,
} from "../lib/search-cursor";
import { formatMessageTimestamp } from "../lib/time";

/** Debounce for the search input — one request per typing pause (§27). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Split `content` around case-insensitive occurrences of `query`, wrapping the
 * hits in a subtle highlight. Pure text in/out — React escapes every segment, so
 * this stays safe against message content (§28). A blank query returns the text
 * untouched.
 */
function highlightQuery(content: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return content;
  const lower = content.toLowerCase();
  const target = needle.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match = lower.indexOf(target, cursor);
  if (match === -1) return content;
  let key = 0;
  while (match !== -1) {
    if (match > cursor) nodes.push(<Fragment key={key++}>{content.slice(cursor, match)}</Fragment>);
    nodes.push(
      <mark key={key++} className="rounded-sm bg-accent/25 text-fg">
        {content.slice(match, match + needle.length)}
      </mark>,
    );
    cursor = match + needle.length;
    match = lower.indexOf(target, cursor);
  }
  if (cursor < content.length) nodes.push(<Fragment key={key++}>{content.slice(cursor)}</Fragment>);
  return nodes;
}

function SearchResultRow({
  message,
  query,
  active,
  onJump,
  onHover,
}: {
  message: Message;
  query: string;
  /** Keyboard cursor is on this row — mirrors hover, and drives scroll-into-view. */
  active: boolean;
  onJump: () => void;
  onHover: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const author = useChatStore((s) => s.users[message.authorId]);
  const name = author?.displayName ?? t("desktop:chat.unknownUser");
  const ref = useRef<HTMLLIElement | null>(null);

  // Follow the keyboard cursor. `nearest` so arrowing within view does not
  // yank the list around — it only scrolls when the row is actually off-panel.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // A hit can be an attachment-only message (empty content); show a placeholder
  // so the row still reads as a real, tappable result.
  const body = message.content?.trim() ?? "";
  const hasBody = body.length > 0;

  return (
    // Result rows are variable-height and this list is not virtualized — skip
    // paint/layout for the ones scrolled out of the panel (§27).
    <li ref={ref} className="content-visibility-auto">
      <button
        type="button"
        // Clicking a result GOES TO the message, the same action the pin board's
        // rows perform, rather than expanding it inside a 340px panel. The full
        // message in its own conversation, with the messages around it, is the
        // context a search result is actually asking for.
        onClick={onJump}
        onMouseEnter={onHover}
        // The roving cursor lives on the list; rows are not tab stops, so
        // Arrow/Enter drive the whole result set from the search field.
        tabIndex={-1}
        data-active={active || undefined}
        className={cn(
          "flex w-full gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
          "hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          active && "bg-white/[0.06]",
        )}
      >
        <UserAvatar
          name={name}
          colorSeed={message.authorId}
          src={author?.avatarUrl ?? null}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{name}</span>
            <span className="shrink-0 text-2xs text-fg-faint">
              {formatMessageTimestamp(message.createdAt, t)}
            </span>
          </div>
          {hasBody ? (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-fg-muted">
              {highlightQuery(body, query)}
            </p>
          ) : (
            <p className="mt-0.5 text-[13px] italic text-fg-faint">
              {t("desktop:search.attachmentOnly")}
            </p>
          )}
        </div>
      </button>
    </li>
  );
}

/**
 * Message search panel (ADR 0011 §5). Opens on the right of the
 * conversation — a server channel, a DM or a group DM, all of which are the same
 * channel-scoped pipeline underneath, so one panel serves all three.
 *
 * Debounces the input, gates on the 3-char minimum the API enforces, and
 * keyset-pages older matches with a "load more" button.
 *
 * Choosing a result JUMPS to the message in the conversation, through the same
 * `requestMessageJump` seam the pin board uses: the list walks back through older
 * pages until it finds the target, then scrolls and flashes it. That is bounded
 * (`JUMP_MAX_PAGE_LOADS`), so a hit from far enough back may not be reachable —
 * the same limit the pin board already lives with, and the reason the row keeps
 * showing the matched text itself rather than relying on the jump to deliver it.
 *
 * The whole result set is driven from the search FIELD: ArrowUp/ArrowDown move a
 * roving cursor, Enter jumps to it, Escape closes. The rows are deliberately not
 * tab stops — tabbing through fifty results to reach the one you can already see
 * is not navigation.
 */
export function ChannelSearchPanel({
  channel,
  /**
   * What the placeholder calls this conversation. Server channels read as
   * `#general`; a DM has no channel name a person would recognise (its stream is
   * a uuid-named hidden channel), so those surfaces pass the other participant's
   * name instead.
   */
  label,
}: {
  channel: Channel;
  label?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  // Select only the setter so the panel never rerenders on unrelated ui state.
  const setChannelSearchOpen = useUiStore((s) => s.setChannelSearchOpen);

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the raw input into the query the hook actually runs (§27).
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(input), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [input]);

  // Focus the field as soon as the panel mounts (opened via icon, Ctrl+F, or
  // the command menu), and reset scroll/query state on channel switch.
  useEffect(() => {
    inputRef.current?.focus();
  }, [channel.id]);

  const trimmed = debounced.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MESSAGE_SEARCH_MIN_CHARS;
  const active = trimmed.length >= MESSAGE_SEARCH_MIN_CHARS;

  const {
    data,
    error,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useChannelSearch(active ? channel.id : null, trimmed);

  const results = useMemo(
    () => data?.pages.flatMap((page) => page.messages) ?? [],
    [data],
  );

  // A new query is a new result set — never leave the cursor pointing at the
  // row that happened to sit at that index for the previous search.
  useEffect(() => {
    setCursor(-1);
  }, [trimmed, channel.id]);

  const jumpTo = useCallback((message: Message | undefined): void => {
    if (!message) return;
    requestMessageJump(message.id);
  }, []);

  /**
   * Arrow/Enter driven from the field. ArrowDown past the last loaded result
   * pulls the next page in rather than dead-ending, so keyboard paging matches
   * what the "load more" button does for the mouse.
   */
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setChannelSearchOpen(false);
      return;
    }
    if (results.length === 0) return;

    const input: SearchCursorInput = {
      cursor,
      count: results.length,
      hasNextPage: Boolean(hasNextPage),
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const move = searchCursorDown(input);
      setCursor(move.cursor);
      if (move.loadMore && !isFetchingNextPage) void fetchNextPage();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(searchCursorUp(input).cursor);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const index = searchCursorTarget(input);
      if (index >= 0) jumpTo(results[index]);
    }
  };

  const isRateLimited = error instanceof ApiClientError && error.code === "RATE_LIMITED";
  const showInitialLoading = active && isFetching && results.length === 0 && !error;
  const showEmpty = active && !isFetching && !error && results.length === 0;

  return (
    // Right-anchored panel — hairline + soft lift come from `shadow-panel-left`
    // (see globals.css) instead of a `border-l`, matching the member roster.
    <aside className="flex w-[340px] shrink-0 flex-col bg-app shadow-panel-left">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <Search className="size-4 shrink-0 text-fg-faint" />
        <h2 className="flex-1 truncate text-[13px] font-semibold text-fg">
          {t("desktop:search.title")}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("desktop:search.close")}
          onClick={() => setChannelSearchOpen(false)}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="border-b border-stroke p-3">
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={
            label
              ? t("desktop:search.placeholderIn", { name: label })
              : t("desktop:search.placeholder", { channel: channel.name })
          }
          aria-label={t("desktop:search.title")}
          autoComplete="off"
          spellCheck={false}
        />
        {results.length > 0 && (
          <p className="mt-1.5 text-2xs text-fg-faint">{t("desktop:search.keyboardHint")}</p>
        )}
      </div>

      <div className="edge-fade-y min-h-0 flex-1 overflow-y-auto p-2">
        {!active && !tooShort && (
          <p className="px-2 py-6 text-center text-[13px] text-fg-faint">
            {t("desktop:search.hint", { count: MESSAGE_SEARCH_MIN_CHARS })}
          </p>
        )}

        {tooShort && (
          <p className="px-2 py-6 text-center text-[13px] text-fg-faint">
            {t("desktop:search.tooShort", { count: MESSAGE_SEARCH_MIN_CHARS })}
          </p>
        )}

        {showInitialLoading && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-8 text-[13px] text-fg-muted"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("desktop:search.searching")}
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
            <p className="text-[13px] text-fg-muted">
              {isRateLimited ? t("desktop:search.rateLimited") : t("desktop:search.error")}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {t("buttons.retry")}
            </Button>
          </div>
        )}

        {showEmpty && (
          <p className="px-2 py-8 text-center text-[13px] text-fg-muted">
            {t("desktop:search.noResults", { query: trimmed })}
          </p>
        )}

        {results.length > 0 && (
          <>
            <p className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
              {/* `results.length` counts what is LOADED, not what matched. While
                  another page exists, say so ("20+") instead of reporting a
                  loaded-page count as if it were the total — the API returns no
                  total, and a number that changes every time you press "load
                  more" is worse than an honest lower bound. */}
              {hasNextPage
                ? t("desktop:search.resultCountMore", { count: results.length })
                : t("desktop:search.resultCount", { count: results.length })}
            </p>
            <ul className="flex flex-col">
              {results.map((message, index) => (
                <SearchResultRow
                  key={message.id}
                  message={message}
                  query={trimmed}
                  active={index === cursor}
                  onJump={() => jumpTo(message)}
                  onHover={() => setCursor(index)}
                />
              ))}
            </ul>
            {hasNextPage && (
              <div className="px-2 py-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    t("desktop:search.loadMore")
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
