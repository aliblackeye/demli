import { describe, expect, it } from "vitest";
import {
  VOICE_MINI_BAR_HEIGHT,
  bottomChromeClearance,
  floatingBottom,
  hasLiveVoiceBarSession,
  isVoiceMiniBarShown,
  voiceMiniBarBottom,
} from "./bottom-chrome";
import { TAB_BAR_CONTENT_HEIGHT } from "./tab-bar";
import { TAB_PILL_HEIGHT } from "../components/home/shell-math";

/** A vertical span measured UP from the screen bottom: [bottom, top). */
type Span = { bottom: number; top: number };
const overlaps = (a: Span, b: Span) => a.bottom < b.top && b.bottom < a.top;

/** Where the VoiceMiniBar actually draws (it positions itself with voiceMiniBarBottom). */
const voiceBar = (insetsBottom: number, onTabRoute: boolean): Span => {
  const bottom = voiceMiniBarBottom(insetsBottom, onTabRoute);
  return { bottom, top: bottom + VOICE_MINI_BAR_HEIGHT };
};

/** The floating tab pill: it fills the bar's content height above the safe area. */
const tabPill = (insetsBottom: number): Span => ({
  bottom: insetsBottom + (TAB_BAR_CONTENT_HEIGHT - TAB_PILL_HEIGHT),
  top: insetsBottom + TAB_BAR_CONTENT_HEIGHT,
});

const NEW_DM_FAB_SIZE = 56;
/** The update pill's own height is variable; one text line + its padding is the floor. */
const UPDATE_PILL_MIN_HEIGHT = 56;

describe.each([0, 24, 48])("bottom chrome with a %ipx safe area", (insetsBottom) => {
  it("stacks the voice bar on top of the tab pill, never over it", () => {
    expect(overlaps(voiceBar(insetsBottom, true), tabPill(insetsBottom))).toBe(false);
  });

  it("keeps the new-DM button out from under the voice bar during a call", () => {
    const clearance = bottomChromeClearance({ insetsBottom, onTabRoute: true, voiceBarShown: true });
    const bottom = floatingBottom(clearance);
    const fab = { bottom, top: bottom + NEW_DM_FAB_SIZE };
    expect(overlaps(fab, voiceBar(insetsBottom, true))).toBe(false);
    expect(fab.bottom).toBeGreaterThanOrEqual(voiceBar(insetsBottom, true).top);
  });

  it("keeps the new-DM button off the tab pill with no call", () => {
    const clearance = bottomChromeClearance({ insetsBottom, onTabRoute: true, voiceBarShown: false });
    const bottom = floatingBottom(clearance);
    expect(overlaps({ bottom, top: bottom + NEW_DM_FAB_SIZE }, tabPill(insetsBottom))).toBe(false);
  });

  it("lets the last row of a tab list scroll clear of the voice bar", () => {
    // A list's bottom padding is at least the clearance: its last row ends at or above it.
    const padding = bottomChromeClearance({ insetsBottom, onTabRoute: true, voiceBarShown: true });
    expect(padding).toBeGreaterThanOrEqual(voiceBar(insetsBottom, true).top);
  });

  it.each([true, false])("stacks the update pill above the voice bar (tab route: %s)", (onTabRoute) => {
    const clearance = bottomChromeClearance({ insetsBottom, onTabRoute, voiceBarShown: true });
    const bottom = floatingBottom(clearance);
    const pill = { bottom, top: bottom + UPDATE_PILL_MIN_HEIGHT };
    expect(overlaps(pill, voiceBar(insetsBottom, onTabRoute))).toBe(false);
    if (onTabRoute) expect(overlaps(pill, tabPill(insetsBottom))).toBe(false);
  });

  it("reserves only the tab pill (plus safe area) when no call is up", () => {
    expect(bottomChromeClearance({ insetsBottom, onTabRoute: true, voiceBarShown: false })).toBe(
      insetsBottom + TAB_BAR_CONTENT_HEIGHT,
    );
    expect(bottomChromeClearance({ insetsBottom, onTabRoute: false, voiceBarShown: false })).toBe(
      insetsBottom,
    );
  });
});

describe("voice bar visibility (shared by the bar and everything that clears it)", () => {
  it("shows for a live voice-channel session off the voice room", () => {
    for (const status of ["joining", "connected", "reconnecting", "error"] as const) {
      expect(isVoiceMiniBarShown("chan_1", status, "/groups")).toBe(true);
    }
  });

  it("hides with no session, when idle or leaving, on the voice room, and for a DM call", () => {
    expect(isVoiceMiniBarShown(null, "connected", "/groups")).toBe(false);
    expect(isVoiceMiniBarShown("chan_1", "idle", "/groups")).toBe(false);
    expect(isVoiceMiniBarShown("chan_1", "leaving", "/groups")).toBe(false);
    expect(isVoiceMiniBarShown("chan_1", "connected", "/voice/chan_1")).toBe(false);
    expect(isVoiceMiniBarShown("dmcall:abc", "connected", "/groups")).toBe(false);
  });

  it("the route-free form (tab screens) agrees on everything but the route", () => {
    expect(hasLiveVoiceBarSession("chan_1", "connected")).toBe(true);
    expect(hasLiveVoiceBarSession("dmcall:abc", "connected")).toBe(false);
    expect(hasLiveVoiceBarSession("chan_1", "idle")).toBe(false);
  });
});
