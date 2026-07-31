/**
 * Image-action POLICY — the pure decision rules behind "save / copy a chat
 * image", split out of `image-actions.ts` so they can be unit-tested without an
 * Electron runtime (same split as system-idle-state.ts / pending-update.ts).
 *
 * Imports nothing from `electron`. Three jobs:
 *
 *  1. {@link isAllowedImageUrl} — the download allow-list. The renderer names
 *     the URL to fetch, so without this the main process would be a general
 *     "GET anything" proxy for whoever compromises the renderer, which is
 *     strictly MORE power than the renderer has itself (its CSP `connect-src`
 *     is pinned to our own API/WS origins). The gate closes that gap.
 *  2. {@link sanitizeSaveFileName} — the suggested save name. The path itself
 *     always comes from the OS dialog, so traversal is structurally impossible;
 *     this exists so a hostile/junk suggestion cannot pre-fill the dialog with
 *     `..\..\Startup\x.png`, a drive letter, control characters, or a Windows
 *     reserved device name.
 *  3. {@link sniffImageMime} — trust the BYTES, not the declared MIME. A body
 *     that is not actually one of the four whitelisted image formats is never
 *     written to disk or handed to the clipboard.
 */

import { ATTACHMENT_LIMITS } from "@demli/config";

/**
 * Byte cap for one image action. Deliberately the SAME number the API enforces
 * when the image was uploaded (`ATTACHMENT_LIMITS.image.maxBytes`, 10 MB), so a
 * file that was allowed in can always come back out and nothing bigger can.
 */
export const IMAGE_ACTION_MAX_BYTES: number = ATTACHMENT_LIMITS.image.maxBytes;

/** Longest URL we will even parse — a signed URL is ~400 chars. */
export const IMAGE_ACTION_MAX_URL_LENGTH = 2048;

/** Longest suggested name accepted from the renderer, before sanitizing. */
export const IMAGE_ACTION_MAX_NAME_INPUT = 255;

/** Longest base name (extension excluded) we will offer in the save dialog. */
const MAX_BASE_LENGTH = 100;

/**
 * The image MIMEs an action may target — exactly the API's upload whitelist, so
 * the two ends can never disagree. SVG is absent there (stored-XSS) and must
 * stay absent here.
 */
export const SAVABLE_IMAGE_MIMES: readonly string[] = ATTACHMENT_LIMITS.image.mimes;

/** File extension used when saving each whitelisted MIME. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Every extension the map above can produce, plus the jpeg alias. */
const KNOWN_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp", "gif"];

/** Characters Windows forbids in a file name (control bytes handled separately). */
const ILLEGAL_NAME_CHARS = new Set(['<', '>', ':', '"', "|", "?", "*", "/", "\\"]);

/** Windows device names that cannot be used as a file name, even with an extension. */
const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Name used when the suggestion sanitizes down to nothing. */
const FALLBACK_BASE = "image";

/** True when `mime` is one of the four whitelisted image types. */
export function isSavableImageMime(mime: string): boolean {
  return SAVABLE_IMAGE_MIMES.includes(mime);
}

/** The file extension (no dot) for a whitelisted MIME; "png" as a safe default. */
export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? "png";
}

/**
 * Split a build-time origin spec (space- or comma-separated) into normalized
 * https origins. Anything unparsable or non-https is dropped rather than
 * throwing, so a malformed build env degrades to the locked-down default
 * instead of crashing the app at startup.
 */
export function parseAllowedOrigins(spec: string): string[] {
  const out: string[] = [];
  for (const token of spec.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:") continue;
      if (!out.includes(url.origin)) out.push(url.origin);
    } catch {
      // Not a URL — ignore this token.
    }
  }
  return out;
}

/**
 * Resolve the download allow-list from the build-time constant plus, for
 * UNPACKAGED runs only, the process environment.
 *
 * `isPackaged` is a parameter (not `app.isPackaged` read in here) so this stays
 * free of `electron` and is unit-testable in plain Node — the same shape as
 * `resolveUserDataPath`.
 *
 * Why the packaged case ignores the environment entirely: in a shipped app the
 * environment belongs to whoever launched the process. On Windows any user can
 * write `HKCU\Environment` without administrator rights, so honouring
 * `DEMLI_STORAGE_ORIGIN` there would let a local attacker append an origin to
 * a security-critical allow-list from outside the app — turning a dev
 * convenience into a supply route. Build-time pinning is the only input a
 * release trusts.
 */
