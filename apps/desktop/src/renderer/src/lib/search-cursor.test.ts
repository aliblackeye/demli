import { describe, expect, it } from "vitest";
import {
  searchCursorDown,
  searchCursorTarget,
  searchCursorUp,
} from "./search-cursor";

/**
 * Keyboard navigation of search results. These are the cases a user hits by
 * holding an arrow key, which is precisely when an off-by-one becomes obvious
 * and irritating.
 */
describe("searchCursorDown", () => {
  it("moves from 'nothing selected' onto the first result", () => {
    expect(searchCursorDown({ cursor: -1, count: 5, hasNextPage: false })).toEqual({
      cursor: 0,
      loadMore: false,
    });
  });

  it("advances one row at a time", () => {
    expect(searchCursorDown({ cursor: 2, count: 5, hasNextPage: false }).cursor).toBe(3);
  });

  it("CLAMPS at the last row instead of running off the end", () => {
    expect(searchCursorDown({ cursor: 4, count: 5, hasNextPage: false })).toEqual({
      cursor: 4,
      loadMore: false,
    });
  });

  it("asks for another page when it hits the end and more exist", () => {
    expect(searchCursorDown({ cursor: 4, count: 5, hasNextPage: true })).toEqual({
      cursor: 4,
      loadMore: true,
    });
  });

  it("does not ask for a page while still moving inside the loaded set", () => {
    expect(searchCursorDown({ cursor: 1, count: 5, hasNextPage: true })).toEqual({
      cursor: 2,
      loadMore: false,
    });
  });

  it("is a no-op with no results", () => {
    expect(searchCursorDown({ cursor: -1, count: 0, hasNextPage: true })).toEqual({
      cursor: -1,
      loadMore: false,
    });
  });
});

describe("searchCursorUp", () => {
  it("retreats one row at a time", () => {
    expect(searchCursorUp({ cursor: 3, count: 5, hasNextPage: false }).cursor).toBe(2);
  });

  it("CLAMPS at the first row — it never wraps to the oldest match", () => {
    expect(searchCursorUp({ cursor: 0, count: 5, hasNextPage: false }).cursor).toBe(0);
  });

  it("lands on the first row from 'nothing selected' rather than the last", () => {
    expect(searchCursorUp({ cursor: -1, count: 5, hasNextPage: false }).cursor).toBe(0);
  });

  it("never asks for another page (paging backwards is what the list already does)", () => {
    expect(searchCursorUp({ cursor: 0, count: 5, hasNextPage: true }).loadMore).toBe(false);
  });

  it("is a no-op with no results", () => {
    expect(searchCursorUp({ cursor: -1, count: 0, hasNextPage: false }).cursor).toBe(-1);
  });
});

describe("searchCursorTarget", () => {
  it("uses the FIRST result when the user has not moved — type, Enter, go", () => {
    expect(searchCursorTarget({ cursor: -1, count: 3 })).toBe(0);
  });

  it("uses the highlighted row once the user has moved", () => {
    expect(searchCursorTarget({ cursor: 2, count: 3 })).toBe(2);
  });

  it("reports 'nothing to act on' for an empty result set", () => {
    expect(searchCursorTarget({ cursor: -1, count: 0 })).toBe(-1);
    expect(searchCursorTarget({ cursor: 4, count: 0 })).toBe(-1);
  });
});
