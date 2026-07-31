import { describe, expect, it } from "vitest";
import {
  clampPipAspect,
  isInPipWindow,
  PIP_LANDSCAPE_ASPECT,
  PIP_MAX_ASPECT,
  PIP_MIN_ASPECT,
  PIP_OBJECT_FIT,
  PIP_PORTRAIT_ASPECT,
  PIP_TALLEST_ASPECT,
  PIP_WIDEST_ASPECT,
  resolvePipAspect,
  shouldShowPipOverlay,
} from "./pip-overlay";

/**
 * The PiP overlay is a full-screen black cover that must appear ONLY while the
 * OS has us shrunk into a PiP window with a camera to show. These cases pin the
 * "black screen on resume" regression: a stale-true `isInPipMode` must NEVER
 * keep the cover up once the app is back in the foreground.
 */
describe("shouldShowPipOverlay", () => {
  it("shows only while backgrounded, in PiP, with a camera to render", () => {
    expect(
      shouldShowPipOverlay({ isInPipMode: true, appActive: false, hasCameraTrack: true }),
    ).toBe(true);
  });

  it("REGRESSION: never covers the app once foregrounded, even if isInPipMode is stale-true", () => {
    // The exact black-screen-on-resume bug: expo-pip left isInPipMode true after
    // the PiP window was expanded back to full screen. The foreground guard wins.
    expect(
      shouldShowPipOverlay({ isInPipMode: true, appActive: true, hasCameraTrack: true }),
    ).toBe(false);
  });

  it("never shows a black cover with no camera to render (pure audio / camera off mid-PiP)", () => {
    expect(
      shouldShowPipOverlay({ isInPipMode: true, appActive: false, hasCameraTrack: false }),
    ).toBe(false);
    // Foregrounded + no track: doubly hidden.
    expect(
      shouldShowPipOverlay({ isInPipMode: true, appActive: true, hasCameraTrack: false }),
    ).toBe(false);
  });

  it("never shows when the OS is not in PiP mode", () => {
    expect(
      shouldShowPipOverlay({ isInPipMode: false, appActive: false, hasCameraTrack: true }),
    ).toBe(false);
    expect(
      shouldShowPipOverlay({ isInPipMode: false, appActive: true, hasCameraTrack: true }),
    ).toBe(false);
  });
});

/**
 * The same predicate without the track requirement — it also decides whether the
 * fullscreen `<Modal>` must dismiss itself (a Modal is a separate native window
 * that the PiP capture of the activity does not include).
 */
describe("isInPipWindow", () => {
  it("is true only while the OS says PiP and the app is backgrounded", () => {
    expect(isInPipWindow({ isInPipMode: true, appActive: false })).toBe(true);
    expect(isInPipWindow({ isInPipMode: true, appActive: true })).toBe(false);
    expect(isInPipWindow({ isInPipMode: false, appActive: false })).toBe(false);
    expect(isInPipWindow({ isInPipMode: false, appActive: true })).toBe(false);
  });
});

/**
 * The founder's report: the PiP window "yatay duruyor, dikey değil" and the person
 * in it is "yarım bi şey" — a portrait phone camera forced into a hardcoded 16:9
 * window and then cropped by `objectFit: cover`. These cases pin the shape policy.
 */
describe("resolvePipAspect", () => {
  it("gives a camera a PORTRAIT window (the founder's dikey requirement)", () => {
    expect(resolvePipAspect({ kind: "camera" })).toEqual(PIP_PORTRAIT_ASPECT);
    expect(PIP_PORTRAIT_ASPECT.width / PIP_PORTRAIT_ASPECT.height).toBeLessThan(1);
  });

  it("gives a screen share a LANDSCAPE window", () => {
    expect(resolvePipAspect({ kind: "screen" })).toEqual(PIP_LANDSCAPE_ASPECT);
    expect(PIP_LANDSCAPE_ASPECT.width / PIP_LANDSCAPE_ASPECT.height).toBeGreaterThan(1);
  });

  it("defaults to portrait when there is no subject kind yet", () => {
    expect(resolvePipAspect({ kind: null })).toEqual(PIP_PORTRAIT_ASPECT);
    expect(resolvePipAspect({ kind: null, measured: null })).toEqual(PIP_PORTRAIT_ASPECT);
  });

  it("lets a measured (rotation-aware) aspect win over the default", () => {
    expect(resolvePipAspect({ kind: "camera", measured: { width: 1280, height: 720 } })).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("clamps a measured aspect into the range Android accepts", () => {
    // A 1:5 measurement would make setAspectRatio throw and leave the window on
    // its PREVIOUS (wrong) shape, so it is snapped to the tallest legal ratio.
    expect(resolvePipAspect({ kind: "camera", measured: { width: 100, height: 500 } })).toEqual(
      PIP_TALLEST_ASPECT,
    );
  });
});

describe("clampPipAspect", () => {
  it("keeps ratios inside Android's [1/2.39, 2.39] window untouched", () => {
    expect(clampPipAspect({ width: 9, height: 16 })).toEqual({ width: 9, height: 16 });
    expect(clampPipAspect({ width: 16, height: 9 })).toEqual({ width: 16, height: 9 });
    expect(clampPipAspect({ width: 1080, height: 2400 })).toEqual({ width: 1080, height: 2400 });
  });

  it("snaps out-of-range ratios to the legal extremes", () => {
    expect(clampPipAspect({ width: 1, height: 10 })).toEqual(PIP_TALLEST_ASPECT);
    expect(clampPipAspect({ width: 32, height: 9 })).toEqual(PIP_WIDEST_ASPECT);
    // And the extremes themselves are legal (they are what we hand the OS).
    const tallest = PIP_TALLEST_ASPECT.width / PIP_TALLEST_ASPECT.height;
    const widest = PIP_WIDEST_ASPECT.width / PIP_WIDEST_ASPECT.height;
    expect(tallest).toBeGreaterThanOrEqual(PIP_MIN_ASPECT);
    expect(widest).toBeLessThanOrEqual(PIP_MAX_ASPECT);
  });

  it("rounds to integers — Android's Rational takes ints only", () => {
    expect(clampPipAspect({ width: 16.4, height: 9.2 })).toEqual({ width: 16, height: 9 });
  });

  it("falls back to portrait on garbage instead of throwing", () => {
    expect(clampPipAspect({ width: 0, height: 0 })).toEqual(PIP_PORTRAIT_ASPECT);
    expect(clampPipAspect({ width: -16, height: 9 })).toEqual(PIP_PORTRAIT_ASPECT);
    expect(clampPipAspect({ width: Number.NaN, height: 16 })).toEqual(PIP_PORTRAIT_ASPECT);
    expect(clampPipAspect({ width: Number.POSITIVE_INFINITY, height: 16 })).toEqual(
      PIP_PORTRAIT_ASPECT,
    );
  });
});

describe("PIP_OBJECT_FIT", () => {
  it("is contain — cover is what cropped the founder's view into half a face", () => {
    expect(PIP_OBJECT_FIT).toBe("contain");
  });
});
