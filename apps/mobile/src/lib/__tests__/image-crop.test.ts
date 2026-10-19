import { describe, expect, it } from "vitest";
import {
  CROP_ASPECT,
  CROP_OUTPUT,
  MAX_ZOOM,
  MIN_ZOOM,
  clampCropState,
  coverScale,
  cropRect,
  editingResize,
  imageTransform,
  initialCropState,
  isInitialCrop,
  maskSizeFor,
  outputSize,
  panCrop,
  pixelCropRect,
  zoomCrop,
  type CropState,
  type Size,
} from "../image-crop";

const LANDSCAPE: Size = { width: 2000, height: 1000 };
const PORTRAIT: Size = { width: 900, height: 1600 };
const CIRCLE: Size = { width: 300, height: 300 };
const BANNER: Size = { width: 360, height: 135 };

/** The mask is filled iff the crop rect lies inside the image. */
function assertFilled(state: CropState, image: Size, mask: Size) {
  const r = cropRect(state, image, mask);
  expect(r.x).toBeGreaterThanOrEqual(-1e-6);
  expect(r.y).toBeGreaterThanOrEqual(-1e-6);
  expect(r.x + r.width).toBeLessThanOrEqual(image.width + 1e-6);
  expect(r.y + r.height).toBeLessThanOrEqual(image.height + 1e-6);
  // …and it has the mask's aspect, so nothing is stretched on export.
  expect(r.width / r.height).toBeCloseTo(mask.width / mask.height, 5);
}

describe("crop geometry — the mask is always filled", () => {
  it("starts centred at cover", () => {
    const s = clampCropState(initialCropState(LANDSCAPE), LANDSCAPE, CIRCLE);
    expect(s.zoom).toBe(MIN_ZOOM);
    expect(s.center).toEqual({ x: 1000, y: 500 });
    // Cover: the SHORT side spans the circle exactly.
    expect(cropRect(s, LANDSCAPE, CIRCLE).height).toBeCloseTo(1000, 6);
    assertFilled(s, LANDSCAPE, CIRCLE);
  });

  it("cannot zoom out past cover or in past the cap", () => {
    const base = initialCropState(PORTRAIT);
    expect(zoomCrop(base, 0.2, PORTRAIT, CIRCLE).zoom).toBe(MIN_ZOOM);
    expect(zoomCrop(base, 99, PORTRAIT, CIRCLE).zoom).toBe(MAX_ZOOM);
    expect(clampCropState({ zoom: Number.NaN, center: { x: 1, y: 1 } }, PORTRAIT, CIRCLE).zoom).toBe(MIN_ZOOM);
  });

  it("a drag far past any edge stops at that edge", () => {
    let s = zoomCrop(initialCropState(LANDSCAPE), 2, LANDSCAPE, CIRCLE);
    for (const delta of [
      { x: 50_000, y: 0 },
      { x: -50_000, y: 0 },
      { x: 0, y: 50_000 },
      { x: 0, y: -50_000 },
      { x: 9_999, y: -9_999 },
    ]) {
      s = panCrop(s, delta, LANDSCAPE, CIRCLE);
      assertFilled(s, LANDSCAPE, CIRCLE);
    }
  });

  it("dragging right moves the picture right (shows more of its left side)", () => {
    const s = zoomCrop(initialCropState(LANDSCAPE), 2, LANDSCAPE, CIRCLE);
    const moved = panCrop(s, { x: 30, y: 0 }, LANDSCAPE, CIRCLE);
    expect(moved.center.x).toBeLessThan(s.center.x);
  });

  it("pinch keeps the point between the fingers under the fingers", () => {
    const s = initialCropState(LANDSCAPE);
    const anchor = { x: 60, y: -40 };
    const before = coverScale(LANDSCAPE, CIRCLE) * s.zoom;
    const source = { x: s.center.x + anchor.x / before, y: s.center.y + anchor.y / before };
    const z = zoomCrop(s, 2.5, LANDSCAPE, CIRCLE, anchor);
    const after = coverScale(LANDSCAPE, CIRCLE) * z.zoom;
    expect(z.center.x + anchor.x / after).toBeCloseTo(source.x, 6);
    expect(z.center.y + anchor.y / after).toBeCloseTo(source.y, 6);
  });

  it("any sequence of pinches and drags keeps the banner frame filled", () => {
    let s = initialCropState(PORTRAIT);
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 500; i += 1) {
      if (rand() < 0.5) {
        s = panCrop(s, { x: (rand() - 0.5) * 400, y: (rand() - 0.5) * 400 }, PORTRAIT, BANNER);
      } else {
        s = zoomCrop(s, s.zoom * (0.5 + rand()), PORTRAIT, BANNER, {
          x: (rand() - 0.5) * BANNER.width,
          y: (rand() - 0.5) * BANNER.height,
        });
      }
      assertFilled(s, PORTRAIT, BANNER);
    }
  });

  it("the drawn image and the exported rect agree", () => {
    const s = panCrop(zoomCrop(initialCropState(LANDSCAPE), 3, LANDSCAPE, CIRCLE), { x: 40, y: 25 }, LANDSCAPE, CIRCLE);
    const t = imageTransform(s, LANDSCAPE, CIRCLE);
    const r = cropRect(s, LANDSCAPE, CIRCLE);
    const screenPerSource = coverScale(LANDSCAPE, CIRCLE) * t.scale;
    // The mask's top-left corner (screen 0,0) is the rect's source origin.
    expect((0 - t.x) / screenPerSource).toBeCloseTo(r.x, 6);
    expect((0 - t.y) / screenPerSource).toBeCloseTo(r.y, 6);
    expect(CIRCLE.width / screenPerSource).toBeCloseTo(r.width, 6);
  });

  it("isInitialCrop flips once the user moves anything", () => {
    const s = initialCropState(LANDSCAPE);
    expect(isInitialCrop(s, LANDSCAPE, CIRCLE)).toBe(true);
    expect(isInitialCrop(panCrop(s, { x: 20, y: 0 }, LANDSCAPE, CIRCLE), LANDSCAPE, CIRCLE)).toBe(false);
    expect(isInitialCrop(zoomCrop(s, 1.5, LANDSCAPE, CIRCLE), LANDSCAPE, CIRCLE)).toBe(false);
  });
});

