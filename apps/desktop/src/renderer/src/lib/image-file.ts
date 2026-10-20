/**
 * File handling for the avatar / banner editor: validate what the user picked,
 * detect animation, decode it, and export the crop at the size and format the
 * server accepts (apps/api/src/lib/avatar-upload.ts + banner-upload.ts).
 *
 * The server is the authority (magic-byte sniff, byte cap, pixel budget) and it
 * stores bytes as given — it never resizes. So the client's job is to hand it a
 * file that will pass and that is the right size for where it is drawn:
 *
 *   avatar  in:  PNG / JPEG / WebP / GIF, ≤ 20 MB, ≤ the shared pixel budget
 *           out: 512² WebP (PNG if this engine cannot encode WebP), ≤ 2 MB.
 *           A GIF is accepted as INPUT and exported as its first frame — the
 *           server refuses animated avatars on purpose (a render cost on every
 *           message row, §27), and the editor says so instead of failing.
 *   banner  in:  same types, ≤ 20 MB to crop, ≤ 5 MB to keep an animation.
 *           out: 1200×450 WebP, ≤ 5 MB — OR, for an animated GIF/WebP the user
 *           chose to keep moving, the ORIGINAL bytes untouched (a canvas can
 *           only ever export one frame).
 *
 * Re-encoding is also what strips EXIF (location, camera serial) from a photo
 * before it reaches a public bucket — a property of the canvas round-trip.
 */

import { isWithinPixelBudget, sniffImageMime } from "@demli/config";
import { outputSize, type CropKind, type CropRect } from "./image-crop";

/** Types the picker accepts (the input `accept` attribute + the pre-check). */
export const CROP_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const CROP_INPUT_ACCEPT = CROP_INPUT_TYPES.join(",");

/** Largest file the editor will open to crop (it is re-encoded far smaller). */
export const CROP_INPUT_MAX_BYTES = 20 * 1024 * 1024;

/** Server caps — mirrored from the API, which stays authoritative. */
export const UPLOAD_MAX_BYTES: Record<CropKind, number> = {
  avatar: 2 * 1024 * 1024,
  banner: 5 * 1024 * 1024,
};

export type ImageFileProblem =
  | "type" // not one of the four image types
  | "size" // over the editor's input cap
  | "pixels" // header states more pixels than the shared budget (decompression bomb)
  | "decode" // the browser could not decode it
  | "encode" // the crop could not be exported under the server cap
  | "animatedTooLarge"; // keep-animation chosen but the original is over the server cap

/** The facts the editor needs about a picked file, read from its own bytes. */
export interface InspectedImage {
  mime: (typeof CROP_INPUT_TYPES)[number];
  bytes: Uint8Array;
  /** More than one frame (GIF) or the WebP animation flag. */
  animated: boolean;
}

/** Read a File into bytes. */
export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function isInputType(mime: string): mime is InspectedImage["mime"] {
  return (CROP_INPUT_TYPES as readonly string[]).includes(mime);
}

/**
 * The real type, from the leading bytes — the SAME sniffer the API runs
 * (`@demli/config`). The declared `file.type` comes from the file extension,
 * which lies as often as it is right ("photo.png" that is really a JPEG); the
 * server checks the bytes, so the client must too, or a mislabelled file would
 * export fine and then fail on Save. Anything outside the four editor types
 * (SVG, BMP, …) answers null.
 */
export function sniffImageType(bytes: Uint8Array): InspectedImage["mime"] | null {
  const mime = sniffImageMime(bytes);
  return mime !== null && isInputType(mime) ? mime : null;
}

/**
 * True when a GIF has more than one image frame. Walks the block structure
 * (GIF89a spec): header, logical screen descriptor (+ global colour table), then
 * extension blocks (0x21), image descriptors (0x2C) and the trailer (0x3B), each
 * extension / image data being a chain of length-prefixed sub-blocks. Counting
 * image descriptors is the definition of "animated"; the NETSCAPE loop
 * extension alone is not (a one-frame GIF can carry it).
 */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false;
  let pos = 6; // "GIF89a"
  const packed = bytes[pos + 4] ?? 0;
  pos += 7;
  if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1));

  const skipSubBlocks = (): boolean => {
    while (pos < bytes.length) {
      const len = bytes[pos] ?? 0;
      pos += 1;
      if (len === 0) return true;
      pos += len;
    }
    return false;
  };

  let frames = 0;
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      pos += 2; // introducer + label
      if (!skipSubBlocks()) break;
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      const localPacked = bytes[pos + 9] ?? 0;
      pos += 10;
      if (localPacked & 0x80) pos += 3 * (1 << ((localPacked & 0x07) + 1));
      pos += 1; // LZW minimum code size
      if (!skipSubBlocks()) break;
    } else {
      break; // corrupt — treat what we counted as the answer
    }
  }
  return false;
}

/** True when a WebP is an animated (VP8X + animation flag) WebP. */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  const fourcc = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (fourcc !== "VP8X") return false;
  return ((bytes[20] ?? 0) & 0x02) !== 0;
}

