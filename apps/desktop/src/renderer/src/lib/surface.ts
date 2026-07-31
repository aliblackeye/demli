/**
 * Which SURFACE is this renderer running on?
 *
 * `apps/desktop/src/renderer` is the single source for two products: the Electron
 * desktop app and the browser app (apps/web mounts the same tree). Anything that
 * must exist on only one of them asks here.
 *
 * The answer comes from the platform bridge, never from the User-Agent:
 *   - Electron's preload sets `window.demli.appInfo.platform` to the Node
 *     platform ("win32" / "darwin" / "linux").
 *   - The web shim (apps/web/src/shim/demli-bridge.ts) installs
 *     `createWebBridge()`, whose `appInfo.platform` is the literal "web".
 * A UA sniff would answer the wrong question entirely — Electron ships a Chrome
 * UA, so "is this Chrome?" and "is this the browser build?" are not the same test.
 *
 * (Note the desktop preload types `platform` as `NodeJS.Platform`, which has no
 * "web" member; the comparison widens to `string` because the value at runtime on
 * the web build genuinely is "web".)
 */

/** True only in the browser build (apps/web). */
export function isWebSurface(): boolean {
  if (typeof window === "undefined") return false;
  const platform = window.demli?.appInfo.platform as string | undefined;
  return platform === "web";
}

/**
 * True only in the packaged/dev Electron app — i.e. a real `window.demli`
 * preload bridge is present and it is not the web shim. Deliberately NOT
 * `!isWebSurface()`: a missing bridge (a test renderer, an early paint before
 * preload) must count as "not desktop" rather than silently enabling
 * desktop-only chrome.
 */
export function isDesktopSurface(): boolean {
  if (typeof window === "undefined") return false;
  const platform = window.demli?.appInfo.platform as string | undefined;
  return platform !== undefined && platform !== "web";
}
