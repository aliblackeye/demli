/**
 * Deep-link contract shared by the share/generate flows and the inbound
 * handlers. Clickable https links are recognized as links when shared (WhatsApp
 * etc.) and, on a device where the app is installed + verified, open Demli
 * directly to the right action (Android App Links / iOS Universal Links). The
 * custom `demli://` scheme is kept as a fallback.
 *
 * FIXED SERVER CONTRACT — must match the deploy side (the `app.$DOMAIN` vhost +
 * the `/.well-known/assetlinks.json` served there, and the desktop
 * download/landing fallback at `/kat/*` and `/arkadas/*`). Do NOT change the
 * host/paths without the server:
 *   https://app.getdemli.com/kat/<inviteCode>      -> join a server
 *   https://app.getdemli.com/arkadas/<friendCode>  -> add a friend
 *
 * Routing: Expo Router auto-maps these paths to the file routes
 * `app/kat/[code].tsx` and `app/arkadas/[code].tsx` for BOTH the https origin
 * and the custom schemes — expo-router strips the origin/scheme to a route
 * path itself (getLinkingConfig uses `prefixes: []` + its own extractor), so no
 * manual `prefixes` config is needed. The older `<scheme>://join/<code>` links
 * keep working via `app/(app)/join/[code].tsx`.
 */

/**
 * The https host that serves the App Links verification file + landing page.
 *
 * Must stay in lockstep with `app.json` (intentFilters + associatedDomains) and
 * with the Caddy vhost that serves `/.well-known/assetlinks.json`. Because the
 * intent filter is native, an OTA cannot repair an install that carries a wrong
 * host — only a new native build can. `app.getdemli.com` is used rather than a
 * fresh subdomain because it already resolves and a recipient without the app
 * installed lands on the web app instead of a static page.
 */
export const DEEP_LINK_HOST = "app.getdemli.com";
/** Origin used to build shareable https links. */
export const DEEP_LINK_ORIGIN = `https://${DEEP_LINK_HOST}`;

/** URL path segment that opens the join-a-server flow. */
export const INVITE_PATH = "kat";
/** URL path segment that opens the add-a-friend flow. */
export const FRIEND_PATH = "arkadas";

/** Build the shareable https link for a server invite code. */
export function buildInviteLink(code: string): string {
  return `${DEEP_LINK_ORIGIN}/${INVITE_PATH}/${encodeURIComponent(code)}`;
}

/** Build the shareable https link for a user's friend code. */
export function buildFriendLink(friendCode: string): string {
  return `${DEEP_LINK_ORIGIN}/${FRIEND_PATH}/${encodeURIComponent(friendCode)}`;
}

/**
 * Keep the last non-empty path segment of whatever the user pasted — a raw code,
 * a full https link, or a `demli://` link — dropping any `?`/`#` tail.
 */
function lastPathSegment(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  const segment = withoutQuery.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
    return segment;
  }
}

/** Extract a server-invite code from a pasted code or link. */
export function parseInviteCode(input: string): string {
  return lastPathSegment(input);
}

/**
 * Extract a friend code from a pasted code or link and canonicalize it the same
 * way the server does (`normalizeFriendCode`: uppercase, strip grouping/spaces
 * and any non-alnum) so a pasted "ABCD-2345", a lowercase code, or a full
 * `/arkadas/<code>` link all resolve.
 */
export function parseFriendCode(input: string): string {
  return lastPathSegment(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
}