export function resolveImageActionOrigins(
  baked: string,
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): string[] {
  const fromEnv = isPackaged
    ? ""
    : [
        env["DEMLI_STORAGE_ORIGIN"] ?? "",
        env["DEMLI_DOMAIN"] ? `https://api.${env["DEMLI_DOMAIN"]}` : "",
      ].join(" ");
  return parseAllowedOrigins(`${baked} ${fromEnv}`);
}

/** Parse "a.b.c.d" into four octets, or null when it is not an IPv4 literal. */
function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Parse an IPv6 literal (already stripped of its brackets) into eight 16-bit
 * hextets, or null when it is not one.
 *
 * Handles `::` compression AND a trailing dotted-quad (`::ffff:127.0.0.1`),
 * because that trailing form is exactly how an IPv4 target is smuggled through
 * an IPv6-shaped host. Note that the WHATWG URL parser has usually already
 * rewritten the dotted tail into hex (`[::ffff:127.0.0.1]` arrives as
 * `[::ffff:7f00:1]`), which is precisely why a prefix-string check on the raw
 * host is not enough — the numbers have to be parsed.
 */
function parseIpv6(literal: string): number[] | null {
  let text = literal;
  if (!text.includes(":")) return null;

  // A trailing dotted-quad carries the low 32 bits; fold it into two hextets so
  // the rest of the parser only ever sees hex.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toHextets = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const head = toHextets(halves[0] ?? "");
  if (!head) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const rest = toHextets(halves[1] ?? "");
  if (!rest) return null;
  const zeros = 8 - head.length - rest.length;
  if (zeros < 1) return null;
  return [...head, ...Array.from({ length: zeros }, () => 0), ...rest];
}

/** True for loopback, private, link-local, CGNAT and "this network" IPv4. */
function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * True for IPv6 we refuse: loopback/unspecified, unique-local (fc00::/7),
 * link-local (fe80::/10), deprecated site-local (fec0::/10) — plus every form
 * that EMBEDS an IPv4 address, which is re-checked against the IPv4 rules:
 *
 *   ::ffff:a.b.c.d   IPv4-mapped      (`[::ffff:169.254.169.254]` = cloud metadata)
 *   ::a.b.c.d        IPv4-compatible  (also covers `::1` and `::`)
 *   64:ff9b::a.b.c.d NAT64 well-known prefix
 *   2002:AABB:CCDD:: 6to4, IPv4 in bits 16-48
 */
function isBlockedIpv6(hextets: readonly number[]): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = hextets;
  const asOctets = (high: number, low: number): number[] => [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ];

  const zeroTo4 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  const mapped = zeroTo4 && h5 === 0xffff; // ::ffff:a.b.c.d
  const compatible = zeroTo4 && h5 === 0; // ::a.b.c.d, ::1, ::
  const nat64 = h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  if (mapped || compatible || nat64) return isBlockedIpv4(asOctets(h6, h7));
  if (h0 === 0x2002) return isBlockedIpv4(asOctets(h1, h2)); // 6to4

  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

/**
 * Name suffixes that only ever resolve inside a private network. `.local` is
 * mDNS; the rest are the RFC 6762/8375 private-use and vendor conventions —
 * `metadata.google.internal` is the reason `.internal` is on the list, since it
 * is multi-label and would otherwise sail past the single-label check below.
 */
const INTERNAL_NAME_SUFFIXES: readonly string[] = [
  ".local",
  ".localhost",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
];

/**
 * Hosts we refuse regardless of the allow-list: loopback, link-local, private
 * and carrier-grade-NAT ranges, plus internal-only names. These are exactly the
 * targets an SSRF would aim at, and no public storage origin is ever one of
 * them — so blocking them costs nothing.
 *
 * The normalization matters as much as the ranges: a TRAILING DOT
 * (`localhost.`) is a fully-qualified spelling of the same name that a naive
 * `=== "localhost"` misses, and an IPv4 literal wearing IPv6 clothes
 * (`[::ffff:169.254.169.254]`) is the same address as `169.254.169.254`.
 */
export function isBlockedImageHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    // A trailing dot is the root label: "localhost." IS "localhost".
    .replace(/\.+$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  if (INTERNAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);

  if (host.includes(":")) {
    const ipv6 = parseIpv6(host);
    // An IPv6-shaped host we cannot parse is refused rather than guessed at.
    return ipv6 === null ? true : isBlockedIpv6(ipv6);
  }

  // A single-label name ("intranet", "storage") only resolves inside a private
  // network. Public storage hosts always carry a dot.
  return !host.includes(".");
}

