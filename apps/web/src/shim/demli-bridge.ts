/**
 * `window.demli` shim for the web build.
 *
 * The web app IS the desktop renderer, mounted unchanged in a browser (see
 * ../main.tsx). On desktop that renderer reads its native capabilities from the
 * Electron-injected `window.demli` (the preload `DemliBridge`). A browser
 * has no preload, so we install a browser-native equivalent on `window.demli`
 * BEFORE the renderer's first line runs.
 *
 * The namespaces already have web behaviour in @demli/app-ui's
 * {@link createWebBridge}:
 *
 *   - appInfo       → { platform: "web", version } (so every `platform === "win32"`
 *                     branch in the renderer is correctly false, and screen share
 *                     takes the plain-getDisplayMedia path).
 *   - capture       → gated on navigator.mediaDevices.getDisplayMedia; the browser
 *                     owns the source picker, so there is nothing to pre-arm.
 *   - processAudio  → no-op (Windows per-process WASAPI loopback has no web analogue).
 *   - secureToken   → localStorage (the session token slot).
 *   - secureVault   → localStorage (the multi-account vault blob).
 *   - notifications → the Web Notifications API, shown only when granted AND the
 *                     tab is backgrounded; click replays the navigate target.
 *   - updates       → { kind: "disabled" } — the browser updates itself.
 *   - system        → tray / launch-at-startup are off and the setters are no-ops.
 *   - crash         → reports to console (a real sink is app-level, M19).
 *   - images        → save/copy a chat image with browser APIs: the File System
 *                     Access save picker when present (a real directory choice,
 *                     Chromium), an `<a download>` blob otherwise, and a
 *                     feature-detected async-clipboard copy — `copySupported` is
 *                     false on engines without ClipboardItem, so the UI omits
 *                     the entry rather than showing a dead button.
 *
 * `createWebBridge` returns a `PlatformBridge`, which is the documented structural
 * MIRROR of the desktop `DemliBridge` (packages/app-ui/src/platform/bridge-types.ts
 * is kept 1:1 with the preload contract). So it satisfies every `window.demli.*`
 * access the renderer makes, and if the two contracts ever drift the desktop's own
 * wiring stops compiling first — the intended tripwire. We deliberately do NOT
 * import the preload's `DemliBridge` here: that type pulls in Electron/Node, which
 * must never enter the web graph.
 */
import { createWebBridge, type PlatformBridge } from "@demli/app-ui";

declare global {
  interface Window {
    // REQUIRED (not optional): the renderer dereferences window.demli.* without
    // a guard, exactly as under Electron. We guarantee presence by installing the
    // bridge on import, before the renderer is imported.
    demli: PlatformBridge;
  }
}

let installed = false;

/**
 * Install the web bridge onto `window.demli`. Idempotent. Called on import
 * (below) so a single side-effect import — ordered before the renderer import in
 * main.tsx — is enough; there is no window in which the renderer could read an
 * undefined bridge.
 */
export function installWebDemliBridge(): void {
  if (installed) return;
  const version = import.meta.env.VITE_APP_VERSION ?? "0.0.0";
  window.demli = createWebBridge({ version });
  installed = true;
}

installWebDemliBridge();
