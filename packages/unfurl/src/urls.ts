/**
 * Extract candidate http(s) URLs from message content (M17). Deliberately
 * conservative: only absolute http/https URLs, de-duplicated (case-insensitive
 * on the whole URL), capped at `max`, in first-seen order. The heavy validation
 * (protocol, DNS + SSRF, content-type) happens later in the fetcher — this only
 * finds candidates.
 */

import { UNFURL_MAX_URLS_PER_MESSAGE, UNFURL_URL_MAX } from "./constants.js";

// Match http(s):// followed by non-space, non-angle-bracket characters. Trailing
// punctuation that is usually sentence punctuation (not part of the URL) is
// trimmed afterward. Angle brackets are excluded so we never capture markup.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Characters commonly trailing a URL in prose that are not part of it. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "»", "”"]);

function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING.has(url[end - 1] ?? "")) {
    // Keep a closing paren when the URL contains a matching opening one
    // (e.g. Wikipedia "..._(disambiguation)"): only trim ')' when unbalanced.
    const ch = url[end - 1];
    if (ch === ")") {
      const opens = (url.slice(0, end).match(/\(/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\)/g) ?? []).length;
      if (opens >= closes) break;
    }
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Return up to `max` distinct http(s) URLs from `content`, in first-seen order.
 * A URL longer than {@link UNFURL_URL_MAX} is skipped (defensive). Never throws.
 */
export function extractUrls(
  content: string,
  max: number = UNFURL_MAX_URLS_PER_MESSAGE,
): string[] {
  if (!content || max <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = content.match(URL_RE);
  if (!matches) return out;

  for (const raw of matches) {
    const trimmed = trimTrailing(raw);
    if (trimmed.length === 0 || trimmed.length > UNFURL_URL_MAX) continue;
    // Validate it parses as an absolute http(s) URL.
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}
