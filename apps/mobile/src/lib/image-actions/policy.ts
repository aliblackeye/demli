/**
 * Image-action POLICY — the pure decision rules behind "save / copy a chat
 * image" on mobile. Imports nothing native, so every rule below is unit-tested
 * in the node-only mobile vitest run rather than only on a device.
 *
 * This is the mobile twin of `apps/desktop/src/main/image-actions-policy.ts`.
 * The two are deliberately SEPARATE files: the desktop copy lives inside the
 * Electron main process (which mobile cannot import) and enforces Windows file-
 * name rules, while this one enforces Android/SAF rules and a clipboard format
 * gate that has no desktop equivalent. The RULES they share — https-only, no
 * private hosts, the 10 MB cap from `ATTACHMENT_LIMITS`, trust the bytes not the
 * declared MIME — are kept identical on purpose and are the reason both files
 * quote the same constants from `@demli/config` instead of hardcoding them.
 *
 * Four jobs:
 *
 *  1. {@link isAllowedImageUrl} — the download allow-list. The action names a
 *     URL to fetch; without this the feature would be a general "GET anything"
 *     helper reachable from any code path that can build an action target.
 *  2. {@link sanitizeSaveFileName} — the name handed to the SAF document
 *     creator. A name is not a path on SAF (the directory comes from the user's
 *     own picker), but a hostile suggestion must not be able to smuggle
 *     separators, control bytes or a bogus extension into it.
 *  3. {@link sniffImageMime} — trust the BYTES. The declared MIME comes from a
 *     DTO and the Content-Type from the network; the magic number comes from
 *     what we are about to write.
 *  4. {@link isClipboardCopyableMime} — Android's clipboard takes a bitmap, and
 *     `expo-clipboard`'s `setImageAsync` decodes PNG/JPEG only. WebP and GIF
 *     would silently leave the clipboard empty, so they are refused UP FRONT
 *     with a reason the UI can put into a real sentence (CLAUDE.md §26/§35).
 */

import { ATTACHMENT_LIMITS } from "@demli/config";
import type { Attachment } from "@demli/types";

/**
 * Byte cap for one image action — the SAME number the API enforced when the
 * image was uploaded, so a file that was allowed in can always come back out
 * and nothing bigger can.
 */
export const IMAGE_ACTION_MAX_BYTES: number = ATTACHMENT_LIMITS.image.maxBytes;

/** Longest URL we will even parse — a signed storage URL is ~400 chars. */
export const IMAGE_ACTION_MAX_URL_LENGTH = 2048;

/** Longest suggested name accepted before sanitizing. */
export const IMAGE_ACTION_MAX_NAME_INPUT = 255;

/** Longest base name (extension excluded) we will create. */
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

/**
 * Characters that may not appear in a saved file name. Android's own filesystem
 * only forbids `/` and NUL, but a file saved through SAF can land on a FAT32 SD
 * card or be synced to a Windows machine, so we apply the strict set — the same
 * one the desktop policy uses, which also keeps the two names identical for the
 * same image.
 */
const ILLEGAL_NAME_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*", "/", "\\"]);

/** Windows device names that cannot be used as a file name, even with an extension. */
const RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Name used when a suggestion sanitizes down to nothing. */
const FALLBACK_BASE = "image";

/** Prefix for generated names, so a saved file is recognisable in a gallery. */
const NAME_PREFIX = "demli-image";

/** True when `mime` is one of the four whitelisted image types. */
export function isSavableImageMime(mime: string): boolean {
  return SAVABLE_IMAGE_MIMES.includes(mime);
}

/**
 * Can this format go on the system clipboard AS AN IMAGE?
 *
 * `expo-clipboard.setImageAsync` takes a base64 PNG/JPEG and decodes it to a
 * bitmap natively; handing it a WebP or GIF payload does not throw, it just puts
 * nothing usable on the clipboard. Detecting that here is what lets the UI say
 * "this format can't be copied — save it instead" rather than leaving the user
 * with a button that appeared to work.
 */
export function isClipboardCopyableMime(mime: string): boolean {
  return mime === "image/png" || mime === "image/jpeg";
}

/** The file extension (no dot) for a whitelisted MIME; "png" as a safe default. */
export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? "png";
}

/**
 * Split an origin spec (space- or comma-separated) into normalized https
 * origins. Anything unparsable or non-https is dropped rather than throwing, so
 * a malformed build env degrades to the locked-down default instead of crashing
 * the app at startup.
 */
export function parseAllowedOrigins(spec: string | undefined | null): string[] {
  const out: string[] = [];
  for (const token of (spec ?? "").split(/[\s,]+/)) {
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
 * Hosts we refuse regardless of the allow-list: loopback, link-local, private
 * and carrier-grade-NAT ranges, plus single-label (intranet) names. On a phone
 * these are the router's admin page and whatever else sits on the user's home
 * Wi-Fi — exactly what an SSRF would aim at, and never a storage origin.
 */
export function isBlockedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a = 0, b = 0] = ipv4;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    // IPv6 literal: loopback, unique-local (fc00::/7), link-local (fe80::/10).
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    return false;
  }

  // A single-label name ("intranet", "storage") only resolves inside a private
  // network. Public storage hosts always carry a dot.
  return !host.includes(".");
}

