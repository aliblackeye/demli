/**
 * The category rules BOTH clients read (M18 + its mobile parity).
 *
 * `packages/app-ui/src/components/channelOrder.test.ts` already covers the
 * placement arithmetic in depth through the re-export; this suite locks the two
 * things the mobile wave depends on and that a renderer must never re-decide:
 *
 *  1. Uncategorized channels come FIRST, always — the top-level list is bucket 0
 *     on every surface, so a pre-M18 server looks unchanged and a channel whose
 *     category vanished stays reachable instead of disappearing.
 *  2. Management entries are ABSENT for a viewer without owner ∨ MANAGE_CHANNELS,
 *     not merely disabled (§35). That is the assertion "an unauthorized user
 *     cannot create or delete a category" reduces to on the client — the API
 *     re-checks it for real (§28).
 */

import { describe, expect, it } from "vitest";
import type { CategoryId, Channel, ChannelCategory, ChannelId } from "@demli/types";
import {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  categoryMenuItems,
  channelMoveDestinations,
  channelPlacementMenuItems,
  isDestructiveCategoryMenuItem,
  nudgeChannel,
  toReorderPayload,
} from "../channel-order.js";

const category = (id: string, position: number, name = id): ChannelCategory => ({
  id: id as CategoryId,
  groupId: "g1" as ChannelCategory["groupId"],
  name,
  position,
  createdAt: "2026-07-01T00:00:00.000Z",
});

const channel = (
  id: string,
  position: number,
  categoryId: string | null = null,
): Channel =>
  ({
    id: id as ChannelId,
    groupId: "g1",
    name: id,
    kind: "text",
    position,
    categoryId: categoryId as CategoryId | null,
    createdAt: "2026-07-01T00:00:00.000Z",
  }) as unknown as Channel;

describe("uncategorized channels sit at the top", () => {
  it("puts the uncategorized bucket first even when categories exist", () => {
    const buckets = buildSidebarBuckets(
      [channel("c1", 0, "cat-a"), channel("c2", 0), channel("c3", 1)],
      [category("cat-a", 0)],
    );

    expect(buckets[0]?.category).toBeNull();
    expect(buckets[0]?.channels.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(buckets[1]?.category?.id).toBe("cat-a");
  });

  it("keeps the uncategorized bucket first on a server with no categories", () => {
    const buckets = buildSidebarBuckets([channel("c1", 0)], []);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.category).toBeNull();
  });

  it("returns a channel whose category is missing to the top bucket, never drops it", () => {
    // A category deleted between two fetches: the channel must stay reachable.
    const buckets = buildSidebarBuckets([channel("orphan", 0, "gone")], [category("cat-a", 0)]);
    expect(buckets[0]?.channels.map((c) => c.id)).toEqual(["orphan"]);
    expect(buckets[1]?.channels).toEqual([]);
  });

  it("orders categories by position, not by insertion", () => {
    const buckets = buildSidebarBuckets([], [category("late", 5), category("early", 1)]);
    expect(buckets.map((b) => b.category?.id ?? null)).toEqual([null, "early", "late"]);
  });
});

describe("an unauthorized viewer gets no category management at all", () => {
  const noPermission = { canManageChannels: false, canMoveUp: true, canMoveDown: true };

  it("offers an EMPTY category menu — no create, no rename, no delete", () => {
    expect(categoryMenuItems(noPermission)).toEqual([]);
  });

  it("offers no placement entries on a channel row either", () => {
    expect(
      channelPlacementMenuItems({
        canManageChannels: false,
        canMoveUp: true,
        canMoveDown: true,
        hasOtherBuckets: true,
      }),
    ).toEqual([]);
  });

  it("gives an authorized viewer create/rename/delete", () => {
    const items = categoryMenuItems({
      canManageChannels: true,
      canMoveUp: false,
      canMoveDown: false,
    });
    expect(items).toContain("createChannel");
    expect(items).toContain("rename");
    expect(items).toContain("delete");
  });

  it("marks only delete as destructive", () => {
    expect(isDestructiveCategoryMenuItem("delete")).toBe(true);
    expect(isDestructiveCategoryMenuItem("rename")).toBe(false);
  });
});

describe("move entries appear only where they would do something", () => {
  it("hides 'move up' on the first category and 'move down' on the last", () => {
    const ids = ["a", "b", "c"] as CategoryId[];
    expect(canNudgeCategory(ids, "a" as CategoryId, "up")).toBe(false);
    expect(canNudgeCategory(ids, "c" as CategoryId, "down")).toBe(false);

    const first = categoryMenuItems({
      canManageChannels: true,
      canMoveUp: canNudgeCategory(ids, "a" as CategoryId, "up"),
      canMoveDown: canNudgeCategory(ids, "a" as CategoryId, "down"),
    });
    expect(first).not.toContain("moveUp");
    expect(first).toContain("moveDown");
  });

  it("hides 'move to category' when the channel's bucket is the only one", () => {
    const buckets = buildSidebarBuckets([channel("c1", 0)], []);
    expect(channelMoveDestinations(buckets, "c1" as ChannelId)).toEqual([]);
    expect(
      channelPlacementMenuItems({
        canManageChannels: true,
        canMoveUp: false,
        canMoveDown: false,
        hasOtherBuckets: channelMoveDestinations(buckets, "c1" as ChannelId).length > 0,
      }),
    ).toEqual([]);
  });

  it("never offers the bucket the channel is already in as a destination", () => {
    const buckets = buildSidebarBuckets(
      [channel("c1", 0, "cat-a")],
      [category("cat-a", 0), category("cat-b", 1)],
    );
    const destinations = channelMoveDestinations(buckets, "c1" as ChannelId);
    expect(destinations.map((d) => d.categoryId)).toEqual([null, "cat-b"]);
  });
});

describe("a nudge sends a payload the server can apply without collisions", () => {
  it("lists the whole changed bucket, in its new order", () => {
    const previous = buildSidebarBuckets(
      [channel("c1", 0), channel("c2", 1), channel("c3", 2)],
      [],
    );
    const next = nudgeChannel(previous, "c3" as ChannelId, "up");

    expect(canNudgeChannel(previous, "c3" as ChannelId, "up")).toBe(true);
    expect(next[0]?.channels.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);

    const payload = toReorderPayload({
      previousBuckets: previous,
      nextBuckets: next,
      previousCategoryIds: [],
      nextCategoryIds: [],
    });
    // All three ids, not just the moved one — a partial bucket would renumber
    // from 0 and collide with the untouched neighbours.
    expect(payload?.channels?.map((e) => e.channelId)).toEqual(["c1", "c3", "c2"]);
    expect(payload?.channels?.every((e) => e.categoryId === null)).toBe(true);
  });

  it("produces no request at all when nothing moved", () => {
    const buckets = buildSidebarBuckets([channel("c1", 0)], []);
    expect(
      toReorderPayload({
        previousBuckets: buckets,
        nextBuckets: nudgeChannel(buckets, "c1" as ChannelId, "up"),
        previousCategoryIds: [],
        nextCategoryIds: [],
      }),
    ).toBeNull();
  });
});
