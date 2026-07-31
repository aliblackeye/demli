/**
 * Queue arithmetic (M20 wave 3).
 *
 * The theme of every case here is that operations are named by `itemId`, never
 * by position — because the queue moves underneath the UI (the host's own
 * `watch.ended` pops the head) and an index captured at render time can name a
 * different video by the time it is clicked.
 */

import { describe, expect, it } from "vitest";
import {
  canMoveQueueItem,
  dropQueueItem,
  formatWatchDuration,
  moveQueueItem,
  watchSearchFailure,
} from "./watchQueue";

const IDS = ["a", "b", "c", "d"];

describe("moveQueueItem", () => {
  it("moves an item one slot towards the front", () => {
    expect(moveQueueItem(IDS, "c", -1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves an item one slot towards the back", () => {
    expect(moveQueueItem(IDS, "b", 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("names the item, not its index — the same id moves after the list shifted", () => {
    // The head was consumed by an auto-advance between render and click.
    const afterAdvance = ["b", "c", "d"];
    // A UI holding "index 2" would now move "d". Holding the id moves "c".
    expect(moveQueueItem(afterAdvance, "c", -1)).toEqual(["c", "b", "d"]);
  });

  it("is a no-op at the front and at the back", () => {
    expect(moveQueueItem(IDS, "a", -1)).toEqual(IDS);
    expect(moveQueueItem(IDS, "d", 1)).toEqual(IDS);
  });

  it("is a no-op for an id that is no longer in the queue", () => {
    expect(moveQueueItem(IDS, "gone", -1)).toEqual(IDS);
  });

  it("never mutates its input", () => {
    const original = [...IDS];
    moveQueueItem(IDS, "b", 1);
    expect(IDS).toEqual(original);
  });

  it("preserves every id — a move reorders, it does not drop", () => {
    expect([...moveQueueItem(IDS, "d", -1)].sort()).toEqual([...IDS].sort());
  });
});

describe("canMoveQueueItem", () => {
  it("is false at the ends, so the UI omits the button instead of disabling it", () => {
    expect(canMoveQueueItem(IDS, "a", -1)).toBe(false);
    expect(canMoveQueueItem(IDS, "d", 1)).toBe(false);
  });

  it("is true in the middle", () => {
    expect(canMoveQueueItem(IDS, "b", -1)).toBe(true);
    expect(canMoveQueueItem(IDS, "b", 1)).toBe(true);
  });

  it("is false for an unknown id", () => {
    expect(canMoveQueueItem(IDS, "gone", 1)).toBe(false);
  });

  it("is false for the only item, in both directions", () => {
    expect(canMoveQueueItem(["solo"], "solo", -1)).toBe(false);
    expect(canMoveQueueItem(["solo"], "solo", 1)).toBe(false);
  });
});

describe("dropQueueItem", () => {
  it("re-inserts the dragged item at the target's position", () => {
    expect(dropQueueItem(IDS, "d", "a")).toEqual(["d", "a", "b", "c"]);
    expect(dropQueueItem(IDS, "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("is a no-op when dropped on itself", () => {
    expect(dropQueueItem(IDS, "b", "b")).toEqual(IDS);
  });

  it("is a no-op when either id has left the queue", () => {
    expect(dropQueueItem(IDS, "gone", "a")).toEqual(IDS);
    expect(dropQueueItem(IDS, "a", "gone")).toEqual(IDS);
  });

  it("preserves every id", () => {
    expect([...dropQueueItem(IDS, "a", "d")].sort()).toEqual([...IDS].sort());
  });
});

describe("formatWatchDuration", () => {
  it("formats under an hour as m:ss", () => {
    expect(formatWatchDuration(253)).toBe("4:13");
    expect(formatWatchDuration(9)).toBe("0:09");
    expect(formatWatchDuration(60)).toBe("1:00");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatWatchDuration(3600)).toBe("1:00:00");
    expect(formatWatchDuration(3725)).toBe("1:02:05");
  });

  it("returns null rather than inventing a number", () => {
    // A wrong duration beside a title reads as fact, so an unknown one renders
    // nothing at all.
    expect(formatWatchDuration(null)).toBeNull();
    expect(formatWatchDuration(undefined)).toBeNull();
    expect(formatWatchDuration(-1)).toBeNull();
    expect(formatWatchDuration(Number.NaN)).toBeNull();
    expect(formatWatchDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("treats zero as a real duration, not a missing one", () => {
    expect(formatWatchDuration(0)).toBe("0:00");
  });
});

describe("watchSearchFailure", () => {
  it("keeps the three refusals apart", () => {
    // They clear on three different timescales, so they must not collapse into
    // one "search failed" — see the type's own comment.
    expect(watchSearchFailure("WATCH_SEARCH_DISABLED")).toBe("disabled");
    expect(watchSearchFailure("WATCH_SEARCH_QUOTA")).toBe("quota");
    expect(watchSearchFailure("WATCH_SEARCH_UNAVAILABLE")).toBe("unavailable");
  });

  it("maps every three to a DISTINCT value", () => {
    const kinds = new Set([
      watchSearchFailure("WATCH_SEARCH_DISABLED"),
      watchSearchFailure("WATCH_SEARCH_QUOTA"),
      watchSearchFailure("WATCH_SEARCH_UNAVAILABLE"),
    ]);
    expect(kinds.size).toBe(3);
  });

  it("falls back to unknown for anything else", () => {
    expect(watchSearchFailure("NETWORK")).toBe("unknown");
    expect(watchSearchFailure(null)).toBe("unknown");
    expect(watchSearchFailure(undefined)).toBe("unknown");
  });
});
