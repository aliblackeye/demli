import { describe, expect, it } from "vitest";
import { BANNER_SWIPE_DISTANCE, BANNER_SWIPE_VELOCITY, bannerRelease } from "./in-app-banner-gesture";

describe("in-app banner release", () => {
  it("restarts the timer after a pan that never activated (sideways swipe / OS cancel)", () => {
    // The audit case: the timer was paused on touch-down and only onEnd re-armed it,
    // which RNGH never calls for a failed pan — the banner then stayed up forever.
    expect(bannerRelease(false, 0, 0)).toBe("rearm");
    expect(bannerRelease(false, 4, 0)).toBe("rearm");
  });

  it("never dismisses from a cancelled pan, however far up it had moved", () => {
    expect(bannerRelease(false, -BANNER_SWIPE_DISTANCE * 3, -BANNER_SWIPE_VELOCITY * 2)).toBe("rearm");
  });

  it("dismisses an activated pan past the distance or the speed", () => {
    expect(bannerRelease(true, -BANNER_SWIPE_DISTANCE - 1, 0)).toBe("dismiss");
    expect(bannerRelease(true, -4, -BANNER_SWIPE_VELOCITY - 1)).toBe("dismiss");
  });

  it("springs back and restarts the timer for a short drag or a downward pull", () => {
    expect(bannerRelease(true, -BANNER_SWIPE_DISTANCE + 1, 0)).toBe("rearm");
    expect(bannerRelease(true, 40, 300)).toBe("rearm");
  });
});
