import { describe, expect, it } from "vitest";
// Imported through `./image-bytes`, the re-export shim, on purpose: the
// implementation now lives in `@demli/config` (so the API can run the same
// bomb guard on uploads), and driving these vectors through the shim proves the
// re-export surface stays complete as well as that the rules still hold.
import {
  isPixelCountWithinBudget,
  isWithinPixelBudget,
  MAX_IMAGE_PIXELS,
  readImageDimensions,
  sniffImageMime,
} from "./image-bytes";

/**
 * These vectors MIRROR
 * `apps/desktop/src/main/image-actions-policy.test.ts`. The two implementations
 * are deliberate copies (a shared package cannot import from an app), so the
 * tests are copies too — if one side drifts, one of the two suites fails.
 */

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0], 2); // APP0 (skipped)
  view.setUint16(4, 8);
  bytes.set([0xff, 0xc0], 12); // SOF0
  view.setUint16(14, 17);
  bytes[16] = 8;
  view.setUint16(17, height);
  view.setUint16(19, width);
  return bytes;
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

describe("sniffImageMime", () => {
  it("identifies the four whitelisted formats", () => {
    expect(sniffImageMime(pngHeader(2, 2))).toBe("image/png");
    expect(sniffImageMime(jpegHeader(2, 2))).toBe("image/jpeg");
    expect(sniffImageMime(gifHeader(2, 2))).toBe("image/gif");
    expect(sniffImageMime(webpHeader(2, 2))).toBe("image/webp");
  });

  it("rejects an executable, an SVG, an HTML page and an empty body", () => {
    expect(sniffImageMime(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<!doctype html>"))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("reads the size out of each format's header", () => {
    expect(readImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageDimensions(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(readImageDimensions(webpHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });
});

describe("isWithinPixelBudget — the decompression-bomb guard", () => {
  it("passes ordinary photos and screenshots", () => {
    expect(isWithinPixelBudget(pngHeader(1920, 1080))).toBe(true);
    expect(isWithinPixelBudget(jpegHeader(4032, 3024))).toBe(true);
    expect(isWithinPixelBudget(webpHeader(2560, 1440))).toBe(true);
  });

  it("REFUSES a bomb that is tiny on the wire and enormous in a canvas", () => {
    expect(isWithinPixelBudget(pngHeader(40_000, 40_000))).toBe(false);
    expect(isWithinPixelBudget(gifHeader(60_000, 60_000))).toBe(false);
  });

  it("refuses anything whose header will not state a size (fail-closed)", () => {
    expect(isWithinPixelBudget(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      false,
    );
    expect(isWithinPixelBudget(new Uint8Array(0))).toBe(false);
  });

  it("also bounds an ALREADY-decoded size, before a canvas is allocated", () => {
    expect(MAX_IMAGE_PIXELS).toBe(64_000_000);
    expect(isPixelCountWithinBudget(8000, 8000)).toBe(true);
    expect(isPixelCountWithinBudget(8000, 8001)).toBe(false);
    expect(isPixelCountWithinBudget(40_000, 40_000)).toBe(false);
    expect(isPixelCountWithinBudget(0, 100)).toBe(false);
    expect(isPixelCountWithinBudget(Number.NaN, 10)).toBe(false);
  });
});
