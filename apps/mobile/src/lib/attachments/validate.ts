/**
 * Pure attachment validation + sizing helpers (ADR 0008, M10) — the mobile
 * mirror of the desktop renderer's lib/attachments/validate.ts.
 *
 * Everything here is platform-free and unit-tested. The MIME whitelist and
 * byte caps come from @demli/config — the SAME constants the API enforces —
 * so a locally-rejected file would have been rejected server-side anyway.
 * Expo-native work (image re-encode, file upload) lives in image-processing.ts
 * and upload.ts.
 */

import {
  ATTACHMENT_LIMITS,
  attachmentKindForMime,
  type AttachmentLimitKind,
} from "@demli/config";
import type { AttachmentKind } from "@demli/types";
import type { DraftError } from "../errors";

/** Longest edge we ever upload for an image; larger images are downscaled. */
export const MAX_IMAGE_EDGE_PX = 4096;

/** Below this edge we stop downscaling and give up instead of producing mush. */
export const MIN_IMAGE_EDGE_PX = 256;

/** Every whitelisted attachment MIME (document-picker `type` filter). */
export const ATTACHMENT_MIMES: readonly string[] = Object.values(ATTACHMENT_LIMITS).flatMap(
  (limit) => [...limit.mimes],
);

/** Whitelisted audio MIMEs only (the audio document-picker filter). */
export const AUDIO_MIMES: readonly string[] = [...ATTACHMENT_LIMITS.audio.mimes];

/**
 * File extension → whitelisted MIME. Android pickers occasionally omit
 * `mimeType` (content:// URIs from odd providers); the filename extension is
 * the fallback before we reject the file.
 */
const EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
};

/** Best-effort MIME from a filename/URI extension; null when unknown. */
export function mimeFromFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const clean = name.split("?")[0]?.split("#")[0] ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1).toLowerCase();
  return EXTENSION_MIMES[ext] ?? null;
}

/**
 * Resolve the MIME the pipeline should use for a picked asset: a whitelisted
 * picker-reported MIME wins; otherwise fall back to the filename extension.
 * Returns null when neither identifies a whitelisted type.
 */
export function resolveAssetMime(
  reportedMime: string | null | undefined,
  filename: string | null | undefined,
): string | null {
  const reported = reportedMime?.toLowerCase() ?? null;
  if (reported && attachmentKindForMime(reported) !== null) return reported;
  return mimeFromFilename(filename);
}

export type FileValidationResult =
  | {
      ok: true;
      kind: AttachmentKind;
      /**
       * The file is over its byte cap but is a re-encodable image — the
       * downscale pipeline may still bring it under the cap.
       */
      needsDownscale: boolean;
    }
  | { ok: false; error: DraftError };

/** Catalog key for the "too large" message of a rejected kind. */
const TOO_LARGE_KEY = {
  image: "mobile:attachments.tooLargeImage",
  audio: "mobile:attachments.tooLargeAudio",
  video: "mobile:attachments.tooLargeVideo",
} as const satisfies Record<AttachmentKind, DraftError["key"]>;

/** Human-readable size, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** mm:ss (or h:mm:ss) for media durations. */
export function formatMediaDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** GIFs are whitelisted images but must never be re-encoded (animation). */
export function isReencodableImageMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}

/**
 * Validate a candidate file against the shared whitelist + per-kind caps.
 * Over-cap re-encodable images pass with `needsDownscale` — the re-encode
 * pipeline re-validates the final bytes. Everything else over cap is rejected
 * outright.
 */
export function validateAttachmentFile(input: {
  mime: string;
  sizeBytes: number;
}): FileValidationResult {
  const kind = attachmentKindForMime(input.mime);
  if (kind === null) {
    return { ok: false, error: { key: "mobile:attachments.typeNotAllowed" } };
  }
  const cap = ATTACHMENT_LIMITS[kind as AttachmentLimitKind].maxBytes;
  if (input.sizeBytes <= cap) {
    return { ok: true, kind, needsDownscale: false };
  }
  if (kind === "image" && isReencodableImageMime(input.mime)) {
    return { ok: true, kind, needsDownscale: true };
  }
  return {
    ok: false,
    error: {
      key: TOO_LARGE_KEY[kind],
      params: { cap: formatBytes(cap), size: formatBytes(input.sizeBytes) },
    },
  };
}

/** Byte cap for a kind (re-check after re-encode). */
export function maxBytesForKind(kind: AttachmentKind): number {
  return ATTACHMENT_LIMITS[kind as AttachmentLimitKind].maxBytes;
}

/**
 * Fit `width × height` inside a square of `maxEdge`, preserving aspect ratio.
 * Never upscales; always returns integers ≥ 1.
 */
export function scaleToFitEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Deterministic display box for an image/video tile: fit the natural size into
 * `maxW × maxH` without upscaling tiny media past its natural size. Reserving
 * this exact box (before any bytes load) is what keeps the inverted FlatList
 * from shifting when media arrives (CLAUDE.md §27).
 */
export function fitTileBox(
  width: number | null,
  height: number | null,
  maxW: number,
  maxH: number,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const w = width ?? fallback.width;
  const h = height ?? fallback.height;
  if (w <= 0 || h <= 0) return { width: maxW, height: Math.round((maxW * 9) / 16) };
  const factor = Math.min(maxW / w, maxH / h, 1);
  return {
    width: Math.max(1, Math.round(w * factor)),
    height: Math.max(1, Math.round(h * factor)),
  };
}
