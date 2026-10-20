import { describe, expect, it } from "vitest";
import {
  CROP_ASPECT,
  MAX_ZOOM,
  clampCropState,
  coverScale,
  cropRect,
  imageTransform,
  initialCropState,
  isInitialCrop,
  outputSize,
  panCrop,
  zoomCrop,
  type CropRect,
  type Size,
} from "./image-crop";

const LANDSCAPE: Size = { width: 4000, height: 3000 };
const AVATAR_MASK: Size = { width: 300, height: 300 };
const BANNER_MASK: Size = { width: 480, height: 480 / CROP_ASPECT.banner };

/** The mask is filled iff the crop rect lies inside the image and keeps the mask aspect. */
function expectFilled(rect: CropRect, image: Size, mask: Size): void {
  expect(rect.x).toBeGreaterThanOrEqual(-1e-6);
  expect(rect.y).toBeGreaterThanOrEqual(-1e-6);
  expect(rect.x + rect.width).toBeLessThanOrEqual(image.width + 1e-6);
  expect(rect.y + rect.height).toBeLessThanOrEqual(image.height + 1e-6);
  expect(rect.width / rect.height).toBeCloseTo(mask.width / mask.height, 6);
}

describe("crop geometry", () => {
  it("starts at cover: the whole short side, centred", () => {
    const rect = cropRect(initialCropState(LANDSCAPE), LANDSCAPE, AVATAR_MASK);
    expect(rect).toEqual({ x: 500, y: 0, width: 3000, height: 3000 });
  });

  it("never lets an edge show inside the mask, however far you drag", () => {
    let state = initialCropState(LANDSCAPE);
    state = zoomCrop(state, 2.5, LANDSCAPE, AVATAR_MASK);
    for (const delta of [
      { x: 99_999, y: 0 },
      { x: -99_999, y: 0 },
      { x: 0, y: 99_999 },
      { x: 0, y: -99_999 },
      { x: 12_345, y: -54_321 },
    ]) {
      state = panCrop(state, delta, LANDSCAPE, AVATAR_MASK);
      expectFilled(cropRect(state, LANDSCAPE, AVATAR_MASK), LANDSCAPE, AVATAR_MASK);
    }
  });

  it("dragging right moves the picture right (the crop window moves left)", () => {
    const zoomed = zoomCrop(initialCropState(LANDSCAPE), 2, LANDSCAPE, AVATAR_MASK);
    const moved = panCrop(zoomed, { x: 30, y: 0 }, LANDSCAPE, AVATAR_MASK);
    expect(cropRect(moved, LANDSCAPE, AVATAR_MASK).x).toBeLessThan(
      cropRect(zoomed, LANDSCAPE, AVATAR_MASK).x,
    );
  });

  it("clamps zoom to [1, MAX] and the slider can never zoom out past cover", () => {
    const out = zoomCrop(initialCropState(LANDSCAPE), 0.2, LANDSCAPE, AVATAR_MASK);
    expect(out.zoom).toBe(1);
    const inn = zoomCrop(initialCropState(LANDSCAPE), 40, LANDSCAPE, AVATAR_MASK);
    expect(inn.zoom).toBe(MAX_ZOOM);
  });

  it("zooming about an anchor keeps the source point under the cursor fixed", () => {
    const start = zoomCrop(initialCropState(LANDSCAPE), 1.5, LANDSCAPE, AVATAR_MASK);
    const anchor = { x: 60, y: -40 };
    const before = imageTransform(start, LANDSCAPE, AVATAR_MASK);
    const after = imageTransform(zoomCrop(start, 2.2, LANDSCAPE, AVATAR_MASK, anchor), LANDSCAPE, AVATAR_MASK);
    // Screen position (relative to the mask's top-left) of the anchor point.
    const screen = { x: AVATAR_MASK.width / 2 + anchor.x, y: AVATAR_MASK.height / 2 + anchor.y };
    const sourceBefore = { x: (screen.x - before.x) / before.scale, y: (screen.y - before.y) / before.scale };
    const sourceAfter = { x: (screen.x - after.x) / after.scale, y: (screen.y - after.y) / after.scale };
    expect(sourceAfter.x).toBeCloseTo(sourceBefore.x, 4);
    expect(sourceAfter.y).toBeCloseTo(sourceBefore.y, 4);
  });

  it("zooming out re-clamps a pan that would otherwise leave an empty edge", () => {
    let state = zoomCrop(initialCropState(LANDSCAPE), 4, LANDSCAPE, AVATAR_MASK);
    state = panCrop(state, { x: 99_999, y: 99_999 }, LANDSCAPE, AVATAR_MASK);
    state = zoomCrop(state, 1, LANDSCAPE, AVATAR_MASK);
    expectFilled(cropRect(state, LANDSCAPE, AVATAR_MASK), LANDSCAPE, AVATAR_MASK);
    expect(cropRect(state, LANDSCAPE, AVATAR_MASK).height).toBeCloseTo(3000, 6);
  });

  it("the banner mask keeps the profile card's 8:3 on a portrait photo", () => {
    const portrait: Size = { width: 1080, height: 1920 };
    const rect = cropRect(initialCropState(portrait), portrait, BANNER_MASK);
    expectFilled(rect, portrait, BANNER_MASK);
    expect(rect.width).toBeCloseTo(1080, 6);
    expect(coverScale(portrait, BANNER_MASK)).toBeCloseTo(480 / 1080, 6);
  });

  it("the screen transform puts the chosen centre on the mask centre", () => {
    const state = clampCropState({ zoom: 2, center: { x: 1200, y: 900 } }, LANDSCAPE, AVATAR_MASK);
    const { x, y, scale } = imageTransform(state, LANDSCAPE, AVATAR_MASK);
    expect(x + state.center.x * scale).toBeCloseTo(AVATAR_MASK.width / 2, 6);
    expect(y + state.center.y * scale).toBeCloseTo(AVATAR_MASK.height / 2, 6);
  });

  it("is resize-proof: the same state crops the same source rect at any mask size", () => {
    const state = zoomCrop(initialCropState(LANDSCAPE), 2, LANDSCAPE, AVATAR_MASK);
    const a = cropRect(state, LANDSCAPE, AVATAR_MASK);
    const b = cropRect(state, LANDSCAPE, { width: 180, height: 180 });
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.width).toBeCloseTo(a.width, 6);
  });

  it("knows when Reset has nothing to do", () => {
    const initial = initialCropState(LANDSCAPE);
    expect(isInitialCrop(initial, LANDSCAPE, AVATAR_MASK)).toBe(true);
    expect(isInitialCrop(zoomCrop(initial, 1.3, LANDSCAPE, AVATAR_MASK), LANDSCAPE, AVATAR_MASK)).toBe(false);
  });
});

describe("export size", () => {
  it("exports a 512² avatar from a big photo", () => {
    expect(outputSize({ x: 0, y: 0, width: 3000, height: 3000 }, "avatar")).toEqual({ width: 512, height: 512 });
  });

  it("never upscales a small crop", () => {
    expect(outputSize({ x: 0, y: 0, width: 300, height: 300 }, "avatar")).toEqual({ width: 300, height: 300 });
  });

  it("keeps a usable floor for a tiny source", () => {
    expect(outputSize({ x: 0, y: 0, width: 40, height: 40 }, "avatar")).toEqual({ width: 128, height: 128 });
  });

  it("exports the banner at exactly 8:3", () => {
    expect(outputSize({ x: 0, y: 0, width: 4000, height: 1500 }, "banner")).toEqual({ width: 1200, height: 450 });
    const small = outputSize({ x: 0, y: 0, width: 640, height: 240 }, "banner");
    expect(small.width / small.height).toBeCloseTo(8 / 3, 2);
  });
});