/**
 * Is this URL one the main process may download an image from?
 *
 * `allowedOrigins` is pinned at BUILD time (see `electron.vite.config.ts`:
 * DEMLI_STORAGE_ORIGIN / DEMLI_DOMAIN). The origin must match one of them
 * EXACTLY — same scheme, host and port; a sibling subdomain or a different port
 * is refused.
 *
 * AN EMPTY LIST REFUSES EVERYTHING. This is deliberate and it is the whole
 * security posture of the feature (security review 2026-07-27): the renderer
 * chooses the URL, so main without a pinned list would be a general "GET
 * anything on the public internet" proxy — strictly MORE power than the renderer
 * has itself, whose CSP `connect-src` is pinned to our own origins. Leaning on
 * that CSP to bound main's reach makes a renderer-side policy the only thing
 * standing between a compromised renderer and arbitrary outbound requests from
 * the privileged process, and CSP directives get relaxed for unrelated reasons.
 *
 * Fail-closed is also the LOUDER failure: an unpinned build has no image
 * actions at all (the menu entries are not rendered — see the `saveSupported` /
 * `copySupported` flags on the bridge), which someone notices in QA. A silently
 * widened allow-list is indistinguishable from a correct build.
 */
export function isAllowedImageUrl(raw: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  if (!raw || raw.length > IMAGE_ACTION_MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Credentials in the URL are never legitimate here and are a classic way to
  // make a parsed origin look different from where the request actually goes.
  if (url.username || url.password) return false;
  if (isBlockedImageHost(url.hostname)) return false;
  return allowedOrigins.includes(url.origin);
}

/**
 * True when this build can perform image actions at all — i.e. it pinned at
 * least one storage origin. Read by the preload so the UI can OMIT the menu
 * entries on an unpinned build instead of offering a button that always fails
 * (CLAUDE.md §35).
 */
export function hasImageActionOrigins(allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.length > 0;
}

/**
 * Bidirectional-text controls. They are invisible, they survive every ordinary
 * "is this a safe character" filter, and they make the name RENDERED in the save
 * dialog differ from the name actually written to disk: `holidayU+202Egnp.png`
 * displays as `holidaypng.gnp`. The real extension is forced from the sniffed
 * MIME, so this cannot manufacture an executable — but a name that lies about
 * itself is not something we hand to the OS dialog either.
 *
 * Covers the LRE/RLE/PDF/LRO/RLO block, the LRM/RLM marks, and the U+2066-2069
 * isolates.
 */
function isBidiControl(code: number): boolean {
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code === 0x200e || code === 0x200f) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

/**
 * Drop directory separators, control bytes, bidi overrides and Windows-illegal
 * punctuation. Implemented as a character scan rather than a regex so this file
 * contains no literal control byte and needs no `no-control-regex` escape hatch.
 */
function stripUnsafeCharacters(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    if (isBidiControl(code)) continue;
    if (ILLEGAL_NAME_CHARS.has(char)) continue;
    out += char;
  }
  return out;
}

/**
 * Turn an arbitrary suggested name into something safe to pre-fill a save
 * dialog with, and force the extension to match the image's real MIME.
 *
 * Strips: directory components (so `..` and `../../x` collapse to their last
 * segment), a leading drive letter, control characters, the Windows-illegal
 * `<>:"|?*` set, and trailing dots/spaces (which Windows silently drops,
 * turning `evil.png.` into `evil.png`). Reserved device names are prefixed.
 */
export function sanitizeSaveFileName(raw: string, mime: string): string {
  const extension = extensionForMime(mime);
  const input = typeof raw === "string" ? raw.slice(0, IMAGE_ACTION_MAX_NAME_INPUT) : "";

  // Last path segment only — kills `../`, `..\`, and any absolute path.
  const segments = input.split(/[/\\]/);
  let name = segments[segments.length - 1] ?? "";

  // A drive-relative form like `C:image.png` has no separator to split on.
  name = name.replace(/^[A-Za-z]:/, "");
  name = stripUnsafeCharacters(name);
  name = name.replace(/\s+/g, " ").trim();
  // Windows drops trailing dots/spaces; do it ourselves so what we show is what
  // the OS would actually create.
  name = name.replace(/[. ]+$/, "");

  // Drop a known image extension so we never produce "photo.png.png"; anything
  // else (".exe", ".tar.gz") stays part of the base and is neutralized by the
  // extension we append.
  let base = name;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && KNOWN_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase())) {
    base = base.slice(0, dot);
  }

  base = base.replace(/^[. ]+/, "").trim();
  if (!base) base = FALLBACK_BASE;
  // Win32 resolves a device by the label BEFORE the first dot: `con.txt` is
  // still the CON device, so checking the whole base would miss it.
  // (trailing spaces in the label are ignored by Win32 too: `con .txt` = CON)
  const firstLabel = (base.split(".")[0] ?? "").trim().toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(firstLabel)) base = `_${base}`;
  if (base.length > MAX_BASE_LENGTH) base = base.slice(0, MAX_BASE_LENGTH).trim() || FALLBACK_BASE;

  return `${base}.${extension}`;
}

