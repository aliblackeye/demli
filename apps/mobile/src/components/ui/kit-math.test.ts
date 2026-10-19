import { describe, expect, it } from "vitest";
import {
  DISMISS_VELOCITY,
  formatCount,
  fractionOf,
  resolveRelease,
  resolveSnapHeights,
  rubberBand,
  snapToStep,
  valueAt,
  withAlpha,
} from "./kit-math";
import { colors } from "../../theme/theme";

describe("withAlpha", () => {
  it("derives an rgba wash from a hex token", () => {
    expect(withAlpha(colors.danger, 0.2)).toBe("rgba(255,111,181,0.2)");
    // The derived 0.12 wash IS the token the palette already ships.
    expect(withAlpha(colors.accent, 0.12)).toBe(colors.accentSurface);
    expect(withAlpha(colors.danger, 0.12)).toBe(colors.dangerSurface);
  });

  it("clamps alpha and passes non-hex through", () => {
    expect(withAlpha("#000000", 4)).toBe("rgba(0,0,0,1)");
    expect(withAlpha(colors.glass, 0.5)).toBe(colors.glass);
  });
});

describe("formatCount", () => {
  it("renders nothing for zero, negatives and garbage", () => {
    expect(formatCount(0)).toBeNull();
    expect(formatCount(-3)).toBeNull();
    expect(formatCount(Number.NaN)).toBeNull();
  });

  it("caps at max with a plus", () => {
    expect(formatCount(7)).toBe("7");
    expect(formatCount(99)).toBe("99");
    expect(formatCount(100)).toBe("99+");
    expect(formatCount(12, 9)).toBe("9+");
  });
});

describe("slider math", () => {
  it("snaps to the step grid anchored at min", () => {
    expect(snapToStep(47, 0, 100, 5)).toBe(45);
    expect(snapToStep(48, 0, 100, 5)).toBe(50);
    expect(snapToStep(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
    expect(snapToStep(7, 2, 12, 5)).toBe(7);
  });

  it("clamps out-of-range values and degenerate ranges", () => {
    expect(snapToStep(140, 0, 100, 1)).toBe(100);
    expect(snapToStep(-4, 0, 100, 1)).toBe(0);
    expect(snapToStep(5, 3, 3, 1)).toBe(3);
  });

  it("maps a touch position to a stepped value and back", () => {
    expect(valueAt(150, 300, 0, 200, 1)).toBe(100);
    expect(valueAt(-20, 300, 0, 200, 1)).toBe(0);
    expect(valueAt(999, 300, 0, 200, 10)).toBe(200);
    expect(valueAt(10, 0, 0, 200, 1)).toBe(0);
    expect(fractionOf(100, 0, 200)).toBe(0.5);
    expect(fractionOf(250, 0, 200)).toBe(1);
  });
});

describe("sheet snap heights", () => {
  it("uses the measured content height, capped, when no points are given", () => {
    expect(resolveSnapHeights(undefined, 700, 320)).toEqual([320]);
    expect(resolveSnapHeights([], 700, 1200)).toEqual([700]);
  });

  it("resolves px and percent points into ascending unique heights", () => {
    expect(resolveSnapHeights(["90%", 300, "50%"], 800, 0)).toEqual([300, 400, 720]);
    expect(resolveSnapHeights([400, "50%"], 800, 0)).toEqual([400]);
    expect(resolveSnapHeights([2000], 800, 0)).toEqual([800]);
  });
});

describe("sheet release", () => {
  // Two stops: fully open (offset 0) and half (offset 400); closed at 800.
  const offsets = [400, 0];

  it("settles on the nearest stop for a slow release", () => {
    expect(resolveRelease(60, 0, offsets, 800, true)).toBe(1);
    expect(resolveRelease(350, 0, offsets, 800, true)).toBe(0);
  });

  it("lets momentum carry a flick one stop further", () => {
    // Released near the top but thrown down at 1200 px/s → lands on half.
    expect(resolveRelease(100, 1200, offsets, 800, true)).toBe(0);
    // Thrown up from half → opens fully.
    expect(resolveRelease(380, -1500, offsets, 800, true)).toBe(1);
  });

  it("dismisses on a hard downward flick or when dragged past the last stop", () => {
    expect(resolveRelease(10, DISMISS_VELOCITY + 1, offsets, 800, true)).toBe(-1);
    expect(resolveRelease(700, 0, offsets, 800, true)).toBe(-1);
  });

  it("never dismisses a non-dismissible sheet", () => {
    expect(resolveRelease(10, DISMISS_VELOCITY + 500, offsets, 800, false)).toBe(0);
    expect(resolveRelease(790, 0, offsets, 800, false)).toBe(0);
  });

  it("a single-stop menu sheet: small drag snaps back, half drag dismisses", () => {
    expect(resolveRelease(60, 0, [0], 320, true)).toBe(0);
    expect(resolveRelease(200, 0, [0], 320, true)).toBe(-1);
  });
});

describe("rubberBand", () => {
  it("is zero at rest and grows slower than the finger", () => {
    expect(rubberBand(0, 600)).toBe(0);
    expect(rubberBand(-10, 600)).toBe(0);
    const r = rubberBand(100, 600);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(100);
    expect(rubberBand(400, 600) - rubberBand(300, 600)).toBeLessThan(r);
  });
});
