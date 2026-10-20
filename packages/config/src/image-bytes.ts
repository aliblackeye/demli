/**
 * Image BYTE inspection — "what is this really, and how big does it get when
 * decoded".
 *
 * Two jobs, both about not trusting bytes someone else chose:
 *
 *  1. {@link sniffImageMime} — a declared `Content-Type` and a stored MIME are
 *     both CLAIMS. The magic number is the only statement the BYTES make, and it
 *     is what decides whether we hand a file to a decoder.
 *  2. {@link isWithinPixelBudget} — a byte cap bounds the transfer, not the
 *     decompressed bitmap. A single-colour 40000×40000 PNG is a few hundred KB
 *     on the wire and ~6.4 GB of RGBA once decoded, which is a crash anyone who
 *     can post an image could trigger. Read the size out of the header and refuse
 *     before allocating.
 *
 * Pure functions over `Uint8Array` — no DOM, no fetch, no Node built-ins, no
 * browser globals.
 *
 * WHY IT LIVES IN `@demli/config`: this guard is needed on BOTH sides of the
 * trust boundary — the web image actions (`packages/app-ui`) decide whether to
 * decode a downloaded image, and the API (`apps/api`) decides whether to accept
 * an uploaded avatar/banner. A shared package must never depend on an app, and
 * an app must not import another app, so the only legal home is this
 * dependency-free leaf that the API, the gateway, the desktop renderer, the web
 * SPA and the RN app can all import. It was previously a copy inside
 * `packages/app-ui/src/platform/`, which meant the server-side upload path had no
 * bomb guard at all — the copy could not be reached from `apps/api`.
 *
 * `apps/desktop/src/main/image-actions-policy.ts` still carries its own mirror of
 * these vectors (Electron main, separate bundle); the unit tests on both sides
 * pin the same cases, so keep them in lockstep.
 */

/** Largest image we will DECODE, in pixels (64 MP ≈ 9800×6500). */
export const MAX_IMAGE_PIXELS = 64_000_000;

/** How many leading bytes are enough to answer both questions. */
export const IMAGE_HEADER_BYTES = 64 * 1024;

/**
 * Identify the image format from its leading bytes, or null when the body is
 * not one of the four formats the API accepts on upload. SVG is deliberately
 * absent (stored-XSS) and must stay absent.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (index: number): number => bytes[index] ?? -1;

  if (
    bytes.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) &&
    at(5) === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  if (isHeicBytes(bytes)) {
    return "image/heic";
  }
  return null;
}

/**
 * ISO Base Media File Format (HEIC/HEIF/AVIF): bytes 4–7 spell "ftyp", then
 * bytes 8–11 carry a brand that identifies the container variant.
 */
function isHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70    // p
  ) {
    return false;
  }
  const brand = String.fromCharCode(
    bytes[8] ?? 0,
    bytes[9] ?? 0,
    bytes[10] ?? 0,
    bytes[11] ?? 0,
  );
  return [
    "heic", "heix", "hevc", "hevx",
    "heim", "heis", "mif1",
  ].includes(brand);
}

function be16(bytes: Uint8Array, at: number): number {
  if (at + 1 >= bytes.length) return -1;
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function be32(bytes: Uint8Array, at: number): number {
  if (at + 3 >= bytes.length) return -1;
  return (
    ((bytes[at] ?? 0) * 0x1000000 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function le16(bytes: Uint8Array, at: number): number {
  if (at + 1 >= bytes.length) return -1;
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function le24(bytes: Uint8Array, at: number): number {
  if (at + 2 >= bytes.length) return -1;
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

/** True when the bytes at `at` spell `tag` (ASCII). */
function hasTag(bytes: Uint8Array, at: number, tag: string): boolean {
  if (at + tag.length > bytes.length) return false;
  for (let i = 0; i < tag.length; i += 1) {
    if (bytes[at + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** PNG: IHDR is always the first chunk; big-endian u32 width/height. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (!hasTag(bytes, 12, "IHDR")) return null;
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** GIF: logical screen descriptor, little-endian u16 at offsets 6 and 8. */
function gifSize(bytes: Uint8Array): ImageSize | null {
  const width = le16(bytes, 6);
  const height = le16(bytes, 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** WebP: three container flavours, each stating its size differently. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (hasTag(bytes, 12, "VP8X")) {
    const width = le24(bytes, 24);
    const height = le24(bytes, 27);
    return width >= 0 && height >= 0 ? { width: width + 1, height: height + 1 } : null;
  }
  if (hasTag(bytes, 12, "VP8L")) {
    if (bytes[20] !== 0x2f || bytes.length < 25) return null;
    const packed =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (hasTag(bytes, 12, "VP8 ")) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = le16(bytes, 26);
    const height = le16(bytes, 28);
    if (width < 0 || height < 0) return null;
    return { width: width & 0x3fff, height: height & 0x3fff };
  }
  return null;
}

/** JPEG: walk the marker segments to the first SOFn frame header. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    let marker = bytes[at + 1] ?? 0;
    let cursor = at + 1;
    while (marker === 0xff && cursor + 1 < bytes.length) {
      cursor += 1;
      marker = bytes[cursor] ?? 0;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at = cursor + 1;
      continue;
    }
    const length = be16(bytes, cursor + 1);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = be16(bytes, cursor + 4);
      const width = be16(bytes, cursor + 6);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null;
    at = cursor + 1 + length;
  }
  return null;
}

/**
 * Read an image's pixel dimensions from its HEADER — before anything decodes it.
 * Null means "could not be read", which callers must treat as a refusal.
 */
export function readImageDimensions(bytes: Uint8Array): ImageSize | null {
  switch (sniffImageMime(bytes)) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}

/**
 * May these bytes be handed to a decoder? False above the pixel budget AND for
 * anything whose header cannot be read — an image that will not state its own
 * size is exactly the shape a bomb takes.
 */
export function isWithinPixelBudget(bytes: Uint8Array): boolean {
  const size = readImageDimensions(bytes);
  if (!size) return false;
  if (size.width <= 0 || size.height <= 0) return false;
  return size.width * size.height <= MAX_IMAGE_PIXELS;
}

/** True when `width × height` is inside the budget (for already-decoded sizes). */
export function isPixelCountWithinBudget(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  return width * height <= MAX_IMAGE_PIXELS;
}
