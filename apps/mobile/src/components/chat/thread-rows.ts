/**
 * The row model behind the mobile chat thread — pure, node-testable.
 *
 * ChatThread feeds an INVERTED FlatList a newest-first array of items (the
 * optimistic outbox first, then the server pages). Every cell renders upright,
 * so anything that must sit visually ABOVE a message (an unread line, a day
 * separator) is drawn inside that message's own cell, before the bubble. This
 * module decides, per index, what each cell carries:
 *
 *  - `grouped`  — a compact continuation under the previous (older) message of
 *    the same author. Mirrors the desktop `buildRows` rule: same author, within
 *    {@link MESSAGE_GROUP_WINDOW_MS}, neither side a system notice, the older
 *    side not a failed send, the newer side not a reply, and — new in M16 — never
 *    across a calendar-day boundary (a day separator always restarts a group).
 *  - `dayStart` — local midnight (epoch ms) when a day separator belongs above
 *    this message: its day differs from the older neighbour's, or it is the very
 *    first message of the conversation (history fully loaded). The oldest LOADED
 *    message of a conversation with more pages gets none — the next page may
 *    hold more of the same day, and a separator there would be a guess.
 *  - `unread`   — the "new messages" line sits above this message.
 */
import type { Message } from "@demli/types";
import type { OutboxMessage } from "../../stores/chat-store";

/** Same-author grouping window — mirrors desktop MessageList `GROUP_WINDOW_MS`. */
export const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ChatItem =
  | { kind: "server"; message: Message }
  | { kind: "outbox"; message: OutboxMessage };

export interface ThreadRowMeta {
  grouped: boolean;
  /** Local midnight of this message's day when a day separator goes above it. */
  dayStart: number | null;
  unread: boolean;
}

const DAY_MS = 86_400_000;

/** Local midnight (epoch ms) of the day an ISO timestamp falls on. NaN-safe. */
export function localDayStart(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function itemIsSystem(item: ChatItem): boolean {
  return item.kind === "server" && item.message.kind === "system";
}

/** Stable key of an item — the FlatList key and the highlight target id. */
export function itemKey(item: ChatItem): string {
  return item.kind === "server" ? item.message.id : `nonce-${item.message.nonce}`;
}

/**
 * Whether `curr` renders as a continuation hanging under the chronologically
 * older `prev` (the item at the NEXT index of the newest-first array).
 */
export function isContinuationRow(curr: ChatItem, prev: ChatItem | undefined): boolean {
  if (!prev) return false;
  if (itemIsSystem(curr) || itemIsSystem(prev)) return false;
  if (curr.message.replyTo != null) return false;
  if (prev.kind === "outbox" && prev.message.deliveryState === "failed") return false;
  if (curr.message.authorId !== prev.message.authorId) return false;
  if (localDayStart(curr.message.createdAt) !== localDayStart(prev.message.createdAt)) return false;
  return (
    Date.parse(curr.message.createdAt) - Date.parse(prev.message.createdAt) <
    MESSAGE_GROUP_WINDOW_MS
  );
}

/**
 * Per-index meta for the newest-first `items`.
 *
 * @param unreadAnchorId the first unread server message (frozen per visit), or null
 * @param historyComplete true once the oldest page is loaded (no `hasNextPage`)
 */
export function buildThreadRows(
  items: readonly ChatItem[],
  unreadAnchorId: string | null,
  historyComplete: boolean,
): ThreadRowMeta[] {
  const rows: ThreadRowMeta[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const older = items[i + 1];
    const unread =
      unreadAnchorId !== null && item.kind === "server" && item.message.id === unreadAnchorId;
    const day = localDayStart(item.message.createdAt);
    let dayStart: number | null = null;
    if (!Number.isNaN(day)) {
      if (older) {
        if (localDayStart(older.message.createdAt) !== day) dayStart = day;
      } else if (historyComplete) {
        dayStart = day;
      }
    }
    // The unread line and a day separator both restart the visual group: the
    // first message after either keeps its author header.
    const grouped = unread || dayStart !== null ? false : isContinuationRow(item, older);
    rows[i] = { grouped, dayStart, unread };
  }
  return rows;
}

/**
 * How many SERVER messages are newer than `sinceId` in a newest-first list —
 * the count on the jump pill ("3 yeni mesaj"). The outbox is excluded: your own
 * sends are not news. Returns 0 when the id is not loaded.
 */
export function countNewerThan(serverMessages: readonly Message[], sinceId: string | null): number {
  if (sinceId === null) return 0;
  const index = serverMessages.findIndex((m) => m.id === sinceId);
  return index <= 0 ? 0 : index;
}

/**
 * The day separator's label: "Bugün" / "Dün", then the full date in the APP
 * language (a Turkish UI reads "12 Ekim Pazartesi" on an English phone), the
 * year only when it is not this year. Same rule as the desktop DateDivider.
 */
export function dayLabel(
  dayStart: number,
  now: Date,
  language: string,
  words: { today: string; yesterday: string },
): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Round, not floor: a DST shift makes one calendar day 23h or 25h long.
  const daysAgo = Math.round((today - dayStart) / DAY_MS);
  if (daysAgo === 0) return words.today;
  if (daysAgo === 1) return words.yesterday;
  const date = new Date(dayStart);
  const sameYear = date.getFullYear() === now.getFullYear();
  try {
    return new Intl.DateTimeFormat(language, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: sameYear ? undefined : "numeric",
    }).format(date);
  } catch {
    return date.toDateString();
  }
}

/** "14:05" in the app language; empty for an unparsable timestamp. */
export function formatClock(iso: string, language: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
