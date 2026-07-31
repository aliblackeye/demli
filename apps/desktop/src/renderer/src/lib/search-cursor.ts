/**
 * The roving-cursor rule for the message-search result list.
 *
 * Pure, and separate from the panel, for the reason the desktop test config
 * states: the renderer has no DOM harness, so the behaviour worth pinning has to
 * be expressible without rendering. Keyboard navigation is exactly that kind of
 * behaviour — a small set of edge cases (empty list, first row, last row, "no
 * selection yet") that are easy to get subtly wrong and impossible to notice
 * until someone is holding an arrow key.
 */

/** Where the cursor is, and whether the caller should pull another page. */
export interface SearchCursorMove {
  /** The new cursor index. `-1` means "no row selected". */
  cursor: number;
  /**
   * True when the user tried to move PAST the last loaded result and more exist —
   * the keyboard equivalent of pressing "load more", so arrowing down through a
   * long result set does not dead-end at the page boundary.
   */
  loadMore: boolean;
}

export interface SearchCursorInput {
  /** Current cursor; `-1` before the user has moved. */
  cursor: number;
  /** How many results are currently LOADED. */
  count: number;
  /** Whether the API says another page exists. */
  hasNextPage: boolean;
}

/**
 * ArrowDown: advance, clamping at the last loaded row. At the clamp, ask for
 * another page when one exists — the cursor stays put and simply has further to
 * go once the page arrives.
 */
export function searchCursorDown({
  cursor,
  count,
  hasNextPage,
}: SearchCursorInput): SearchCursorMove {
  if (count === 0) return { cursor: -1, loadMore: false };
  const next = cursor + 1;
  if (next >= count) return { cursor: count - 1, loadMore: hasNextPage };
  return { cursor: next, loadMore: false };
}

/**
 * ArrowUp: retreat, clamping at the FIRST row rather than wrapping to the end or
 * falling back to "no selection". Wrapping would silently move the user from the
 * newest match to the oldest one, which reads as a jump, not a step.
 */
export function searchCursorUp({ cursor, count }: SearchCursorInput): SearchCursorMove {
  if (count === 0) return { cursor: -1, loadMore: false };
  return { cursor: cursor <= 0 ? 0 : cursor - 1, loadMore: false };
}

/**
 * The index Enter acts on. With no cursor yet this is the FIRST result — typing a
 * query and pressing Enter should go to the best match without an extra
 * keystroke. Returns `-1` when there is nothing to act on.
 */
export function searchCursorTarget({ cursor, count }: Pick<SearchCursorInput, "cursor" | "count">): number {
  if (count === 0) return -1;
  return cursor >= 0 ? cursor : 0;
}
