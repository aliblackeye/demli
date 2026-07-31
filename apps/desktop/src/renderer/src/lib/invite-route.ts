/**
 * Web-only `/invite/<kod>` route (app.getdemli.com invite links opened in a
 * BROWSER; the earlier `/kat/<kod>` form is still honored). The web SPA serves
 * every path; when it boots on an invite path we capture the code, immediately
 * clean the URL (`history.replaceState`) so the code neither lingers in the
 * address bar nor re-fires on a reload, and hand the code to whoever asks once
 * — the PendingInviteController replays it into the AddServerDialog join step
 * after auth (mobile's PendingDeepLinkController pattern).
 *
 * Electron never sees this path: the renderer is file-loaded there, and the
 * capture is additionally gated on the web platform shim.
 */

import { INVITE_CODE_MAX_LENGTH, INVITE_CODE_MIN_LENGTH } from "@demli/config";

/**
 * `/invite/<code>` (canonical) or the legacy `/kat/<code>`, with an optional
 * trailing slash — nothing else is an invite route.
 */
const INVITE_ROUTE_RE = new RegExp(
  `^/(?:invite|kat)/([A-Za-z0-9_-]{${INVITE_CODE_MIN_LENGTH},${INVITE_CODE_MAX_LENGTH}})/?$`,
);

/** True only under the browser shim (apps/web installs `platform: "web"`). */
function isWebPlatform(): boolean {
  if (typeof window === "undefined") return false;
  const platform: unknown = (window as { demli?: { appInfo?: { platform?: unknown } } })
    .demli?.appInfo?.platform;
  return platform === "web";
}

let pendingInviteCode: string | null = null;

/**
 * Read the invite code off the CURRENT location, once, and clean the URL.
 * Idempotent and cheap — safe to call from module scope at boot.
 */
export function captureInviteRouteFromLocation(): void {
  if (!isWebPlatform()) return;
  const match = INVITE_ROUTE_RE.exec(window.location.pathname);
  const code = match?.[1];
  if (code === undefined) return;
  pendingInviteCode = code;
  window.history.replaceState(null, "", "/");
}

/** One-shot read: returns the captured code and forgets it. */
export function consumePendingInviteCode(): string | null {
  const code = pendingInviteCode;
  pendingInviteCode = null;
  return code;
}
