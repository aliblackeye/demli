import { describe, expect, it } from "vitest";
import {
  CROP_INPUT_MAX_BYTES,
  bytesToBase64,
  inspectImageFile,
  isAnimatedGif,
  isAnimatedWebp,
  sniffImageType,
} from "./image-file";

/** A 1×1 GIF89a with `frames` image frames (each: GCE + descriptor + 1px data). */
function gif(frames: number, withLoopExtension = false): Uint8Array {
  const out: number[] = [
    ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
    1, 0, 1, 0, // 1×1
    0x80, 0, 0, // global colour table, 2 entries
    0, 0, 0, 255, 255, 255,
  ];
  if (withLoopExtension) {
    out.push(0x21, 0xff, 0x0b, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  }
  for (let i = 0; i < frames; i += 1) {
    out.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00); // graphic control extension
    out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // image descriptor
    out.push(0x02, 0x02, 0x4c, 0x01, 0x00); // LZW data
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

/** RIFF/WEBP with a VP8X chunk whose flags byte is `flags` and a 2×2 canvas. */
function webpVp8x(flags: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([22, 0, 0, 0], 4);
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  b.set([..."VP8X"].map((c) => c.charCodeAt(0)), 12);
  b.set([10, 0, 0, 0], 16);
  b[20] = flags;
  b.set([1, 0, 0, 1, 0, 0], 24); // canvas 2×2 (minus-one encoding)
  return b;
}

function fakeFile(bytes: Uint8Array, type: string, size = bytes.length): Blob {
  return {
    type,
    size,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Blob;
}

describe("animation detection", () => {
  it("a one-frame GIF is still, even with a loop extension", () => {
    expect(isAnimatedGif(gif(1))).toBe(false);
    expect(isAnimatedGif(gif(1, true))).toBe(false);
  });

  it("two frames is animated", () => {
    expect(isAnimatedGif(gif(2))).toBe(true);
    expect(isAnimatedGif(gif(3, true))).toBe(true);
  });

  it("garbage is not animated (and does not throw)", () => {
    expect(isAnimatedGif(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isAnimatedGif(new Uint8Array(200).fill(0x21))).toBe(false);
  });

  it("reads the WebP animation flag", () => {
    expect(isAnimatedWebp(webpVp8x(0x02))).toBe(true);
    expect(isAnimatedWebp(webpVp8x(0x10))).toBe(false);
  });
});

describe("inspectImageFile", () => {
  it("sniffs the real type from the bytes, not the label", () => {
    expect(sniffImageType(gif(1))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("refuses an SVG wearing a PNG label", async () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await inspectImageFile(fakeFile(svg, "image/png"))).toEqual({ ok: false, problem: "type" });
  });

  it("refuses a declared type outside the four", async () => {
    expect(await inspectImageFile(fakeFile(gif(1), "image/svg+xml"))).toEqual({ ok: false, problem: "type" });
  });

  it("refuses an oversized file before reading it", async () => {
    const result = await inspectImageFile(fakeFile(gif(1), "image/gif", CROP_INPUT_MAX_BYTES + 1));
    expect(result).toEqual({ ok: false, problem: "size" });
  });

  it("refuses a header that declares more pixels than the shared budget", async () => {
    const bomb = gif(1);
    bomb[6] = 0xff;
    bomb[7] = 0xff;
    bomb[8] = 0xff;
    bomb[9] = 0xff; // 65535×65535
    expect(await inspectImageFile(fakeFile(bomb, "image/gif"))).toEqual({ ok: false, problem: "pixels" });
  });

  it("flags an animated GIF so the editor can offer to keep it moving", async () => {
    const result = await inspectImageFile(fakeFile(gif(2), "image/gif"));
    expect(result.ok && result.image.animated).toBe(true);
    expect(result.ok && result.image.mime).toBe("image/gif");
  });
});

describe("bytesToBase64", () => {
  it("round-trips across the chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