/**
 * May we download an image from this URL?
 *
 * `allowedOrigins` is pinned at BUILD time from `EXPO_PUBLIC_STORAGE_ORIGIN`
 * (see ./config). When it is non-empty the origin must match one of them
 * EXACTLY — same scheme, host and port; a sibling subdomain or a different port
 * is refused.
 *
 * When it is empty (a build that pinned no origin) we fall back to "any public
 * https host", the same fallback the desktop policy takes in that configuration.
 * That keeps the feature working instead of shipping a dead button, and the
 * residual power is bounded three ways: the URL is never user-typed (it is the
 * signed URL our own API just handed the resolver for THIS attachment and the
 * `<Image>` is already displaying), no credentials or cookies are sent, and
 * anything that is not a whitelisted image under the byte cap is discarded
 * before it reaches the disk or the clipboard.
 */
export function isAllowedImageUrl(raw: string, allowedOrigins: readonly string[]): boolean {
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
  if (allowedOrigins.length > 0) return allowedOrigins.includes(url.origin);
  return true;
}

/**
 * Drop directory separators, control bytes and illegal punctuation. A character
 * scan rather than a regex so this file contains no literal control byte and
 * needs no `no-control-regex` escape hatch.
 */
function stripUnsafeCharacters(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) continue;
    if (ILLEGAL_NAME_CHARS.has(char)) continue;
    out += char;
  }
  return out;
}

/**
 * Turn an arbitrary suggested name into something safe to create, and force the
 * extension to match the image's real MIME.
 *
 * Strips: directory components (so `..` and `../../x` collapse to their last
 * segment), a leading drive letter, control characters, the illegal `<>:"|?*`
 * set, and trailing dots/spaces. Reserved device names are prefixed.
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
  name = name.replace(/[. ]+$/, "");

  // Drop a known image extension so we never produce "photo.png.png"; anything
  // else (".apk", ".tar.gz") stays part of the base and is neutralized by the
  // extension we append.
  let base = name;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && KNOWN_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase())) {
    base = base.slice(0, dot);
  }

  base = base.replace(/^[. ]+/, "").trim();
  if (!base) base = FALLBACK_BASE;
  if (RESERVED_DEVICE_NAMES.has(base.toLowerCase())) base = `_${base}`;
  if (base.length > MAX_BASE_LENGTH) base = base.slice(0, MAX_BASE_LENGTH).trim() || FALLBACK_BASE;

  return `${base}.${extension}`;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * The file name offered for a saved attachment.
 *
 * The original upload name is NOT recoverable: `attachments` stores a random
 * UUID object key and the DTO carries no `filename` (ADR 0008 — the storage
 * layout is server-internal). We therefore generate a stable, sortable one from
 * the attachment's own creation time plus a short id suffix; without the suffix
 * two images posted in the same SECOND (the normal multi-select upload) would
 * both default to the same name. Byte-for-byte the same scheme desktop uses, so
 * the same picture saved from either client lands under the same name.
 */
export function imageSaveFileName(attachment: Pick<Attachment, "id" | "mime" | "createdAt">): string {
  const extension = extensionForMime(attachment.mime);
  const parsed = new Date(attachment.createdAt);
  const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const suffix = attachment.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4) || "0000";
  return `${NAME_PREFIX}-${stamp}-${suffix}.${extension}`;
}

/**
 * Identify the image format from its leading bytes, or null when the body is
 * not one of the four whitelisted formats. This is the check that matters: the
 * declared MIME comes from a DTO and the `Content-Type` from the network, but
 * the magic number comes from the bytes we are about to write.
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
 * Is this a `file://` URI inside our OWN app sandbox?
 *
 * This case is not a loophole, it is the sender's own image. After you post a
 * picture, `attachmentUrlResolver.setLocalUrl` serves the LOCAL cache file as
 * that tile's render URL — permanently, so the sender's own message never waits
 * on a round-trip (see the resolver's `local` entries). Without this branch,
 * "save"/"copy" on the photo you just sent always failed while the same photo
 * worked fine after a relaunch: a founder-visible inconsistency with no visible
 * cause. Caught on the emulator, not in review.
 *
 * The rule stays narrow. It is not "any file:// URI" — it is a path under one of
 * the roots we ourselves write to (cache / documents), which is where the picker
 * copy and the resize output live. `..` in any form is refused rather than
 * normalized, so no encoded traversal can climb out of a root, and the query/
 * fragment-free `pathname` is compared after a single decode.
 */
