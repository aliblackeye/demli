/**
 * Avatar upload validation — the API-side authority over what may become a
 * user's profile photo. Mirrors the custom-emoji pipeline (`lib/custom-emojis.ts`):
 * the client sends the image inline (base64), so the server holds the REAL bytes
 * and can decode → size-check → magic-byte sniff BEFORE anything reaches the
 * bucket. No pending row, no orphan sweep, no window where an unverified object
 * exists.
 *
 * Rules enforced here (all §28 — a client's declared type is never trusted):
 *  - the declared MIME is on the whitelist (PNG / JPEG / WebP);
 *  - the decoded byte length is within {@link AVATAR_MAX_BYTES};
 *  - the LEADING BYTES actually match the declared MIME. Sniffing the *declared*
 *    type (not "is it any image?") is what closes the stored-XSS vector: an
 *    `image/png` label over an SVG body would otherwise store markup that later
 *    renders from an `<img>` tag.
 *
 * The bucket is PUBLIC (avatars are served by a stable URL persisted on the user
 * row), which is exactly why byte-level verification here is non-negotiable.
 */

import { randomUUID } from "node:crypto";
import type { UserId } from "@demli/types";
import { isWithinPixelBudget, MAX_IMAGE_PIXELS } from "@demli/config";
import { ApiError } from "../errors.js";

/** Byte cap for one uploaded avatar image (2 MB). Authoritative — the client copy mirrors it. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Exact MIME whitelist for avatar uploads. No SVG (stored-XSS vector); no GIF
 * (an animated avatar is a render-cost trap across every message row and member
 * list, §27). A profile photo is a still image.
 */
export const AVATAR_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

/** One of the whitelisted avatar MIME types. */
export type AvatarMime = (typeof AVATAR_MIMES)[number];

/** File extension per whitelisted avatar MIME. */
const AVATAR_EXTENSIONS: Record<AvatarMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Base64 expands 3 bytes into 4 chars, so the encoded form of a max-size image
 * is ~4/3 of the cap. The margin covers padding and any newlines an encoder
 * inserts. Checked BEFORE decoding so an oversized payload is rejected without
 * allocating it.
 */
const MAX_BASE64_LENGTH = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024;

/**
 * True when `mime` is a whitelisted avatar image type. The declared MIME is only
 * the first gate — the bytes are magic-byte sniffed too, since a declared content
 * type is client-supplied and therefore untrusted.
 */
export function isAvatarMime(mime: string): mime is AvatarMime {
  return (AVATAR_MIMES as readonly string[]).includes(mime);
}

/**
 * Bucket-relative object key for a user's avatar: `avatars/<userId>/<uuid>.<ext>`.
 * The random UUID (rather than a fixed `avatar.png`) means each upload is a new
 * object, so a public CDN never serves a stale cached image after a change; the
 * previous object is best-effort deleted by the caller.
 */
export function buildAvatarStoragePath(userId: UserId, mime: AvatarMime): string {
  return `avatars/${userId}/${randomUUID()}.${AVATAR_EXTENSIONS[mime]}`;
}

/**
 * True when `bytes` begins with the signature of `mime`. Exact-match, not "looks
 * like an image": the declared type and the real type must agree, so a GIF or SVG
 * can never ride in under a PNG/JPEG/WebP label.
 *
 * WebP is a RIFF container — `RIFF....WEBP` — so both the magic at offset 0 and
 * the form type at offset 8 are checked; testing only `RIFF` would also accept a
 * WAV file.
 */
export function avatarBytesMatchMime(bytes: Uint8Array, mime: AvatarMime): boolean {
  const startsWith = (sig: number[], offset = 0): boolean =>
    bytes.length >= offset + sig.length && sig.every((v, i) => bytes[offset + i] === v);
  const ascii = (text: string, offset = 0): boolean =>
    startsWith([...text].map((c) => c.charCodeAt(0)), offset);

  switch (mime) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      // Every JPEG starts SOI (FF D8) then a marker (FF ..). FF D8 FF is the
      // universally-safe prefix across JFIF/Exif variants.
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp":
      return ascii("RIFF") && ascii("WEBP", 8);
    default:
      return false;
  }
}

/**
 * Decode + fully validate an inline avatar upload. Returns the verified bytes and
 * the narrowed MIME, or throws the appropriate `ApiError`.
 *
 * Order is deliberate and cheap-first: whitelist (pure string test) → encoded
 * length (no allocation) → decode → real length → magic bytes. An abusive payload
 * is rejected at the earliest possible point.
 */
export function decodeAvatarUpload(input: {
  mime: string;
  dataBase64: string;
}): { bytes: Uint8Array; mime: AvatarMime } {
  if (!isAvatarMime(input.mime)) {
    throw new ApiError(400, "INVALID_AVATAR", "Avatar must be a PNG, JPEG or WebP image.");
  }
  if (input.dataBase64.length > MAX_BASE64_LENGTH) {
    throw new ApiError(413, "AVATAR_TOO_LARGE", "That image is too large. Max 2 MB.");
  }

  // `base64` decoding is lenient (ignores non-alphabet characters), so a
  // malformed payload yields short/garbage bytes rather than throwing — fine,
  // because the magic-byte check below is what actually decides.
  const bytes = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
  if (bytes.length === 0) {
    throw new ApiError(400, "INVALID_AVATAR", "That image could not be read.");
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new ApiError(413, "AVATAR_TOO_LARGE", "That image is too large. Max 2 MB.");
  }
  if (!avatarBytesMatchMime(bytes, input.mime)) {
    throw new ApiError(400, "INVALID_AVATAR", "That file is not a valid PNG, JPEG or WebP image.");
  }
  // Decompression bomb: the byte cap above does NOT bound this. A ~40 KB PNG can
  // declare 30000x30000 in its header and cost gigabytes the moment anything
  // decodes it — a client rendering the avatar in a member list, or any future
  // server-side resize. The dimensions live in the header, so this reads them
  // rather than decoding, and it also rejects a header too short to read at all.
  if (!isWithinPixelBudget(bytes)) {
    throw new ApiError(
      400,
      "INVALID_AVATAR",
      `That image's dimensions are too large. Max ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.`,
    );
  }

  return { bytes, mime: input.mime };
}
