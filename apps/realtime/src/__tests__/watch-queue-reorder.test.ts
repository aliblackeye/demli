/**
 * `reorderQueue` — the pure half of the queue's concurrency story (M20 wave 2).
 *
 * The integration suite proves it over real sockets with two controllers racing.
 * This file pins the RULE itself, because the whole safety argument for
 * "reorder = a desired full order" rather than "reorder = move item X to index N"
 * lives in one function: whatever a client names, the result must be a
 * PERMUTATION of what the server actually holds — every item exactly once, and
 * nothing the server does not have.
 */

import { describe, expect, it } from "vitest";
import type { WatchQueueItem } from "@demli/protocol";
import { reorderQueue } from "../watch-party.js";

function item(id: string): WatchQueueItem {
  return {
    itemId: id,
    videoId: "dQw4w9WgXcQ",
    addedBy: "user-1",
    addedAt: "2026-07-28T12:00:00.000Z",
    title: id,
    durationSeconds: null,
  };
}

const queue = [item("a"), item("b"), item("c")];

/** The property every case below must satisfy, whatever the client asked for. */
function expectPermutationOf(result: WatchQueueItem[], source: WatchQueueItem[]): void {
  expect(result.map((i) => i.itemId).sort()).toEqual(source.map((i) => i.itemId).sort());
  expect(new Set(result.map((i) => i.itemId)).size).toBe(result.length);
}

describe("reorderQueue", () => {
  it("applies a full ordering", () => {
    const result = reorderQueue(queue, ["c", "a", "b"]);
    expect(result.map((i) => i.itemId)).toEqual(["c", "a", "b"]);
    expectPermutationOf(result, queue);
  });

  it("moves a named item to the front and leaves the rest in their existing order", () => {
    // The common UI action ("drag this to the top") names ONE id, not the whole
    // list — so a partial order has to mean something sensible.
    const result = reorderQueue(queue, ["c"]);
    expect(result.map((i) => i.itemId)).toEqual(["c", "a", "b"]);
    expectPermutationOf(result, queue);
  });

  it("ignores ids the server does not hold", () => {
    // The realistic race: the client built this list before someone else removed
    // an item, or before the auto-advance consumed the head.
    const result = reorderQueue(queue, ["ghost", "b", "gone", "a"]);
    expect(result.map((i) => i.itemId)).toEqual(["b", "a", "c"]);
    expectPermutationOf(result, queue);
  });

  it("keeps items the client never mentioned", () => {
    // Added by the OTHER controller between the client rendering its list and
    // this frame arriving. Dropping them would delete someone else's video.
    const result = reorderQueue(queue, ["b"]);
    expect(result.map((i) => i.itemId)).toEqual(["b", "a", "c"]);
    expectPermutationOf(result, queue);
  });

  it("collapses a repeated id instead of duplicating the row", () => {
    // A duplicated id in the request must not become the same video twice in the
    // queue — that is the corruption this whole design exists to make impossible.
    const result = reorderQueue(queue, ["b", "b", "b", "a"]);
    expect(result.map((i) => i.itemId)).toEqual(["b", "a", "c"]);
    expectPermutationOf(result, queue);
  });

  it("treats an empty request as 'change nothing'", () => {
    const result = reorderQueue(queue, []);
    expect(result.map((i) => i.itemId)).toEqual(["a", "b", "c"]);
  });

  it("never mutates the queue it was given", () => {
    const source = [item("a"), item("b")];
    const snapshot = source.map((i) => i.itemId);
    reorderQueue(source, ["b", "a"]);
    expect(source.map((i) => i.itemId)).toEqual(snapshot);
  });

  it("is stable under a sequence of racing reorders", () => {
    // Whatever order two controllers' frames land in, the queue is always valid
    // — the later frame wins the arrangement and neither can corrupt the set.
    let current = [item("a"), item("b"), item("c"), item("d")];
    const requests = [
      ["d", "c", "b", "a"],
      ["b", "ghost"],
      ["a", "a", "d"],
      [],
      ["c"],
    ];
    for (const request of requests) {
      current = reorderQueue(current, request);
      expectPermutationOf(current, [item("a"), item("b"), item("c"), item("d")]);
    }
  });
});
