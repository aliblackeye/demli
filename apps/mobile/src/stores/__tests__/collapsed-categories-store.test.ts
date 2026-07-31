/**
 * Collapsed categories must survive a relaunch, and must never take the channel
 * list down with them.
 *
 * The store is fed by SecureStore, which returns whatever was written last —
 * including a blob from an older build, a half-written value, or (on a device
 * where the keystore misbehaved) something that is not a map at all. The channel
 * list reads this on its very first render, so a normalizer that throws is a
 * blank server screen rather than a forgotten chevron.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  MAX_TRACKED_SERVERS,
  normalizeCollapsedMap,
  toggleCollapsed,
  useCollapsedCategoriesStore,
} from "../collapsed-categories-store";

beforeEach(() => {
  useCollapsedCategoriesStore.setState({ collapsed: {} });
});

describe("a collapse is remembered, per server", () => {
  it("round-trips a toggle through the store", () => {
    const { toggle, isCollapsed } = useCollapsedCategoriesStore.getState();
    expect(isCollapsed("g1", "cat-a")).toBe(false);

    toggle("g1", "cat-a");
    expect(useCollapsedCategoriesStore.getState().isCollapsed("g1", "cat-a")).toBe(true);

    toggle("g1", "cat-a");
    expect(useCollapsedCategoriesStore.getState().isCollapsed("g1", "cat-a")).toBe(false);
  });

  it("keeps one server's collapsed sections out of another's", () => {
    const { toggle } = useCollapsedCategoriesStore.getState();
    toggle("g1", "cat-a");
    const state = useCollapsedCategoriesStore.getState();
    expect(state.isCollapsed("g1", "cat-a")).toBe(true);
    expect(state.isCollapsed("g2", "cat-a")).toBe(false);
  });

  it("persists what the middleware will write — the map itself", () => {
    const next = toggleCollapsed({}, "g1", "cat-a");
    expect(next).toEqual({ g1: ["cat-a"] });
    // Collapsing everything then re-expanding must not leave an empty list
    // behind, which would spend the storage budget on nothing.
    expect(toggleCollapsed(next, "g1", "cat-a")).toEqual({});
  });

  it("never records the same category twice", () => {
    const once = toggleCollapsed({ g1: ["cat-a", "cat-a"] }, "g1", "cat-b");
    expect(once.g1).toEqual(["cat-a", "cat-b"]);
  });
});

describe("a corrupt or legacy blob degrades to 'nothing collapsed'", () => {
  it("rejects non-objects outright", () => {
    expect(normalizeCollapsedMap(null)).toEqual({});
    expect(normalizeCollapsedMap(undefined)).toEqual({});
    expect(normalizeCollapsedMap("v1")).toEqual({});
    expect(normalizeCollapsedMap(42)).toEqual({});
    expect(normalizeCollapsedMap(["cat-a"])).toEqual({});
  });

  it("drops entries whose value is not a list of ids", () => {
    expect(normalizeCollapsedMap({ g1: "cat-a", g2: ["cat-b"] })).toEqual({ g2: ["cat-b"] });
    expect(normalizeCollapsedMap({ g1: [1, null, "cat-b", ""] })).toEqual({ g1: ["cat-b"] });
  });

  it("drops servers with an empty list rather than storing the default state", () => {
    expect(normalizeCollapsedMap({ g1: [], g2: ["cat-a"] })).toEqual({ g2: ["cat-a"] });
  });

  it("caps how many servers are tracked, so the write cannot outgrow SecureStore", () => {
    const oversized: Record<string, string[]> = {};
    for (let i = 0; i < MAX_TRACKED_SERVERS + 15; i += 1) oversized[`g${i}`] = ["cat-a"];
    expect(Object.keys(normalizeCollapsedMap(oversized))).toHaveLength(MAX_TRACKED_SERVERS);
  });
});