export function isOwnAppFileUri(raw: string, roots: readonly string[]): boolean {
  if (!raw || raw.length > IMAGE_ACTION_MAX_URL_LENGTH) return false;
  if (!raw.startsWith("file:///")) return false;
  // Refuse traversal outright — literal or percent-encoded — instead of trying
  // to normalize it away.
  if (raw.includes("..") || /%2e/i.test(raw) || /%00/i.test(raw)) return false;

  let path: string;
  try {
    path = decodeURIComponent(new URL(raw).pathname);
  } catch {
    return false;
  }
  if (path.includes("..") || path.includes("\0")) return false;

  for (const root of roots) {
    if (!root) continue;
    let rootPath: string;
    try {
      rootPath = decodeURIComponent(new URL(root).pathname);
    } catch {
      continue;
    }
    if (!rootPath) continue;
    const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
    if (path.startsWith(prefix) && path.length > prefix.length) return true;
  }
  return false;
}

/** Where an image action's bytes come from, or null when the URI is refused. */
export type ImageSourceKind =
  /** A signed https URL that must be downloaded. */
  | "remote"
  /** A file we already wrote inside our own sandbox — read it in place. */
  | "local";

/**
 * The ONE gate both actions run before touching any bytes. Returns null when the
 * URI is neither an allowed remote origin nor our own local file, which the
 * caller reports as `not_allowed`.
 */
export function imageSourceKind(
  raw: string,
  scope: { allowedOrigins: readonly string[]; localRoots: readonly string[] },
): ImageSourceKind | null {
  if (isAllowedImageUrl(raw, scope.allowedOrigins)) return "remote";
  if (isOwnAppFileUri(raw, scope.localRoots)) return "local";
  return null;
}

/** The standard base64 alphabet, index = 6-bit value. */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode the FIRST `maxBytes` bytes of a base64 payload.
 *
 * Exists so {@link sniffImageMimeFromBase64} can check a magic number without a
 * second full read of the file: a 10 MB image is a ~13 MB base64 string, and
 * loading its bytes again purely to look at twelve of them would double the peak
 * memory of a save on a phone. Whitespace/newlines are skipped and padding ends
 * the scan, so it accepts both wrapped and unwrapped base64.
 */
export function decodeBase64Prefix(base64: string, maxBytes = 16): Uint8Array {
  // 4 base64 chars carry 3 bytes; take a slice generous enough to survive
  // embedded newlines rather than walking the whole string.
  const head = base64.slice(0, Math.ceil((maxBytes * 4) / 3) + 16);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of head) {
    if (char === "=") break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) continue; // whitespace or a stray character — skip it
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= maxBytes) break;
    }
  }
  return new Uint8Array(out);
}

/** {@link sniffImageMime} over a base64 payload, reading only its head. */
export function sniffImageMimeFromBase64(base64: string): string | null {
  return sniffImageMime(decodeBase64Prefix(base64, 16));
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Why an image action did not complete. A closed union so the UI's mapping to a
 * sentence is exhaustive and a new reason cannot be added without deciding what
 * the user is told (CLAUDE.md §26 — never a raw reason code on screen).
 */
export type ImageActionFailure =
  /** URL rejected by {@link isAllowedImageUrl}, or its MIME is not savable. */
  | "not_allowed"
  /** Network failed, the body was not a whitelisted image, or it broke the cap. */
  | "download_failed"
  /** The chosen directory refused the write (full card, revoked grant). */
  | "write_failed"
  /** The clipboard write itself failed. */
  | "clipboard_failed"
  /** WebP/GIF — the clipboard cannot take this format at all. */
  | "unsupported_format";

/**
 * The result of one action. `canceled` is a first-class outcome, not an error:
 * dismissing the folder picker (or the iOS share sheet) is a normal choice and
 * must produce NO message at all — the same contract desktop's save dialog has.
 */
export type ImageActionResult =
  | { status: "saved" }
  | { status: "copied" }
  | { status: "canceled" }
  | { status: "error"; reason: ImageActionFailure };

/** Every line an image action can produce, as typed i18n keys. */
export type ImageActionNoticeKey =
  | "mobile:attachments.saved"
  | "mobile:attachments.copied"
  | "mobile:attachments.saveFailed"
  | "mobile:attachments.copyFailed"
  | "mobile:attachments.copyUnsupported";

export interface ImageActionNotice {
  tone: "ok" | "error";
  key: ImageActionNoticeKey;
}

/**
 * Reduce a result to the one line the user sees, or `null` for "say nothing".
 *
 * Deliberately coarse: the only distinction worth making to a human is "this
 * format cannot be copied" versus "it did not work". Which internal rule
 * refused a URL is not the user's problem and naming it would only teach an
 * attacker the shape of the allow-list.
 */
export function imageActionNotice(
  action: "save" | "copy",
  result: ImageActionResult,
): ImageActionNotice | null {
  if (result.status === "canceled") return null;
  if (result.status === "saved") return { tone: "ok", key: "mobile:attachments.saved" };
  if (result.status === "copied") return { tone: "ok", key: "mobile:attachments.copied" };
  if (action === "copy" && result.reason === "unsupported_format") {
    return { tone: "error", key: "mobile:attachments.copyUnsupported" };
  }
  return {
    tone: "error",
    key: action === "save" ? "mobile:attachments.saveFailed" : "mobile:attachments.copyFailed",
  };
}
