/**
 * Client-side media prep for attachment uploads (ADR 0008 §1/§5).
 *
 * Everything here is a FAST, LOCAL best-effort — the API re-validates mime + size
 * and magic-byte-sniffs authoritatively on `complete`. Two jobs:
 *
 * 1. Validate type + size against the shared whitelist (`@demli/config`) so an
 *    obviously-wrong file is rejected before any network call.
 * 2. Produce the exact bytes to upload + the dimensions to report:
 *    - images (except GIF) are re-encoded through a canvas, which STRIPS EXIF —
 *      a privacy requirement, not a nice-to-have (a shared home photo must not
 *      leak GPS, ADR 0008 §5) — and downscales huge phone photos.
 *    - GIFs are left byte-for-byte untouched (re-encoding kills the animation;
 *      GIF carries no EXIF anyway).
 *    - video/audio are uploaded as-is; we only read width/height/duration.
 */

import {
  ATTACHMENT_LIMITS,
  attachmentKindForMime,
  type AttachmentLimitKind,
} from "@demli/config";

/** Longest edge (px) a re-encoded image is downscaled to. Never upscales. */
const MAX_IMAGE_DIMENSION = 2560;
/** JPEG/WebP re-encode quality. PNG ignores this. */
const IMAGE_ENCODE_QUALITY = 0.92;

/** `accept` attribute for the file input — every whitelisted MIME. */
export const ATTACHMENT_ACCEPT = Object.values(ATTACHMENT_LIMITS)
  .flatMap((limit) => limit.mimes as readonly string[])
  .join(",");

/** The bytes + metadata to hand to the upload flow. */
export interface ProcessedAttachment {
  /** Exact bytes to PUT (re-encoded for images, original for gif/video/audio). */
  blob: Blob;
  /** MIME of `blob` (whitelisted); matches what we declare to the API. */
  mime: string;
  kind: AttachmentLimitKind;
  width?: number;
  height?: number;
  durationMs?: number;
}

/**
 * Why a file was rejected before upload. This module is React-free and i18n-free
 * (ADR 0009): it names the reason, and the caller maps it to a catalog key at the
 * render site — never an English string here.
 */
export type AttachmentRejectReason =
  | { kind: "typeNotAllowed" }
  | { kind: "tooLarge"; limit: string };

export type ValidateResult =
  | { ok: true; kind: AttachmentLimitKind }
  | { ok: false; reason: AttachmentRejectReason };

/** Human byte size, e.g. `4.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Fast local reject: type must be whitelisted and size within the per-kind cap.
 * The server is authoritative; this only avoids obviously-doomed uploads.
 */
export function validateAttachment(file: File): ValidateResult {
  const kind = attachmentKindForMime(file.type);
  if (!kind) {
    return { ok: false, reason: { kind: "typeNotAllowed" } };
  }
  const cap = ATTACHMENT_LIMITS[kind].maxBytes;
  if (file.size > cap) {
    return { ok: false, reason: { kind: "tooLarge", limit: formatBytes(cap) } };
  }
  return { ok: true, kind };
}

function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = max / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image."))),
      mime,
      quality,
    );
  });
}

function readImageSize(file: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(size);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image."));
    };
    img.src = url;
  });
}

async function processImage(file: File): Promise<ProcessedAttachment> {
  // GIF: never re-encode (would flatten the animation); it carries no EXIF.
  if (file.type === "image/gif") {
    const { width, height } = await readImageSize(file).catch(() => ({
      width: 0,
      height: 0,
    }));
    return {
      blob: file,
      mime: file.type,
      kind: "image",
      width: width || undefined,
      height: height || undefined,
    };
  }

  // `from-image` bakes EXIF orientation into the pixels so the re-encode is
  // upright; the canvas output then contains NO metadata at all (EXIF stripped).
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_DIMENSION);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not process this image.");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvasToBlob(canvas, file.type, IMAGE_ENCODE_QUALITY);
  return { blob, mime: file.type, kind: "image", width, height };
}

function readTimedMediaMetadata(
  file: File,
  tag: "video" | "audio",
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  return new Promise((resolve) => {
    const el = document.createElement(tag);
    const url = URL.createObjectURL(file);
    const done = (result: { width?: number; height?: number; durationMs?: number }): void => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const durationMs =
        Number.isFinite(el.duration) && el.duration > 0
          ? Math.round(el.duration * 1000)
          : undefined;
      if (tag === "video") {
        const video = el as HTMLVideoElement;
        done({
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          durationMs,
        });
      } else {
        done({ durationMs });
      }
    };
    // Metadata read is best-effort; the server does not require dims.
    el.onerror = () => done({});
    el.src = url;
  });
}

/**
 * Turn a picked file into upload bytes + dimensions. Images are EXIF-stripped +
 * downscaled; video/audio pass through with a metadata probe. Rejects only if
 * the file cannot be decoded at all.
 */
export async function processAttachment(file: File): Promise<ProcessedAttachment> {
  const kind = attachmentKindForMime(file.type);
  if (!kind) throw new Error("This file type can't be shared here.");

  if (kind === "image") return processImage(file);

  const meta = await readTimedMediaMetadata(file, kind === "video" ? "video" : "audio");
  return { blob: file, mime: file.type, kind, ...meta };
}
