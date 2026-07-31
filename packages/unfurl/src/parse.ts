/**
 * Lightweight OpenGraph / `<meta>` parser (M17). Deliberately regex-based — no
 * `cheerio`/DOM dependency (design decision: a full HTML parser is overkill for
 * reading a handful of `<head>` meta tags, and every extra dependency is attack
 * surface on server-fetched, attacker-influenced HTML). We only READ text/URL
 * attributes and never execute or re-serialize the HTML, so a tolerant regex
 * scan is sufficient and safe.
 *
 * Precedence: `og:*` wins, then `twitter:*`, then the bare `<title>` /
 * `<meta name="description">` fallbacks. All output is trimmed, entity-decoded,
 * length-capped, and (for the image) resolved to an absolute http(s) URL.
 */

import {
  UNFURL_DESCRIPTION_MAX,
  UNFURL_SITE_NAME_MAX,
  UNFURL_TITLE_MAX,
  UNFURL_URL_MAX,
} from "./constants.js";

export interface ParsedEmbed {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

const META_RE = /<meta\b[^>]*>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

/** Read one attribute's value from a single tag string (quoted or bare). */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

/** Decode the handful of HTML entities that show up in meta content. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_s, hex: string) =>
      safeCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_s, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Trim, decode, collapse whitespace, cap length; empty → null. */
function clean(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** Build a property/name → content map from all `<meta>` tags (first wins). */
function metaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  META_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_RE.exec(html)) !== null) {
    const tag = m[0];
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (key && content !== null && !map.has(key)) map.set(key, content);
  }
  return map;
}

/** Resolve a candidate image URL against the page URL; only absolute http(s). */
function resolveImage(raw: string | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const decoded = decodeEntities(raw).trim();
  if (decoded.length === 0 || decoded.length > UNFURL_URL_MAX) return null;
  let resolved: URL;
  try {
    resolved = new URL(decoded, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
  return resolved.toString();
}

/**
 * Parse OpenGraph/meta from `html`. `baseUrl` is the FINAL fetched URL (after
 * redirects), used to resolve a relative `og:image`. Never throws; a page with
 * no usable metadata returns all-null (the service then stores no card).
 */
export function parseOpenGraph(html: string, baseUrl: string): ParsedEmbed {
  const meta = metaMap(html);

  const titleTag = TITLE_RE.exec(html)?.[1];
  const title = clean(
    meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag,
    UNFURL_TITLE_MAX,
  );
  const description = clean(
    meta.get("og:description") ??
      meta.get("twitter:description") ??
      meta.get("description"),
    UNFURL_DESCRIPTION_MAX,
  );
  const siteName = clean(meta.get("og:site_name"), UNFURL_SITE_NAME_MAX);
  const imageUrl = resolveImage(
    meta.get("og:image") ??
      meta.get("og:image:url") ??
      meta.get("og:image:secure_url") ??
      meta.get("twitter:image"),
    baseUrl,
  );

  return { title, description, imageUrl, siteName };
}