/**
 * Validate and inspect a picked file before anything is decoded. Order is
 * cheap-first and mirrors the server: declared type → byte cap → real type
 * from the bytes → pixel budget (read from the header, not by decoding — a
 * 40 KB PNG can declare 30000² and cost gigabytes once decoded).
 */
export async function inspectImageFile(
  file: Blob,
): Promise<{ ok: true; image: InspectedImage } | { ok: false; problem: ImageFileProblem }> {
  if (file.type !== "" && !isInputType(file.type)) return { ok: false, problem: "type" };
  if (file.size > CROP_INPUT_MAX_BYTES) return { ok: false, problem: "size" };
  const bytes = await readFileBytes(file);
  const mime = sniffImageType(bytes);
  if (!mime) return { ok: false, problem: "type" };
  if (!isWithinPixelBudget(bytes)) return { ok: false, problem: "pixels" };
  const animated =
    mime === "image/gif" ? isAnimatedGif(bytes) : mime === "image/webp" ? isAnimatedWebp(bytes) : false;
  return { ok: true, image: { mime, bytes, animated } };
}

/** Base64 of raw bytes (no `data:` prefix) — the shape the upload endpoints take. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode the bytes into an image element (the editor draws from it). */
export async function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  // Copy into a plain ArrayBuffer-backed view: Blob parts may not be shared memory.
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  // The object URL stays alive for the lifetime of the element; the editor
  // revokes it through `releaseImage` when it closes.
  return img;
}

/** Free the object URL behind an image from {@link decodeImage}. */
export function releaseImage(img: HTMLImageElement | null): void {
  if (img?.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Draw `rect` of `img` into a canvas of `size`, halving in steps when the
 * reduction is large. A single big drawImage downscale (a 4000px photo to 512px)
 * samples too few source pixels and comes out aliased; stepping by ≤2× keeps the
 * result crisp, which is the whole point of exporting a small avatar.
 */
export function renderCrop(
  img: CanvasImageSource,
  rect: CropRect,
  size: { width: number; height: number },
): HTMLCanvasElement {
  let source: CanvasImageSource = img;
  let sx = rect.x;
  let sy = rect.y;
  let sw = rect.width;
  let sh = rect.height;

  while (sw / 2 > size.width) {
    const step = document.createElement("canvas");
    step.width = Math.max(1, Math.round(sw / 2));
    step.height = Math.max(1, Math.round(sh / 2));
    const ctx = step.getContext("2d");
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, step.width, step.height);
    source = step;
    sx = 0;
    sy = 0;
    sw = step.width;
    sh = step.height;
  }

  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, size.width, size.height);
  }
  return out;
}

/** The exported image, ready for the upload endpoint and for local preview. */
export interface ExportedImage {
  mime: "image/webp" | "image/png" | "image/jpeg" | "image/gif";
  dataBase64: string;
  /** `data:` URL of the same bytes, for the in-app preview before Save. */
  previewUrl: string;
  width: number;
  height: number;
  byteLength: number;
  /** True only for a kept-animation banner (original bytes, uncropped). */
  animated: boolean;
}

/**
 * Export the crop: render at the output size, then encode as WebP, stepping the
 * quality down until it fits the server cap. If this engine cannot encode WebP
 * (`toBlob` silently falls back to PNG), PNG is tried, then JPEG as the last
 * resort for a photo PNG cannot fit — an avatar has no transparency worth
 * keeping at the cost of failing the upload.
 */
export async function exportCrop(
  img: CanvasImageSource,
  rect: CropRect,
  kind: CropKind,
): Promise<ExportedImage | null> {
  const size = outputSize(rect, kind);
  const canvas = renderCrop(img, rect, size);
  const cap = UPLOAD_MAX_BYTES[kind];
  const attempts: Array<[ExportedImage["mime"], number | undefined]> = [
    ["image/webp", 0.92],
    ["image/webp", 0.82],
    ["image/webp", 0.7],
    ["image/png", undefined],
    ["image/jpeg", 0.88],
    ["image/jpeg", 0.75],
  ];
  for (const [type, quality] of attempts) {
    const blob = await canvasToBlob(canvas, type, quality);
    // `toBlob` answers with PNG when it cannot encode the requested type —
    // accept only what was asked for, so the declared MIME matches the bytes.
    if (!blob || blob.type !== type || blob.size > cap) continue;
    const bytes = await readFileBytes(blob);
    const dataBase64 = bytesToBase64(bytes);
    return {
      mime: type,
      dataBase64,
      previewUrl: `data:${type};base64,${dataBase64}`,
      width: size.width,
      height: size.height,
      byteLength: bytes.length,
      animated: false,
    };
  }
  return null;
}

/** Keep an animated banner as-is (no crop is possible without losing the motion). */
export function keepOriginal(image: InspectedImage, natural: { width: number; height: number }): ExportedImage {
  const dataBase64 = bytesToBase64(image.bytes);
  return {
    mime: image.mime,
    dataBase64,
    previewUrl: `data:${image.mime};base64,${dataBase64}`,
    width: natural.width,
    height: natural.height,
    byteLength: image.bytes.length,
    animated: true,
  };
}
