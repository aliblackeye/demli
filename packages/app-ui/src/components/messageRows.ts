/**
 * Pure row model for the virtualized message thread.
 *
 * Extracted from {@link ./MessageList} so the two rules that are easy to break
 * silently — author grouping and the ignored-author fold (ADR 0019 §4) — are
 * plain functions with tests, instead of closures inside a component the app-ui
 * vitest config (node, no DOM) cannot render.
 *
 * Everything here is deliberately framework-free: `buildRows` takes messages and
 * flags, returns rows. The list adds virtualization, scroll and React state.
 */

import type { ChatMessageView } from "../data/chat-data";

/** Same author within this window collapses into a compact continuation row. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Synthetic id prefix used by the optimistic outbox (see the surface provider). */
export const OUTBOX_ID_PREFIX = "outbox-";

/** Row key prefix for a folded ignored-author run — never collides with a message id. */
export const IGNORED_RUN_KEY_PREFIX = "ignored:";

/** Stable empty set so a surface with no ignores never churns the row memo. */
const NO_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Pure positioning logic for the in-thread "New Messages" divider: given the
 * channel's messages oldest→newest and the persisted read watermark, return the
 * id of the FIRST message that arrived after it (the message the divider renders
 * directly above), or `null` when there is nothing new to mark. Conservative so
 * the divider never lies (no watermark → none; caught up → none; watermark older
 * than the loaded window → top; an own optimistic send → none).
 */
export function firstUnreadMessageId(
  ascendingIds: readonly string[],
  watermarkId: string | null | undefined,
): string | null {
  if (ascendingIds.length === 0) return null;
  if (!watermarkId) return null;

  const index = ascendingIds.indexOf(watermarkId);
  if (index === -1) {
    const candidate = ascendingIds[0];
    return candidate && !candidate.startsWith(OUTBOX_ID_PREFIX) ? candidate : null;
  }
  if (index >= ascendingIds.length - 1) return null;

  const candidate = ascendingIds[index + 1];
  if (!candidate || candidate.startsWith(OUTBOX_ID_PREFIX)) return null;
  return candidate;
}

/**
 * One virtualized row. `ignored-run` is the ADR 0019 §4 fold: a single thin
 * placeholder standing in for a CONSECUTIVE run of messages from ignored
 * authors, so a thread does not fill with a hundred identical stubs. It is
 * always emitted (collapsed or expanded) — expanding only appends the run's
 * message rows after it, which keeps the placeholder's own key and measured
 * height stable across the toggle.
 */
export type ListRow =
  | { kind: "intro"; key: string }
  | { kind: "older-loading"; key: string }
  | { kind: "unread-divider"; key: string }
  | {
      /**
       * Calendar-day separator (M16): sits directly above the first visible
       * message of a new LOCAL day. `dayStart` is that day's local midnight in
       * epoch ms — the label ("Bugün", "Dün", a date) is resolved at render so
       * the model stays locale-free.
       */
      kind: "date-divider";
      key: string;
      dayStart: number;
    }
  | {
      kind: "ignored-run";
      key: string;
      /** Identity of the run: the id of its FIRST message (stable as it grows). */
      runId: string;
      /** How many messages the run folds. */
      count: number;
      /** How many distinct ignored authors it spans (drives the copy). */
      authorCount: number;
      /** The viewer chose to reveal it — the message rows follow this one. */
      expanded: boolean;
    }
  | {
      kind: "message";
      key: string;
      message: ChatMessageView;
      isContinuation: boolean;
      /**
       * Set only on a REVEALED ignored message: the key of the placeholder it
       * came from. Lets the list treat "the thread gained content" as a fact
       * about messages rather than about rows — see {@link tailSentinel}.
       */
      runKey?: string;
    };

export interface BuildRowsOptions {
  /** No older page remains → render the channel intro instead of a spinner. */
  atChannelStart: boolean;
  /** An older page is in flight → render the top spinner row. */
  loadingOlder: boolean;
  /** The message the "New Messages" divider sits directly above, or null. */
  dividerBeforeId: string | null;
  /**
   * Authors the viewer is ignoring (ADR 0019 §4). Their messages arrive and are
   * stored normally — the server hides nothing — so the fold is entirely a
   * client-side attention filter.
   */
  ignoredAuthorIds?: ReadonlySet<string>;
  /** Run ids ({@link ListRow} `runId`) the viewer has expanded this session. */
  expandedIgnoredRuns?: ReadonlySet<string>;
  /**
   * Insert a `date-divider` row above the first message of every new local
   * calendar day (M16). Opt-in so callers that do not render one get exactly
   * the rows they always got. A divider also breaks author grouping — the
   * message under it always keeps its header, like under the unread line.
   */
  dateDividers?: boolean;
}

