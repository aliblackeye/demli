import { describe, expect, it } from "vitest";
import { SubscriptionRegistry } from "../subscriptions.js";

describe("SubscriptionRegistry", () => {
  it("routes subscribers per channel", () => {
    const registry = new SubscriptionRegistry<string>();
    registry.add("connA", ["ch1", "ch2"]);
    registry.add("connB", ["ch2"]);

    expect([...registry.subscribers("ch1")]).toEqual(["connA"]);
    expect([...registry.subscribers("ch2")].sort()).toEqual(["connA", "connB"]);
    expect([...registry.subscribers("nope")]).toEqual([]);
    expect(registry.isSubscribed("connA", "ch1")).toBe(true);
    expect(registry.isSubscribed("connB", "ch1")).toBe(false);
  });

  it("removes a connection from every channel", () => {
    const registry = new SubscriptionRegistry<string>();
    registry.add("connA", ["ch1", "ch2"]);
    registry.add("connB", ["ch1"]);
    registry.remove("connA");

    expect([...registry.subscribers("ch1")]).toEqual(["connB"]);
    expect([...registry.subscribers("ch2")]).toEqual([]);
    expect(registry.isSubscribed("connA", "ch1")).toBe(false);
    // removing twice is harmless
    registry.remove("connA");
  });

  it("partially removes only the named channels (visibility resync)", () => {
    const registry = new SubscriptionRegistry<string>();
    registry.add("connA", ["ch1", "ch2", "ch3"]);
    registry.add("connB", ["ch2"]);

    registry.remove("connA", ["ch1", "ch3"]);
    expect(registry.isSubscribed("connA", "ch1")).toBe(false);
    expect(registry.isSubscribed("connA", "ch3")).toBe(false);
    expect(registry.isSubscribed("connA", "ch2")).toBe(true);
    // ch2 still routes to both; ch1 is now empty.
    expect([...registry.subscribers("ch2")].sort()).toEqual(["connA", "connB"]);
    expect([...registry.subscribers("ch1")]).toEqual([]);

    // Removing a channel the connection no longer holds is harmless.
    registry.remove("connA", ["ch1"]);
    // Removing its last channel drops the connection entirely.
    registry.remove("connA", ["ch2"]);
    expect(registry.isSubscribed("connA", "ch2")).toBe(false);
    expect([...registry.subscribers("ch2")]).toEqual(["connB"]);
  });
});
