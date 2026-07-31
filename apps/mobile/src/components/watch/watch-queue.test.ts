import { describe, expect, it } from "vitest";
import {
  canMoveQueueItem,
  formatWatchDuration,
  moveQueueItem,
  watchSearchFailure,
} from "./watch-queue";

const IDS = ["a", "b", "c"];

describe("canMoveQueueItem", () => {
  it("refuses the ends, so the UI omits the control rather than drawing a dead one", () => {
    expect(canMoveQueueItem(IDS, "a", -1)).toBe(false);
    expect(canMoveQueueItem(IDS, "c", 1)).toBe(false);
  });

  it("allows a move that stays inside the list", () => {
    expect(canMoveQueueItem(IDS, "a", 1)).toBe(true);
    expect(canMoveQueueItem(IDS, "b", -1)).toBe(true);
    expect(canMoveQueueItem(IDS, "c", -1)).toBe(true);
  });

  it("refuses an id that is not in the list", () => {
    // The queue moves underneath the render: the host's `watch.ended` pops the
    // head between the draw and the tap. A vanished id must not be movable.
    expect(canMoveQueueItem(IDS, "gone", -1)).toBe(false);
    expect(canMoveQueueItem(IDS, "gone", 1)).toBe(false);
  });

  it("refuses every move in a single-item list", () => {
    expect(canMoveQueueItem(["only"], "only", -1)).toBe(false);
    expect(canMoveQueueItem(["only"], "only", 1)).toBe(false);
  });
});

describe("moveQueueItem", () => {
  it("moves one slot in each direction", () => {
    expect(moveQueueItem(IDS, "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveQueueItem(IDS, "c", -1)).toEqual(["a", "c", "b"]);
  });

  it("returns the list unchanged at the ends", () => {
    expect(moveQueueItem(IDS, "a", -1)).toEqual(IDS);
    expect(moveQueueItem(IDS, "c", 1)).toEqual(IDS);
  });

  it("returns the list unchanged for a vanished id", () => {
    expect(moveQueueItem(IDS, "gone", 1)).toEqual(IDS);
  });

  it("never mutates the input — the caller still holds the drawn order", () => {
    const input = [...IDS];
    moveQueueItem(input, "a", 1);
    expect(input).toEqual(IDS);
  });

  it("produces the FULL order the gateway expects, not a delta", () => {
    // `watch.queue_reorder` takes a complete list; a partial one would truncate
    // the server's queue to whatever the phone happened to have drawn.
    expect(moveQueueItem(IDS, "b", 1)).toHaveLength(IDS.length);
  });
});

describe("formatWatchDuration", () => {
  it("uses m:ss under an hour and h:mm:ss above it", () => {
    expect(formatWatchDuration(0)).toBe("0:00");
    expect(formatWatchDuration(9)).toBe("0:09");
    expect(formatWatchDuration(75)).toBe("1:15");
    expect(formatWatchDuration(3600)).toBe("1:00:00");
    expect(formatWatchDuration(3725)).toBe("1:02:05");
  });

  it("renders NOTHING rather than a wrong number", () => {
    // A "0:00" next to a title reads as fact. Null in, null out.
    expect(formatWatchDuration(null)).toBeNull();
    expect(formatWatchDuration(undefined)).toBeNull();
    expect(formatWatchDuration(-1)).toBeNull();
    expect(formatWatchDuration(Number.NaN)).toBeNull();
    expect(formatWatchDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("floors fractional seconds instead of rounding into the next second", () => {
    expect(formatWatchDuration(59.9)).toBe("0:59");
  });
});

describe("watchSearchFailure", () => {
  it("keeps the three causes apart — they clear on different timescales", () => {
    expect(watchSearchFailure("WATCH_SEARCH_DISABLED")).toBe("disabled");
    expect(watchSearchFailure("WATCH_SEARCH_QUOTA")).toBe("quota");
    expect(watchSearchFailure("WATCH_SEARCH_UNAVAILABLE")).toBe("unavailable");
  });

  it("falls back to the catch-all for anything else", () => {
    expect(watchSearchFailure(null)).toBe("unknown");
    expect(watchSearchFailure(undefined)).toBe("unknown");
    expect(watchSearchFailure("SOMETHING_NEW")).toBe("unknown");
  });
});
