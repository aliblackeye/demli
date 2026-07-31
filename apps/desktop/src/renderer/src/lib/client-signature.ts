/**
 * This build's identity mark for the server's client gate — `demli-desktop/x`
 * in Electron, `demli-web/x` in a browser.
 *
 * ONE file for both because there is one renderer: apps/web mounts this exact
 * tree (see apps/web/src/main.tsx), so "which app am I" is a runtime question,
 * not a build-time one. The answer comes from the platform bridge — the same
 * `window.demli.appInfo` the download dialog already reads (lib/download-surface.ts)
 * — which the preload sets to `process.platform` in Electron and the web shim
 * sets to the literal `"web"`.
 *
 * WHY THIS MUST NOT THROW OR RETURN EMPTY: the mark is what tells the server a
 * build is current. Every unreadable input degrades to a still-VALID mark
 * (`formatClientSignature` guarantees that), because the alternative — no mark —
 * is the one outcome that gets a live user refused.
 */

import { formatClientSignature, type ClientApp } from "@demli/config";

/** What the web shim reports as its platform (apps/web/src/shim/demli-bridge.ts). */
const WEB_PLATFORM = "web";

interface AppInfoLike {
  platform?: unknown;
  version?: unknown;
}

/** `window.demli.appInfo`, or an empty object when the bridge is not installed. */
function readAppInfo(): AppInfoLike {
  const bridge = (globalThis as { demli?: { appInfo?: AppInfoLike } }).demli;
  const info = bridge?.appInfo;
  return typeof info === "object" && info !== null ? info : {};
}

/**
 * `"web"` in a browser, `"desktop"` in Electron.
 *
 * Defaults to `"desktop"` when the bridge is missing: an absent bridge means
 * the preload has not run, which only happens inside Electron (the web entry
 * installs its shim before this module can be imported).
 */
export function detectClientApp(): ClientApp {
  return readAppInfo().platform === WEB_PLATFORM ? "web" : "desktop";
}

/** The mark this surface sends on every API request and WS handshake. */
export const CLIENT_SIGNATURE: string = formatClientSignature(
  detectClientApp(),
  readAppInfo().version,
);
