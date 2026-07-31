/**
 * Profile-banner upload validation (M15) — the API-side authority over what may
 * become a user's profile banner, and (via {@link decodeImageUpload}) over what
 * may become a SERVER's banner too. Same posture as {@link ./avatar-upload}: the
 * client sends the image inline (base64), so the server holds the REAL bytes and
 * decodes → size-checks → magic-byte sniffs → pixel-budget checks BEFORE anything
 * reaches the bucket.
 *
 * Differences from the avatar rules (deliberate, per founder):
 *  - GIF is ALLOWED (a banner may be an animated gif or a photo) — but SVG is
 *    still forbidden (stored-XSS vector), and the declared type is still verified
 *    against the real magic bytes so a GIF/SVG can never ride in under a still
 *    label.
 *  - a larger byte cap ({@link BANNER_MAX_BYTES}) — banners are wider images and
 *    gifs are heavier than a still avatar.
 *
 * The banner shares the SAME public avatar bucket + `SUPABASE_AVATAR_BUCKET` gate
 * (no new env), stored under a `banners/<userId>/…` key. The bucket is PUBLIC
 * (banners are served by a stable URL persisted on the user row), which is exactly
 * why byte-level verification here is non-negotiable (§28).
 */

import { randomUUID } from "node:crypto";
import { isWithinPixelBudget, MAX_IMAGE_PIXELS } from "@demli/config";
import type { UserId } from "@demli/types";
import { ApiError, type ApiErrorCode } from "../errors.js";

/** Byte cap for one uploaded banner image (5 MB) — bigger than an avatar; allows gifs. */
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Exact MIME whitelist for banner uploads. Adds `image/gif` over the avatar set
 * (animated banners are allowed). No SVG (stored-XSS vector, §28).
 */
export const BANNER_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/** One of the whitelisted banner MIME types. */
export type BannerMime = (typeof BANNER_MIMES)[number];

/** File extension per whitelisted banner MIME. */
const BANNER_EXTENSIONS: Record<BannerMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Base64 expands 3 bytes into 4 chars, so the encoded form of a max-size image is
 * ~4/3 of the cap. The margin covers padding/newlines. Checked BEFORE decoding so
 * an oversized payload is rejected without allocating it.
 */
const MAX_BASE64_LENGTH = Math.ceil((BANNER_MAX_BYTES * 4) / 3) + 1024;

/** True when `mime` is a whitelisted banner image type (declared MIME — the first gate). */
export function isBannerMime(mime: string): mime is BannerMime {
  return (BANNER_MIMES as readonly string[]).includes(mime);
}

/**
 * Bucket-relative object key for a user's banner: `banners/<userId>/<uuid>.<ext>`.
 * The random UUID means each upload is a new object, so a public CDN never serves
 * a stale cached image after a change; the previous object is best-effort deleted
 * by the caller.
 */
export function buildBannerStoragePath(userId: UserId, mime: BannerMime): string {
  return `banners/${userId}/${randomUUID()}.${BANNER_EXTENSIONS[mime]}`;
}

/**
 * True when `bytes` begins with the signature of `mime`. Exact-match, not "looks
 * like an image": the declared type and the real type must agree, so an SVG can
 * never ride in under a PNG/JPEG/WebP/GIF label.
 */
export function bannerBytesMatchMime(bytes: Uint8Array, mime: BannerMime): boolean {
  const startsWith = (sig: number[], offset = 0): boolean =>
    bytes.length >= offset + sig.length && sig.every((v, i) => bytes[offset + i] === v);
  const ascii = (text: string, offset = 0): boolean =>
    startsWith([...text].map((c) => c.charCodeAt(0)), offset);

  switch (mime) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp":
      return ascii("RIFF") && ascii("WEBP", 8);
    case "image/gif":
      // "GIF87a" or "GIF89a".
      return ascii("GIF87a") || ascii("GIF89a");
    default:
      return false;
  }
}

/** Error codes + wording one banner-shaped upload path answers with. */
interface ImageUploadCodes {
  /** 400 code for "this is not an acceptable image". */
  invalidCode: ApiErrorCode;
  /** 413 code for "this image is over the byte cap". */
  tooLargeCode: ApiErrorCode;
  /** What the image would become, named in user-facing copy ("banner"). */
  subject: string;
}

/**
 * Decode + fully validate an inline banner-shaped image upload. Returns the
 * verified bytes and the narrowed MIME, or throws the appropriate `ApiError`.
 *
 * Order is cheap-first, and every step exists because the one before it can be
 * lied about:
 *   whitelist → encoded length → decode → real length → magic bytes → pixel budget
 *
 * The last step is the decompression-bomb guard. The byte cap above bounds the
 * TRANSFER, not the decoded bitmap: a single-colour 40000×40000 PNG is a few
 * hundred KB on the wire and ~6.4 GB of RGBA once something decodes it, so
 * without this a 300 KB upload that passes every other gate is a crash for every
 * client that later renders it, and for any server-side image work added after.
 * The header states the dimensions, so we read them and refuse before storing.
 * `isWithinPixelBudget` also returns false when the header cannot be read at all,
 * which is deliberate — an image that will not state its own size is exactly the
 * shape a bomb takes.
 *
 * The guard is imported from `@demli/config`, the same implementation the web
 * image actions already use for downloads, rather than re-derived here: one
 * parser, one budget, one set of vectors pinning it.
 *
 * Shared by the profile banner and the server banner so the two can never drift
 * (see `./group-banner-upload.ts`).
 */
export function decodeImageUpload(
  input: { mime: string; dataBase64: string },
  codes: ImageUploadCodes,
): { bytes: Uint8Array; mime: BannerMime } {
  const { invalidCode, tooLargeCode, subject } = codes;

  if (!isBannerMime(input.mime)) {
    throw new ApiError(
      400,
      invalidCode,
      `The ${subject} must be a PNG, JPEG, WebP or GIF image.`,
    );
  }
  if (input.dataBase64.length > MAX_BASE64_LENGTH) {
    throw new ApiError(413, tooLargeCode, "That image is too large. Max 5 MB.");
  }

  const bytes = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
  if (bytes.length === 0) {
    throw new ApiError(400, invalidCode, "That image could not be read.");
  }
  if (bytes.length > BANNER_MAX_BYTES) {
    throw new ApiError(413, tooLargeCode, "That image is too large. Max 5 MB.");
  }
  if (!bannerBytesMatchMime(bytes, input.mime)) {
    throw new ApiError(
      400,
      invalidCode,
      "That file is not a valid PNG, JPEG, WebP or GIF image.",
    );
  }
  if (!isWithinPixelBudget(bytes)) {
    throw new ApiError(
      400,
      invalidCode,
      `That image is too many pixels to display (max ${MAX_IMAGE_PIXELS / 1_000_000} megapixels).`,
    );
  }

  return { bytes, mime: input.mime };
}

/**
 * Decode + fully validate an inline PROFILE banner upload. Thin naming wrapper
 * over {@link decodeImageUpload} — the rules are the shared ones.
 */
export function decodeBannerUpload(input: {
  mime: string;
  dataBase64: string;
}): { bytes: Uint8Array; mime: BannerMime } {
  return decodeImageUpload(input, {
    invalidCode: "INVALID_BANNER",
    tooLargeCode: "BANNER_TOO_LARGE",
    subject: "banner",
  });
}