describe("crop export", () => {
  it("rounds the native crop rect inward, never 1px outside the bitmap", () => {
    const r = pixelCropRect({ x: 1499.6, y: -0.2, width: 500.9, height: 1000.4 }, LANDSCAPE);
    expect(r.x + r.width).toBeLessThanOrEqual(LANDSCAPE.width);
    expect(r.y + r.height).toBeLessThanOrEqual(LANDSCAPE.height);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });

  it("exports at the server size and never upscales a small crop", () => {
    expect(outputSize({ x: 0, y: 0, width: 1000, height: 1000 }, "avatar")).toEqual(CROP_OUTPUT.avatar);
    expect(outputSize({ x: 0, y: 0, width: 2000, height: 750 }, "banner")).toEqual(CROP_OUTPUT.banner);
    const small = outputSize({ x: 0, y: 0, width: 200, height: 200 }, "avatar");
    expect(small).toEqual({ width: 200, height: 200 });
    // A tiny crop still exports at a readable floor.
    expect(outputSize({ x: 0, y: 0, width: 40, height: 40 }, "avatar").width).toBe(128);
    const banner = outputSize({ x: 0, y: 0, width: 600, height: 225 }, "banner");
    expect(banner.width / banner.height).toBeCloseTo(CROP_ASPECT.banner, 2);
  });

  it("the working copy is capped at 2048 on the long edge", () => {
    expect(editingResize({ width: 8000, height: 6000 })).toEqual({ width: 2048, height: 1536 });
    expect(editingResize({ width: 1024, height: 2048 })).toBeNull();
  });
});

describe("mask size", () => {
  it("the avatar circle is the largest square inside the stage", () => {
    expect(maskSizeFor("avatar", { width: 390, height: 500 }, 24)).toEqual({ width: 342, height: 342 });
    expect(maskSizeFor("avatar", { width: 800, height: 300 }, 24)).toEqual({ width: 252, height: 252 });
  });

  it("the banner frame keeps the card's 8:3", () => {
    const m = maskSizeFor("banner", { width: 390, height: 500 }, 16);
    expect(m.width).toBe(358);
    expect(m.width / m.height).toBeCloseTo(8 / 3, 1);
  });
});
