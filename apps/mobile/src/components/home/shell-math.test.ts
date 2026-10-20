import { describe, expect, it } from "vitest";
import { TAB_BAR_CONTENT_HEIGHT } from "../../lib/tab-bar";
import {
  RAIL_PILL,
  TAB_PILL_HEIGHT,
  TAB_PILL_PAD,
  railPillKind,
  tabIndicatorX,
  tabSlotWidth,
} from "./shell-math";

describe("tab bar indicator geometry", () => {
  it("splits the pill's inner width evenly between the tabs", () => {
    // 3 tabs in a 344px pill: (344 - 2*4) / 3 = 112.
    expect(tabSlotWidth(344, 3)).toBe(112);
  });

  it("has no slot before the pill is measured, so the indicator stays unmounted", () => {
    expect(tabSlotWidth(0, 3)).toBe(0);
    expect(tabSlotWidth(344, 0)).toBe(0);
    expect(tabIndicatorX(2, 0, 3)).toBe(0);
  });

  it("puts the indicator under the chosen tab", () => {
    expect(tabIndicatorX(0, 344, 3)).toBe(0);
    expect(tabIndicatorX(1, 344, 3)).toBe(112);
    expect(tabIndicatorX(2, 344, 3)).toBe(224);
  });

  it("clamps an out-of-range index instead of sliding off the pill", () => {
    expect(tabIndicatorX(7, 344, 3)).toBe(224);
    expect(tabIndicatorX(-1, 344, 3)).toBe(0);
  });

  it("fits the floating pill inside the tab bar's content height", () => {
    // The voice bar stacks at TAB_BAR_CONTENT_HEIGHT above the safe area, so a
    // taller pill would sit under it. The rest of the bottom chrome (voice bar,
    // new-DM button, update pill, list padding) is pinned in lib/bottom-chrome.test.
    expect(TAB_PILL_HEIGHT).toBeLessThanOrEqual(TAB_BAR_CONTENT_HEIGHT);
    // A tab is still a 44pt target inside the pill's padding.
    expect(TAB_PILL_HEIGHT - TAB_PILL_PAD * 2).toBeGreaterThanOrEqual(44);
  });
});

describe("rail edge pill", () => {
  it("speaks the desktop rail's three states", () => {
    expect(railPillKind(true, false)).toBe("selected");
    expect(railPillKind(false, true)).toBe("unread");
    expect(railPillKind(false, false)).toBe("idle");
  });

  it("never shows the unread step on the server you are already looking at", () => {
    expect(railPillKind(true, true)).toBe("selected");
  });

  it("matches the desktop heights: tall coral 36, short white 8, none", () => {
    expect(RAIL_PILL).toEqual({ selected: 36, unread: 8, idle: 0 });
  });
});
