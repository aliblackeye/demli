/**
 * Cursor pagination for messages — newest first, keyset on (createdAt, id).
 *
 * The cursor is an opaque base64url JSON blob of the last row on the page.
 * The next page selects rows strictly BEFORE that (createdAt, id) tuple, so
 * pages never overlap and never duplicate rows even when new messages arrive
 * between requests (CLAUDE.md §22 chat gate).
 */

export interface MessageCursor {
  /** ISO-8601 createdAt of the last message on the previous page. */
  createdAt: string;
  /** Id tiebreaker for messages sharing the same createdAt. */
  id: string;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null for anything that is not a well-formed cursor. */
export function decodeMessageCursor(raw: string): MessageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { createdAt?: unknown; id?: unknown };
  if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") {
    return null;
  }
  if (candidate.id.length === 0 || Number.isNaN(Date.parse(candidate.createdAt))) {
    return null;
  }
  return { createdAt: candidate.createdAt, id: candidate.id };
}

/**
 * Strict keyset ordering: is `a` strictly before `b` in newest-first paging
 * (i.e. `a` would appear on a LATER page than `b`)?
 */
export function isBeforeCursor(a: MessageCursor, b: MessageCursor): boolean {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at < bt;
  return a.id < b.id;
}

export interface MessagesPage<T> {
  items: T[];
  /** null when this is the last page. */
  nextCursor: string | null;
}

/**
 * Build a page from `limit + 1` rows fetched newest-first. The extra row only
 * signals that another page exists — it is not returned.
 */
export function buildMessagesPage<T extends { id: string; createdAt: string }>(
  rows: T[],
  limit: number,
): MessagesPage<T> {
  if (limit <= 0) return { items: [], nextCursor: null };
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last !== undefined
        ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
