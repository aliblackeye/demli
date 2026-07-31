/**
 * Custom-emoji upload validation (M17) — the API-side authority over what may
 * become an emoji image.
 *
 * The client sends the image inline (base64) because an emoji is capped at 256 KB
 * (`CUSTOM_EMOJI_MAX_BYTES`). That is the whole reason this validation can be
 * strictly stronger than the attachment pipeline's: the server holds the REAL
 * bytes before anything is written, so it decodes, size-checks and magic-byte
 * sniffs FIRST and only then uploads. No pending row, no orphan sweep, and no
 * window in which an unverified object sits in the bucket.
 *
 * Rules enforced here (all §28 — a client's declared type is never trusted):
 *  - the declared MIME is on the whitelist (`image/png` / `image/webp`);
 *  - the decoded byte length is within the cap;
 *  - the LEADING BYTES actually match the declared MIME. This is the one that
 *    matters: without it, `image/png` + an SVG body would store markup that later
 *    renders from an `<img>` tag — the stored-XSS vector the whitelist exists to
 *    close. Sniffing the declared type specifically (rather than "is it any
 *    image?") also prevents a GIF being smuggled in as a PNG, which would defeat
 *    the deliberate no-animation rule;
 *  - the DECLARED PIXEL DIMENSIONS are inside {@link MAX_IMAGE_PIXELS}. The
 *    256 KB byte cap does not bound this and never could: a valid, single-colour
 *    PNG whose IHDR says 60000×60000 compresses to a few KB and costs ~14 GB of
 *    RGBA the moment anything decodes it. An emoji is the WORST place to leave
 *    that open, because it is the one image every member of a channel decodes
 *    automatically the instant it appears in a message — one `:bomb:` and every
 *    desktop/web/mobile client in the channel goes down at once. The avatar and
 *    banner paths have carried this check since they were written; this one had
 *    the same cap-only posture they were fixed for.
 */

import { randomUUID } from "node:crypto";
import {
  CUSTOM_EMOJI_MAX_BYTES,
  isCustomEmojiMime,
  isWithinPixelBudget,
  MAX_IMAGE_PIXELS,
  type CustomEmojiMime,
} from "@demli/config";
import type { GroupId } from "@demli/types";
import { ApiError } from "../errors.js";

/**
 * Base64 expands 3 bytes into 4 chars, so the encoded form of a max-size image
 * is ~4/3 of the cap. The margin covers padding, and any newlines a client's
 * encoder might insert. Checked BEFORE decoding so an oversized payload is
 * rejected without allocating it.
 */
const MAX_BASE64_LENGTH = Math.ceil((CUSTOM_EMOJI_MAX_BYTES * 4) / 3) + 1024;

/** File extension per whitelisted emoji MIME (mirrors `MIME_EXTENSIONS` for attachments). */
const EMOJI_EXTENSIONS: Record<CustomEmojiMime, string> = {
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Bucket-relative object key for a group's emoji: `emoji/<groupId>/<uuid>.<ext>`.
 * The random UUID means the key never reveals the emoji NAME, so the storage
 * layout leaks nothing about a private group's contents even to someone who can
 * see object keys. The `emoji/` prefix keeps them out of the channel-id
 * namespace attachments use.
 */
export function buildEmojiStoragePath(groupId: GroupId, mime: CustomEmojiMime): string {
  return `emoji/${groupId}/${randomUUID()}.${EMOJI_EXTENSIONS[mime]}`;
}

/**
 * True when `bytes` begins with the signature of `mime`. Exact-match, not
 * "looks like an image": the declared type and the real type must agree, so a
 * GIF or SVG can never ride in under a PNG label.
 *
 * WebP is a RIFF container — `RIFF....WEBP` — so both the magic at offset 0 and
 * the form type at offset 8 are checked; testing only `RIFF` would also accept a
 * WAV file.
 */
export function emojiBytesMatchMime(bytes: Uint8Array, mime: CustomEmojiMime): boolean {
  const startsWith = (sig: number[], offset = 0): boolean =>
    bytes.length >= offset + sig.length && sig.every((v, i) => bytes[offset + i] === v);
  const ascii = (text: string, offset = 0): boolean =>
    startsWith([...text].map((c) => c.charCodeAt(0)), offset);

  switch (mime) {
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return ascii("RIFF") && ascii("WEBP", 8);
    default:
      return false;
  }
}

/**
 * Decode + fully validate an inline emoji upload. Returns the verified bytes and
 * the narrowed MIME, or throws the appropriate `ApiError`.
 *
 * Order is deliberate and cheap-first: whitelist (pure string test) → encoded
 * length (no allocation) → decode → real length → magic bytes → pixel budget.
 * An abusive payload is rejected at the earliest possible point.
 */
export function decodeEmojiUpload(input: {
  mime: string;
  dataBase64: string;
}): { bytes: Uint8Array; mime: CustomEmojiMime } {
  if (!isCustomEmojiMime(input.mime)) {
    throw new ApiError(
      400,
      "INVALID_EMOJI",
      "Emoji must be a PNG or WebP image.",
    );
  }
  if (input.dataBase64.length > MAX_BASE64_LENGTH) {
    throw new ApiError(413, "EMOJI_TOO_LARGE", "That emoji image is too large.");
  }

  // `base64` decoding is lenient (it ignores non-alphabet characters), so a
  // malformed payload yields short/garbage bytes rather than throwing — which is
  // fine, because the magic-byte check below is what actually decides.
  const bytes = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
  if (bytes.length === 0) {
    throw new ApiError(400, "INVALID_EMOJI", "That emoji image could not be read.");
  }
  if (bytes.length > CUSTOM_EMOJI_MAX_BYTES) {
    throw new ApiError(413, "EMOJI_TOO_LARGE", "That emoji image is too large.");
  }
  if (!emojiBytesMatchMime(bytes, input.mime)) {
    throw new ApiError(
      400,
      "INVALID_EMOJI",
      "That file is not a valid PNG or WebP image.",
    );
  }
  // Decompression bomb. Read the size out of the HEADER — nothing decodes here —
  // and refuse anything over the budget OR anything whose header will not state a
  // size at all, since "will not say how big it is" is exactly the shape a bomb
  // takes. This is the last gate before the bytes reach the bucket and, from
  // there, every client in the channel.
  if (!isWithinPixelBudget(bytes)) {
    throw new ApiError(
      400,
      "INVALID_EMOJI",
      `That image's dimensions are too large. Max ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.`,
    );
  }

  return { bytes, mime: input.mime };
}
