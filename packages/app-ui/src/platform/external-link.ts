/**
 * Opening a link OUTSIDE the app — the one helper every surface calls.
 *
 * ## Why a helper and not `window.open`
 *
 * `window.open` used to be the whole story: the Electron main process caught it
 * in `setWindowOpenHandler`, denied the in-app window and forwarded `https://`
 * urls to the OS browser. Watch Party (M20 / ADR 0016) made that handler
 * reachable from content we do not control — every link inside an embedded
 * player opens with `target="_blank"` — so the handler became an UNCONDITIONAL
 * DENY. On desktop a `window.open` now does nothing at all.
 *
 * So our own links ask for a browser tab explicitly, through the preload's
 * narrow `externalLinks.open` verb (validated in the main process: bounded,
 * parsed, http(s) only, no embedded credentials, top-frame senders only). The
 * embed cannot reach that channel, and our links keep working.
 *
 * ## Why the bridge is OPTIONAL here
 *
 * This package is shared: the same components render in the browser build, where
 * `window.open` remains the correct and only way to open a tab. The bridge is
 * therefore looked up defensively and `window.open` is the fallback — which also
 * covers a test renderer or an early paint before a bridge is installed. The web
 * bridge implements `externalLinks.open` with exactly that fallback, so both
 * paths lead to the same place on web.
 *
 * User-visible behaviour is identical on every surface: the link opens in the
 * user's browser.
 */

/** The narrow slice of `window.demli` this module needs, all of it optional. */
interface MaybeBridgeWindow {
  demli?: {
    externalLinks?: {
      open?: (url: string) => Promise<boolean> | void;
    };
  };
}

/**
 * True when `url` is an absolute http(s) address.
 *
 * Parses rather than prefix-matches, so `javascript:`, `data:`, `file:`, custom
 * schemes, and anything that is not an absolute url are all refused. The desktop
 * main process re-checks the same thing before it touches the OS — this copy
 * exists so a refused link never even leaves the renderer, and so the web build
 * (which has no main process) enforces it too.
 */
export function isExternalHttpUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Open `url` in the user's OS browser. Returns `true` when an open was
 * attempted, `false` when the url was refused or there is no window to open
 * from. Never throws — a link that cannot be opened simply does nothing
 * (CLAUDE.md §26).
 */
export function openExternalUrl(url: string): boolean {
  if (!isExternalHttpUrl(url)) return false;
  if (typeof window === "undefined") return false;

  const open = (window as unknown as MaybeBridgeWindow).demli?.externalLinks?.open;
  if (typeof open === "function") {
    try {
      // Fire and forget: the result is a "did the OS take it" signal that no
      // caller acts on, and a rejected promise must not become an unhandled one.
      void Promise.resolve(open(url)).catch(() => false);
      return true;
    } catch {
      return false;
    }
  }

  // No bridge (browser build without the shim, a test renderer, an early paint).
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
