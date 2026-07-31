/**
 * Unfurl (link preview) limits (M17). Security- and abuse-relevant caps live
 * here so the SSRF guard, fetcher, parser, and service share one source of
 * truth. See CLAUDE.md §28 (SSRF is life-or-death) and the design brief.
 */

/** At most this many URLs per message are unfurled (the first N in content). */
export const UNFURL_MAX_URLS_PER_MESSAGE = 3;

/** Per-request timeout for a single page fetch. */
export const UNFURL_FETCH_TIMEOUT_MS = 5_000;

/** Hard cap on bytes read from a page body (OG tags live early in `<head>`). */
export const UNFURL_MAX_RESPONSE_BYTES = 512 * 1024;

/** Redirects followed, each re-validated by the SSRF guard before the next hop. */
export const UNFURL_MAX_REDIRECTS = 3;

/** In-memory positive+negative result cache TTL (per URL). */
export const UNFURL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Per-user cap on ACTUAL outbound fetches (cache misses) in a rolling minute. */
export const UNFURL_PER_USER_FETCHES_PER_MINUTE = 30;

/**
 * UA sent on every fetch — identifies the bot and points at the product.
 *
 * The URL must resolve: it is the only way an operator whose site we fetched can
 * find out who we are. It pointed at the retired `karagozali.com` until
 * 2026-07-30, which made this a dead link on someone else's access log.
 */
export const UNFURL_USER_AGENT =
  "DemliBot/1.0 (+https://getdemli.com; link preview)";

/** Trim caps for the parsed OG fields (defense against oversized metadata). */
export const UNFURL_TITLE_MAX = 300;
export const UNFURL_DESCRIPTION_MAX = 1000;
export const UNFURL_SITE_NAME_MAX = 120;
export const UNFURL_URL_MAX = 2048;