/** Local midnight (epoch ms) of the day `iso` falls on — the date-divider key. */
export function localDayStart(iso: string): number {
  const date = new Date(iso);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** True when this message should be folded away for the viewer. */
function isIgnoredMessage(message: ChatMessageView, ignoredAuthorIds: ReadonlySet<string>): boolean {
  // System notices (joined/left) are channel chrome, not speech: folding them
  // would both read as a bug and split otherwise-contiguous runs.
  return message.kind !== "system" && ignoredAuthorIds.has(message.authorId);
}

/**
 * Should `message` render as a compact continuation of `previous`?
 *
 * System notices render standalone and never merge with, or absorb, an adjacent
 * authored message. A failed send always keeps its header so its retry controls
 * are reachable.
 */
function isContinuationOf(message: ChatMessageView, previous: ChatMessageView | null): boolean {
  return (
    message.kind !== "system" &&
    previous !== null &&
    previous.kind !== "system" &&
    previous.authorId === message.authorId &&
    previous.deliveryState !== "failed" &&
    Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS
  );
}

export function buildRows(messages: ChatMessageView[], options: BuildRowsOptions): ListRow[] {
  const ignoredAuthorIds = options.ignoredAuthorIds ?? NO_IDS;
  const expandedIgnoredRuns = options.expandedIgnoredRuns ?? NO_IDS;

  const rows: ListRow[] = [];
  if (options.atChannelStart) rows.push({ kind: "intro", key: "intro" });
  else if (options.loadingOlder) rows.push({ kind: "older-loading", key: "older-loading" });

  let previous: ChatMessageView | null = null;
  let index = 0;
  // Local day of the last divider emitted. Only a LATER day opens a new one: an
  // out-of-order row (an optimistic send stamped by a skewed clock) must never
  // emit a second divider for a day already shown — that would also duplicate
  // the virtualizer key.
  let lastDay: number | null = null;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      index++;
      continue;
    }

    if (options.dateDividers) {
      const day = localDayStart(message.createdAt);
      if (lastDay === null || day > lastDay) {
        rows.push({ kind: "date-divider", key: `date:${day}`, dayStart: day });
        lastDay = day;
        previous = null; // a new day always starts with a header
      }
    }

    // The "New Messages" divider sits directly above the first message that
    // arrived after the read watermark. Rendered as its own
    // row so it participates in virtualization without touching message layout.
    if (message.id === options.dividerBeforeId) {
      rows.push({ kind: "unread-divider", key: "unread-divider" });
      previous = null; // the message under the divider always keeps its header
    }

    if (!isIgnoredMessage(message, ignoredAuthorIds)) {
      rows.push({
        kind: "message",
        key: message.renderKey ?? message.id,
        message,
        isContinuation: isContinuationOf(message, previous),
      });
      previous = message;
      index++;
      continue;
    }

    // Consecutive ignored messages fold into ONE placeholder. The run stops at
    // the first non-ignored / system message, and at the divider anchor — the
    // unread line must keep its position even inside a folded stretch.
    const run: ChatMessageView[] = [];
    let scan = index;
    while (scan < messages.length) {
      const candidate = messages[scan];
      if (!candidate) break;
      if (scan > index && candidate.id === options.dividerBeforeId) break;
      if (!isIgnoredMessage(candidate, ignoredAuthorIds)) break;
      // A fold never spans midnight: the next day's divider must still render.
      if (
        scan > index &&
        options.dateDividers &&
        lastDay !== null &&
        localDayStart(candidate.createdAt) > lastDay
      ) {
        break;
      }
      run.push(candidate);
      scan++;
    }

    const first = run[0];
    if (!first) {
      // Unreachable (the run always contains `message`); keeps the loop total.
      index++;
      continue;
    }

    const runId = first.id;
    const expanded = expandedIgnoredRuns.has(runId);
    const authors = new Set<string>();
    for (const entry of run) authors.add(entry.authorId);

    const runKey = `${IGNORED_RUN_KEY_PREFIX}${runId}`;
    rows.push({
      kind: "ignored-run",
      key: runKey,
      runId,
      count: run.length,
      authorCount: authors.size,
      expanded,
    });

    if (expanded) {
      let previousInRun: ChatMessageView | null = null;
      for (const entry of run) {
        rows.push({
          kind: "message",
          key: entry.id,
          message: entry,
          isContinuation: isContinuationOf(entry, previousInRun),
          runKey,
        });
        previousInRun = entry;
      }
    }

    // Either way the next visible message starts a fresh header: a placeholder
    // (or a revealed block that ends with a different author) always breaks the
    // grouping, and a collapsed run must never leave a headerless orphan behind.
    previous = null;
    index = scan;
  }

  return rows;
}

/**
 * "Has the thread gained content?" as a single comparable value — the key of the
 * last row, except that a REVEALED ignored message reports the placeholder it
 * came from.
 *
 * That indirection is the whole point, and it fixes both halves of one bug:
 *
 *  - Expanding the last fold must not read as new content, or the list either
 *    yanks the scroll or raises a "jump to present" pill for something the user
 *    just did themselves.
 *  - A new message from an IGNORED author must not raise that pill either. It
 *    only bumps the placeholder's count; nothing was inserted and the list did
 *    not grow, so an alert would put that person in front of the very viewer who
 *    asked not to see them (ADR 0019 §4).
 *
 * A new message from anyone else lands as a plain row and changes the sentinel,
 * exactly as before.
 */
export function tailSentinel(rows: readonly ListRow[]): string | undefined {
  const last = rows[rows.length - 1];
  if (!last) return undefined;
  return last.kind === "message" ? (last.runKey ?? last.key) : last.key;
}

/**
 * Toggle one run's expanded state, returning a NEW set (the caller stores it in
 * React state). Pure so the fold's open/close behavior is testable without a DOM.
 */
export function toggleIgnoredRun(
  expanded: ReadonlySet<string>,
  runId: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(runId)) next.delete(runId);
  else next.add(runId);
  return next;
}
