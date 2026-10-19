import { describe, expect, it } from "vitest";
import {
  clampAbs,
  containSize,
  panLimit,
  releasePage,
  rubberScale,
  shouldDismiss,
  zoomAbout,
} from "./viewer-math";

describe("containSize", () => {
  it("fits a wide image to the width", () => {
    expect(containSize(2000, 1000, 400, 800)).toEqual({ width: 400, height: 200 });
  });
  it("fits a tall image to the height", () => {
    expect(containSize(1000, 4000, 400, 800)).toEqual({ width: 200, height: 800 });
  });
  it("falls back to the box without dimensions", () => {
    expect(containSize(null, null, 400, 800)).toEqual({ width: 400, height: 800 });
  });
});

describe("panLimit / clampAbs", () => {
  it("is zero until the zoomed picture outgrows the screen", () => {
    expect(panLimit(200, 1.5, 400)).toBe(0);
    expect(panLimit(400, 2, 400)).toBe(200);
  });
  it("clamps both ways", () => {
    expect(clampAbs(250, 200)).toBe(200);
    expect(clampAbs(-250, 200)).toBe(-200);
    expect(clampAbs(50, 200)).toBe(50);
  });
});

describe("zoomAbout", () => {
  it("keeps the focal point fixed", () => {
    // a point 100px right of centre, image untranslated, zoom 1 → 2
    const t1 = zoomAbout(0, 100, 1, 2);
    expect(t1).toBe(-100);
    // the image point that sat under the finger: (100 - t0) / s0 = 100;
    // after: t1 + 100 * 2 = 100 → still under the finger
    expect(t1 + 100 * 2).toBe(100);
  });
  it("zooming about the centre keeps the translation", () => {
    expect(zoomAbout(30, 0, 2, 4)).toBe(60);
  });
});

describe("rubberScale", () => {
  it("passes through the normal range and resists outside it", () => {
    expect(rubberScale(2)).toBe(2);
    expect(rubberScale(0.5)).toBeCloseTo(0.8);
    expect(rubberScale(5)).toBeCloseTo(4.2);
  });
});

describe("releasePage", () => {
  it("advances one page past a third of the width or on a flick", () => {
    expect(releasePage(0, -150, 0, 400, 3)).toBe(1);
    expect(releasePage(1, 20, 800, 400, 3)).toBe(0);
    expect(releasePage(1, -50, 0, 400, 3)).toBe(1);
  });
  it("never runs past the ends", () => {
    expect(releasePage(0, 300, 0, 400, 3)).toBe(0);
    expect(releasePage(2, -300, -900, 400, 3)).toBe(2);
    expect(releasePage(0, -300, 0, 400, 1)).toBe(0);
  });
});

describe("shouldDismiss", () => {
  it("closes on distance or a flick, either way", () => {
    expect(shouldDismiss(130, 0)).toBe(true);
    expect(shouldDismiss(-20, -1000)).toBe(true);
    expect(shouldDismiss(60, 300)).toBe(false);
  });
});
