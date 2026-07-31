import { describe, expect, it } from "vitest";
import type { Channel, ChannelCategory } from "@demli/types";
import {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  moveCategory,
  moveChannel,
  nudgeCategory,
  nudgeChannel,
  toChannelOrderEntries,
  toReorderPayload,
} from "./channelOrder";

const GROUP = "grp-1";

function ch(
  id: string,
  position: number,
  categoryId: string | null = null,
  kind: Channel["kind"] = "text",
): Channel {
  return {
    id,
    groupId: GROUP,
    kind,
    name: id,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    categoryId,
  };
}

function cat(id: string, position: number): ChannelCategory {
  return {
    id,
    groupId: GROUP,
    name: id.toUpperCase(),
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Compact view of a model: one "bucket:ids" string per bucket. */
function shape(buckets: ReturnType<typeof buildSidebarBuckets>): string[] {
  return buckets.map(
    (b) => `${b.category?.id ?? "-"}:${b.channels.map((c) => c.id).join(",")}`,
  );
}

describe("buildSidebarBuckets", () => {
  it("puts the uncategorized bucket first, then categories in position order", () => {
    const buckets = buildSidebarBuckets(
      [ch("a", 0), ch("b", 0, "c2"), ch("c", 0, "c1")],
      [cat("c2", 1), cat("c1", 0)],
    );
    expect(shape(buckets)).toEqual(["-:a", "c1:c", "c2:b"]);
  });

  it("orders channels within a bucket by position", () => {
    const buckets = buildSidebarBuckets([ch("z", 2), ch("x", 0), ch("y", 1)], []);
    expect(shape(buckets)).toEqual(["-:x,y,z"]);
  });

  it("breaks position ties by createdAt then id, so the order is stable", () => {
    const older = { ...ch("late", 0), createdAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...ch("early", 0), createdAt: "2026-02-01T00:00:00.000Z" };
    expect(shape(buildSidebarBuckets([newer, older], []))).toEqual(["-:late,early"]);

    const sameTime = [ch("b", 0), ch("a", 0)];
    expect(shape(buildSidebarBuckets(sameTime, []))).toEqual(["-:a,b"]);
  });

  it("keeps a pre-M18 server (no categories) as one flat uncategorized bucket", () => {
    const buckets = buildSidebarBuckets([ch("a", 0), ch("b", 1, null, "voice")], []);
    expect(buckets).toHaveLength(1);
    expect(shape(buckets)).toEqual(["-:a,b"]);
  });

  it("falls back to uncategorized for a channel naming an unknown category", () => {
    // A category deleted between two fetches must not make its channels vanish.
    const buckets = buildSidebarBuckets([ch("orphan", 0, "gone"), ch("a", 1)], [cat("c1", 0)]);
    expect(shape(buckets)).toEqual(["-:orphan,a", "c1:"]);
  });

  it("does not mutate its inputs", () => {
    const channels = [ch("b", 1), ch("a", 0)];
    const categories = [cat("c2", 1), cat("c1", 0)];
    buildSidebarBuckets(channels, categories);
    expect(channels.map((c) => c.id)).toEqual(["b", "a"]);
    expect(categories.map((c) => c.id)).toEqual(["c2", "c1"]);
  });
});

describe("moveChannel", () => {
  const base = () =>
    buildSidebarBuckets(
      [ch("a", 0), ch("b", 1), ch("x", 0, "c1"), ch("y", 1, "c1")],
      [cat("c1", 0)],
    );

  it("moves a channel into a category before a sibling", () => {
    const next = moveChannel(base(), "a", { categoryId: "c1", beforeChannelId: "y" });
    expect(shape(next)).toEqual(["-:b", "c1:x,a,y"]);
  });

  it("appends when beforeChannelId is null", () => {
    const next = moveChannel(base(), "a", { categoryId: "c1", beforeChannelId: null });
    expect(shape(next)).toEqual(["-:b", "c1:x,y,a"]);
  });

  it("rewrites the moved channel's categoryId so the model stays self-consistent", () => {
    const next = moveChannel(base(), "a", { categoryId: "c1", beforeChannelId: null });
    expect(next[1]?.channels.find((c) => c.id === "a")?.categoryId).toBe("c1");
    const back = moveChannel(next, "a", { categoryId: null, beforeChannelId: null });
    expect(back[0]?.channels.find((c) => c.id === "a")?.categoryId).toBeNull();
  });

  it("pulls a channel back out to the uncategorized list", () => {
    const next = moveChannel(base(), "x", { categoryId: null, beforeChannelId: "a" });
    expect(shape(next)).toEqual(["-:x,a,b", "c1:y"]);
  });

  it("reorders inside one bucket, measuring the index without the moved channel", () => {
    const next = moveChannel(base(), "x", { categoryId: "c1", beforeChannelId: null });
    expect(shape(next)).toEqual(["-:a,b", "c1:y,x"]);
  });

  it("treats a drop onto itself as a no-op", () => {
    const before = base();
    expect(shape(moveChannel(before, "a", { categoryId: null, beforeChannelId: "a" }))).toEqual(
      shape(before),
    );
  });

  it("appends rather than reordering something else when the drop target is stale", () => {
    const next = moveChannel(base(), "a", { categoryId: "c1", beforeChannelId: "deleted" });
    expect(shape(next)).toEqual(["-:b", "c1:x,y,a"]);
  });

  it("is a no-op for an unknown channel or an unknown destination", () => {
    const before = base();
    expect(shape(moveChannel(before, "nope", { categoryId: "c1", beforeChannelId: null }))).toEqual(
      shape(before),
    );
    expect(shape(moveChannel(before, "a", { categoryId: "nope", beforeChannelId: null }))).toEqual(
      shape(before),
    );
  });

  it("does not mutate the input model", () => {
    const before = base();
    moveChannel(before, "a", { categoryId: "c1", beforeChannelId: null });
    expect(shape(before)).toEqual(["-:a,b", "c1:x,y"]);
  });
});

describe("toChannelOrderEntries", () => {
  const base = () =>
    buildSidebarBuckets(
      [ch("a", 0), ch("b", 1), ch("x", 0, "c1"), ch("y", 1, "c1")],
      [cat("c1", 0)],
    );

  it("sends BOTH affected buckets in FULL on a cross-bucket move", () => {
    // The dense-rewrite contract: listing only "a" would renumber it to 0 and
    // collide with x. Both touched buckets must arrive complete and in order.
    const before = base();
    const after = moveChannel(before, "a", { categoryId: "c1", beforeChannelId: "y" });
    expect(toChannelOrderEntries(before, after)).toEqual([
      { channelId: "b", categoryId: null },
      { channelId: "x", categoryId: "c1" },
      { channelId: "a", categoryId: "c1" },
      { channelId: "y", categoryId: "c1" },
    ]);
  });

  it("sends only the changed bucket, but that bucket in full", () => {
    const before = base();
    const after = moveChannel(before, "x", { categoryId: "c1", beforeChannelId: null });
    expect(toChannelOrderEntries(before, after)).toEqual([
      { channelId: "y", categoryId: "c1" },
      { channelId: "x", categoryId: "c1" },
    ]);
  });

  it("emits nothing when the order is unchanged", () => {
    const before = base();
    expect(toChannelOrderEntries(before, before)).toEqual([]);
    const noop = moveChannel(before, "a", { categoryId: null, beforeChannelId: "a" });
    expect(toChannelOrderEntries(before, noop)).toEqual([]);
  });

  it("emits the emptied bucket too, so a fully drained bucket is not left stale", () => {
    const before = buildSidebarBuckets([ch("only", 0, "c1")], [cat("c1", 0)]);
    const after = moveChannel(before, "only", { categoryId: null, beforeChannelId: null });
    // The uncategorized bucket gained the channel; the drained one lists nothing
    // left to renumber, so it contributes no entries — and needs none.
    expect(toChannelOrderEntries(before, after)).toEqual([
      { channelId: "only", categoryId: null },
    ]);
  });
});

describe("nudgeChannel", () => {
  const base = () => buildSidebarBuckets([ch("a", 0), ch("b", 1), ch("c", 2)], []);

  it("swaps with the previous / next sibling", () => {
    expect(shape(nudgeChannel(base(), "b", "up"))).toEqual(["-:b,a,c"]);
    expect(shape(nudgeChannel(base(), "b", "down"))).toEqual(["-:a,c,b"]);
  });

  it("is a no-op at either edge of the bucket", () => {
    expect(shape(nudgeChannel(base(), "a", "up"))).toEqual(["-:a,b,c"]);
    expect(shape(nudgeChannel(base(), "c", "down"))).toEqual(["-:a,b,c"]);
  });

  it("never leaves the channel's own bucket", () => {
    const buckets = buildSidebarBuckets([ch("a", 0), ch("x", 0, "c1")], [cat("c1", 0)]);
    expect(shape(nudgeChannel(buckets, "a", "down"))).toEqual(["-:a", "c1:x"]);
    expect(shape(nudgeChannel(buckets, "x", "up"))).toEqual(["-:a", "c1:x"]);
  });

  it("canNudgeChannel matches what nudgeChannel would actually do", () => {
    const buckets = base();
    expect(canNudgeChannel(buckets, "a", "up")).toBe(false);
    expect(canNudgeChannel(buckets, "a", "down")).toBe(true);
    expect(canNudgeChannel(buckets, "c", "down")).toBe(false);
    expect(canNudgeChannel(buckets, "missing", "up")).toBe(false);
  });

  it("produces a payload that lists the whole bucket", () => {
    const before = base();
    const after = nudgeChannel(before, "b", "up");
    expect(toChannelOrderEntries(before, after)).toEqual([
      { channelId: "b", categoryId: null },
      { channelId: "a", categoryId: null },
      { channelId: "c", categoryId: null },
    ]);
  });
});

describe("moveCategory / nudgeCategory", () => {
  const ids = ["c1", "c2", "c3"];

  it("moves a category before another", () => {
    expect(moveCategory(ids, "c3", "c1")).toEqual(["c3", "c1", "c2"]);
    expect(moveCategory(ids, "c1", "c3")).toEqual(["c2", "c1", "c3"]);
  });

  it("moves to the end when beforeCategoryId is null", () => {
    expect(moveCategory(ids, "c1", null)).toEqual(["c2", "c3", "c1"]);
  });

  it("is a no-op for a self-drop or an unknown id", () => {
    expect(moveCategory(ids, "c2", "c2")).toEqual(ids);
    expect(moveCategory(ids, "nope", "c1")).toEqual(ids);
  });

  it("appends when the target is unknown rather than reordering blindly", () => {
    expect(moveCategory(ids, "c1", "gone")).toEqual(["c2", "c3", "c1"]);
  });

  it("nudges one slot and stops at the edges", () => {
    expect(nudgeCategory(ids, "c2", "up")).toEqual(["c2", "c1", "c3"]);
    expect(nudgeCategory(ids, "c2", "down")).toEqual(["c1", "c3", "c2"]);
    expect(nudgeCategory(ids, "c1", "up")).toEqual(ids);
    expect(nudgeCategory(ids, "c3", "down")).toEqual(ids);
    expect(nudgeCategory(ids, "missing", "up")).toEqual(ids);
  });

  it("canNudgeCategory matches nudgeCategory", () => {
    expect(canNudgeCategory(ids, "c1", "up")).toBe(false);
    expect(canNudgeCategory(ids, "c1", "down")).toBe(true);
    expect(canNudgeCategory(ids, "c3", "down")).toBe(false);
    expect(canNudgeCategory(ids, "missing", "down")).toBe(false);
  });
});

describe("toReorderPayload", () => {
  const buckets = () =>
    buildSidebarBuckets([ch("a", 0), ch("x", 0, "c1")], [cat("c1", 0), cat("c2", 1)]);

  it("returns null when nothing moved, so the caller skips the request", () => {
    const before = buckets();
    expect(
      toReorderPayload({
        previousBuckets: before,
        nextBuckets: before,
        previousCategoryIds: ["c1", "c2"],
        nextCategoryIds: ["c1", "c2"],
      }),
    ).toBeNull();
  });

  it("carries only the category half when only categories moved", () => {
    const before = buckets();
    expect(
      toReorderPayload({
        previousBuckets: before,
        nextBuckets: before,
        previousCategoryIds: ["c1", "c2"],
        nextCategoryIds: ["c2", "c1"],
      }),
    ).toEqual({ categoryIds: ["c2", "c1"] });
  });

  it("carries only the channel half when only channels moved", () => {
    const before = buckets();
    const after = moveChannel(before, "a", { categoryId: "c1", beforeChannelId: "x" });
    expect(
      toReorderPayload({
        previousBuckets: before,
        nextBuckets: after,
        previousCategoryIds: ["c1", "c2"],
        nextCategoryIds: ["c1", "c2"],
      }),
    ).toEqual({
      channels: [
        { channelId: "a", categoryId: "c1" },
        { channelId: "x", categoryId: "c1" },
      ],
    });
  });

  it("carries both halves in one atomic body when both moved", () => {
    const before = buckets();
    const after = moveChannel(before, "a", { categoryId: "c1", beforeChannelId: null });
    const payload = toReorderPayload({
      previousBuckets: before,
      nextBuckets: after,
      previousCategoryIds: ["c1", "c2"],
      nextCategoryIds: ["c2", "c1"],
    });
    expect(payload).toEqual({
      categoryIds: ["c2", "c1"],
      channels: [
        { channelId: "x", categoryId: "c1" },
        { channelId: "a", categoryId: "c1" },
      ],
    });
  });
});
