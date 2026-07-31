import { describe, expect, it } from "vitest";
import { LastSeenThrottle } from "../lib/last-seen-throttle.js";

describe("LastSeenThrottle", () => {
  it("allows the first touch and suppresses repeats inside the window", () => {
    let now = 1_000;
    const throttle = new LastSeenThrottle(5 * 60_000, () => now);

    expect(throttle.shouldTouch("s1")).toBe(true);
    expect(throttle.shouldTouch("s1")).toBe(false);
    now += 60_000; // 1 min later, still inside the 5-min window
    expect(throttle.shouldTouch("s1")).toBe(false);
  });

  it("allows another touch once the window has fully elapsed", () => {
    let now = 0;
    const throttle = new LastSeenThrottle(5 * 60_000, () => now);

    expect(throttle.shouldTouch("s1")).toBe(true);
    now += 5 * 60_000; // exactly the window ⇒ allowed again
    expect(throttle.shouldTouch("s1")).toBe(true);
    expect(throttle.shouldTouch("s1")).toBe(false);
  });

  it("tracks sessions independently", () => {
    const now = 42;
    const throttle = new LastSeenThrottle(5 * 60_000, () => now);

    expect(throttle.shouldTouch("a")).toBe(true);
    expect(throttle.shouldTouch("b")).toBe(true);
    expect(throttle.shouldTouch("a")).toBe(false);
    expect(throttle.shouldTouch("b")).toBe(false);
  });

  it("prunes elapsed entries when the map exceeds its cap", () => {
    let now = 0;
    // Cap of 2 so the third distinct session forces a prune.
    const throttle = new LastSeenThrottle(1_000, () => now, 2);

    expect(throttle.shouldTouch("old-1")).toBe(true);
    expect(throttle.shouldTouch("old-2")).toBe(true);
    now += 2_000; // both entries are now past the window
    // Adding a third triggers a prune of the two elapsed entries; the new one
    // is recorded, and re-touching it stays suppressed.
    expect(throttle.shouldTouch("new")).toBe(true);
    expect(throttle.shouldTouch("new")).toBe(false);
    // The pruned old sessions would touch again (their record is gone), proving
    // the prune ran rather than the map growing unbounded.
    expect(throttle.shouldTouch("old-1")).toBe(true);
  });
});
