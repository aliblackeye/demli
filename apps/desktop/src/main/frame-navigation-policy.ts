/**
 * Where a SUBFRAME of the app window is allowed to navigate (Watch Party, M20 /
 * ADR 0016).
 *
 * Pure and electron-free so the decision can be unit-tested — the same shape as
 * `image-actions-policy.ts`, and for the same reason: a security predicate that
 * can only be exercised by launching the app is a security predicate nobody
 * exercises.
 *
 * ## Why this exists at all
 *
 * Until this feature the app had no iframes, so `will-navigate` (main frame
 * only) was the entire navigation story. Adding an embed changes that: a
 * subframe can navigate itself, and `will-navigate` never fires for it. The CSP
 * `frame-src` decides what may be LOADED into a frame in the first place; this
 * decides where that frame may go afterwards. Neither replaces the other.
 *
 * ## Why hostnames, not prefixes
 *
 * `url.startsWith("https://www.youtube-nocookie.com")` is true for
 * `https://www.youtube-nocookie.com.evil.test/`, which is a completely different
 * site. Parsing the URL and comparing `hostname` cannot be fooled that way, and
 * anything that fails to parse is refused rather than guessed at.
 */

/**
 * The exact hosts a subframe may reach.
 *
 * `youtube.com` is on this list even though our document only ever embeds the
 * NOCOOKIE URL: during normal playback the embed navigates its own inner frames
 * between the two hosts, and denying that breaks the player outright. It is
 * deliberately NOT added to the CSP `frame-src`, because that directive governs
 * what OUR document may embed — and the answer there stays "the nocookie host,
 * and nothing else".
 */
export const ALLOWED_FRAME_HOSTS: readonly string[] = [
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "www.youtube.com",
  "youtube.com",
];

/**
 * True when a subframe may navigate to `url`.
 *
 * Fails CLOSED: an unparseable URL, a non-https scheme (`javascript:`, `file:`,
 * `data:`, a custom protocol) and any host outside the list are all refused.
 *
 * The one non-https exception is `about:blank` EXACTLY — what a fresh iframe
 * starts on and what the player uses for its own helper frames; it carries no
 * content of anybody's choosing. Matching the whole `about:` scheme instead
 * would also wave through `about:srcdoc`, whose content IS chosen by whoever
 * wrote the embedding markup. Nothing in this app creates such a frame today,
 * so this is a narrowing, not a fix — but a predicate that reads "any about:
 * URL" is one refactor away from meaning it.
 */
export function isAllowedFrameUrl(url: string): boolean {
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_FRAME_HOSTS.includes(parsed.hostname.toLowerCase());
}