/**
 * Identify the image format from its leading bytes, or null when the body is
 * not one of the four whitelisted formats. This is the check that matters: the
 * declared MIME comes from the renderer and the `Content-Type` header comes
 * from the network, but the magic number comes from the bytes we are about to
 * write.
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
  return null;
}

/**
 * MIMEs `nativeImage.createFromBuffer` can decode into a clipboard bitmap.
 * Electron documents PNG and JPEG only; webp/gif produce an EMPTY image, which
 * would silently put nothing on the clipboard. We detect that up front and
 * report `unsupported_format` so the user gets a real sentence instead of a
 * button that appears to work (CLAUDE.md §26/§35).
 */
export function isClipboardDecodableMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg";
}

// ---------------------------------------------------------------------------
// Decompression-bomb guard
// ---------------------------------------------------------------------------

/**
 * Largest image we will DECODE, in pixels (64 MP ≈ 9800×6500 — far above any
 * real photo or screenshot, and ~256 MB once expanded to RGBA).
 *
 * The byte cap alone does not bound decoding. A single-colour 40000×40000 PNG
 * compresses to a few hundred KB — comfortably inside the 10 MB limit — and
 * expands to ~6.4 GB of RGBA in the MAIN process, which is an out-of-memory
 * crash of the whole app, remotely triggerable by anyone who can post an image
 * in a group. The byte cap answers "how much did we download"; this answers
 * "how much will it become".
 */
export const IMAGE_ACTION_MAX_PIXELS = 64_000_000;

/** Big-endian 16/32-bit reads, returning -1 past the end of the buffer. */
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

/** True when the four bytes at `at` spell `tag` (ASCII). */
function hasTag(bytes: Uint8Array, at: number, tag: string): boolean {
  if (at + tag.length > bytes.length) return false;
  for (let i = 0; i < tag.length; i += 1) {
    if (bytes[at + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

type ImageSize = { width: number; height: number };

/** PNG: IHDR is always the first chunk, width/height as big-endian u32. */
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

/** WebP: three container flavours, each stating the size in its own way. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (hasTag(bytes, 12, "VP8X")) {
    const width = le24(bytes, 24);
    const height = le24(bytes, 27);
    return width >= 0 && height >= 0 ? { width: width + 1, height: height + 1 } : null;
  }
  if (hasTag(bytes, 12, "VP8L")) {
    // 0x2f signature, then 14 bits of (width-1) and 14 bits of (height-1).
    if (bytes[20] !== 0x2f || bytes.length < 25) return null;
    const packed =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (hasTag(bytes, 12, "VP8 ")) {
    // Lossy key frame: 3-byte tag, the 0x9d012a start code, then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = le16(bytes, 26);
    const height = le16(bytes, 28);
    if (width < 0 || height < 0) return null;
    return { width: width & 0x3fff, height: height & 0x3fff };
  }
  return null;
}

/**
 * JPEG: walk the marker segments to the first SOFn frame header, which is the
 * only place the real dimensions live. Bounded by the buffer length, so a
 * malformed stream terminates instead of looping.
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1; // Re-sync on padding rather than giving up immediately.
      continue;
    }
    let marker = bytes[at + 1] ?? 0;
    // 0xFF fill bytes may repeat before the actual marker.
    let cursor = at + 1;
    while (marker === 0xff && cursor + 1 < bytes.length) {
      cursor += 1;
      marker = bytes[cursor] ?? 0;
    }
    // Standalone markers carry no length payload.
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
    if (marker === 0xda) return null; // Scan data begins; no SOF was found.
    at = cursor + 1 + length;
  }
  return null;
}

/**
 * Read an image's pixel dimensions from its HEADER — before anything decodes
 * it. Returns null when the header cannot be read, which callers must treat as
 * "refuse", not "probably fine".
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
 * May these bytes be handed to a decoder? False for anything above the pixel
 * budget AND for anything whose header we cannot read — an image that will not
 * state its own size is exactly the shape a bomb takes, so the answer is no.
 */
export function isWithinPixelBudget(bytes: Uint8Array): boolean {
  const size = readImageDimensions(bytes);
  if (!size) return false;
  if (size.width <= 0 || size.height <= 0) return false;
  return size.width * size.height <= IMAGE_ACTION_MAX_PIXELS;
}
