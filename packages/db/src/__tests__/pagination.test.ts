import { describe, expect, it } from "vitest";
import {
  buildMessagesPage,
  decodeMessageCursor,
  encodeMessageCursor,
  isBeforeCursor,
  type MessageCursor,
} from "../pagination.js";

function makeRows(count: number): Array<{ id: string; createdAt: string; n: number }> {
  // Newest-first, some rows share the same createdAt to exercise the id tiebreak.
  return Array.from({ length: count }, (_, i) => {
    const n = count - 1 - i;
    return {
      n,
      id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
      createdAt: new Date(1700000000000 + Math.floor(n / 2) * 1000).toISOString(),
    };
  });
}

describe("message cursor codec", () => {
  it("round-trips a cursor", () => {
    const cursor: MessageCursor = {
      createdAt: "2026-07-02T10:00:00.000Z",
      id: "11111111-2222-3333-4444-555555555555",
    };
    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
  });

  it("rejects garbage input", () => {
    expect(decodeMessageCursor("not-base64-json")).toBeNull();
    expect(decodeMessageCursor("")).toBeNull();
    expect(decodeMessageCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeMessageCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(
      decodeMessageCursor(
        Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: "x" })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeMessageCursor(
        Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", id: "" })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
  });
});

describe("isBeforeCursor", () => {
  it("orders by createdAt first, id as tiebreak", () => {
    const early = { createdAt: "2026-01-01T00:00:00.000Z", id: "b" };
    const late = { createdAt: "2026-01-02T00:00:00.000Z", id: "a" };
    expect(isBeforeCursor(early, late)).toBe(true);
    expect(isBeforeCursor(late, early)).toBe(false);

    const sameTimeA = { createdAt: "2026-01-01T00:00:00.000Z", id: "a" };
    const sameTimeB = { createdAt: "2026-01-01T00:00:00.000Z", id: "b" };
    expect(isBeforeCursor(sameTimeA, sameTimeB)).toBe(true);
    expect(isBeforeCursor(sameTimeB, sameTimeA)).toBe(false);
    expect(isBeforeCursor(sameTimeA, sameTimeA)).toBe(false);
  });
});

describe("buildMessagesPage", () => {
  it("returns no cursor on the last page", () => {
    const rows = makeRows(5);
    const page = buildMessagesPage(rows, 10);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("trims the sentinel row and emits a cursor when more rows exist", () => {
    const rows = makeRows(11); // limit + 1 fetch for limit 10
    const page = buildMessagesPage(rows, 10);
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeMessageCursor(page.nextCursor as string);
    expect(decoded).toEqual({
      createdAt: rows[9]?.createdAt,
      id: rows[9]?.id,
    });
  });

  it("paging a fixed dataset yields disjoint, complete, ordered pages", () => {
    const all = makeRows(23);
    const limit = 5;
    const seen: string[] = [];
    let cursor: MessageCursor | null = null;

    // Simulate the repository: filter strictly-before-cursor, take limit + 1.
    for (let guard = 0; guard < 10; guard++) {
      const current = cursor;
      const filtered = current
        ? all.filter((row) => isBeforeCursor(row, current))
        : all;
      const page = buildMessagesPage(filtered.slice(0, limit + 1), limit);
      seen.push(...page.items.map((m) => m.id));
      if (page.nextCursor === null) break;
      cursor = decodeMessageCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length); // no duplicates across pages
    expect(seen).toEqual(all.map((r) => r.id)); // global order preserved
  });

  it("handles a degenerate limit", () => {
    expect(buildMessagesPage(makeRows(3), 0)).toEqual({ items: [], nextCursor: null });
  });
});
