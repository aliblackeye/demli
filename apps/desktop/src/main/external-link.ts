import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { EXTERNAL_LINK_CHANNELS } from "./external-link-types";
import {
  EXTERNAL_LINK_MAX_URL_LENGTH,
  openableExternalUrl,
} from "./external-link-policy";

/**
 * External links (main process): open ONE http(s) url in the user's OS browser.
 *
 * ## Why this channel exists
 *
 * `setWindowOpenHandler` used to do this job implicitly — it denied the in-app
 * window but forwarded any `https://` url to `shell.openExternal`. That was fine
 * while our own renderer was the only thing that could trigger a window open.
 * Watch Party (M20 / ADR 0016) put content we do not control inside the window,
 * and every link in an embedded player (its title, its channel, an end-screen
 * card, an ad) opens with `target="_blank"` — which lands in exactly that
 * handler. A hostile embed could therefore ask the OS to open a url of its
 * choosing, which is the same shape the `will-frame-navigate` guard already
 * refuses on purpose ("a refused navigation is cancelled, NOT re-opened
 * externally"). The two guards now agree: the window open handler is an
 * unconditional deny, and OUR ui asks for a browser tab explicitly, here.
 *
 * ## Security posture (CLAUDE.md §9, §28)
 *
 * - The payload is zod-validated (bounded string) and then re-checked by
 *   `openableExternalUrl`: parsed as a url, http(s) only, no embedded
 *   credentials, non-empty host. `javascript:`, `data:`, `file:` and every
 *   custom scheme (which can launch a registered application) are refused.
 * - Only the TOP frame of one of our own windows may invoke it. A subframe is
 *   refused outright — nothing in our ui is framed except the Watch Party embed,
 *   which is exactly the caller this whole change exists to exclude.
 * - Requests are rate limited. A click opens one tab; a compromised renderer
 *   calling in a loop would otherwise spawn browser windows without bound.
 * - The renderer gets this one verb through the preload — never `shell` itself,
 *   so `openPath` / `showItemInFolder` / `trashItem` stay unreachable.
 */

/** Bounded string; the real decision is `openableExternalUrl` below. */
const urlSchema = z.string().min(1).max(EXTERNAL_LINK_MAX_URL_LENGTH);

/**
 * Rate limit: at most this many tabs may be opened per window of time.
 *
 * A human clicks one link, reads the page, maybe clicks another. This bound
 * exists for the other caller — a compromised renderer, which can invoke the
 * channel in a loop and would otherwise carpet the desktop with browser windows
 * (a real denial of service on the user's machine, since each one steals focus).
 * Six per ten seconds is far above any honest burst.
 */
const MAX_OPENS_PER_WINDOW = 6;
const RATE_LIMIT_WINDOW_MS = 10_000;

/** Timestamps of the recent accepted opens, oldest first. */
let recentOpens: number[] = [];

/** Reset the rate-limit state. Test seam only. */
export function resetExternalLinkRateLimitForTests(): void {
  recentOpens = [];
}

/** True when another open is within budget; records it when it is. */
function withinRateLimit(now: number): boolean {
  recentOpens = recentOpens.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (recentOpens.length >= MAX_OPENS_PER_WINDOW) return false;
  recentOpens.push(now);
  return true;
}

/**
 * Only the TOP frame of one of our own windows may open an external link.
 *
 * Mirrors the check in `image-actions.ts`. A request from a subframe can only
 * come from embedded third-party content, which is precisely what must not be
 * able to reach the OS.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!BrowserWindow.fromWebContents(event.sender)) return false;
  const frame = event.senderFrame;
  // `senderFrame` is null when the frame is already gone; the window check above
  // has then already decided, so treat it as fine rather than dropping a
  // legitimate late reply.
  return frame === null || frame.parent === null;
}

let ipcRegistered = false;

/**
 * Register the external-link IPC. Idempotent — safe to call once after
 * `app.whenReady()`.
 */
export function registerExternalLinks(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    EXTERNAL_LINK_CHANNELS.open,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<boolean> => {
      if (!isTrustedSender(event)) {
        console.warn("[external-link] refused: untrusted sender");
        return false;
      }

      const parsed = urlSchema.safeParse(raw);
      // The NORMALIZED url is what gets forwarded — never the raw string. See
      // `openableExternalUrl`: validating one string and handing the OS another
      // is how a quote-and-space payload survives into the browser's command
      // line.
      const normalized = parsed.success ? openableExternalUrl(parsed.data) : null;
      if (normalized === null) {
        console.warn("[external-link] refused: url is not an openable http(s) address");
        return false;
      }

      if (!withinRateLimit(Date.now())) {
        console.warn("[external-link] refused: too many external opens");
        return false;
      }

      try {
        await shell.openExternal(normalized);
        return true;
      } catch {
        // No browser, no handler, or the OS refused — the click simply does
        // nothing rather than surfacing a raw error (CLAUDE.md §26).
        console.warn("[external-link] the OS refused to open the url");
        return false;
      }
    },
  );
}
