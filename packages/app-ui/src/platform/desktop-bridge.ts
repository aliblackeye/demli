/**
 * Desktop PlatformBridge adapter.
 *
 * The Electron preload already exposes `window.demli` with EXACTLY the
 * namespaces {@link PlatformBridge} describes (the two contracts are mirrors —
 * see bridge-types.ts). So the desktop "adapter" is thin: it surfaces that
 * injected object typed as a `PlatformBridge`. No method is re-wrapped, so no
 * `this`-binding or serialization is disturbed.
 *
 * A LOCAL window shape is used (not a `declare global`) so this package never
 * augments the global `Window` — that would collide with the desktop renderer's
 * own `window.demli: DemliBridge` declaration when both are in scope.
 */
import type { PlatformBridge } from "./bridge-types";

interface DemliWindow {
  demli?: PlatformBridge;
}

/**
 * Read the Electron-injected bridge from `window.demli`, or `null` when it is
 * absent (SSR, tests, or a non-Electron context). Never throws.
 */
export function getDesktopNativeBridge(): PlatformBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as DemliWindow).demli ?? null;
}

/** True when running inside the Electron renderer (the bridge is present). */
export function hasDesktopBridge(): boolean {
  return getDesktopNativeBridge() !== null;
}

/**
 * Build the desktop {@link PlatformBridge}.
 *
 * Pass the renderer's `window.demli` explicitly (its `DemliBridge` type is
 * assignable to `PlatformBridge`, so this type-checks without a cast) — the
 * preferred Phase-1 wiring. Omit the argument to read `window.demli` here.
 * Throws when no bridge is available, since a desktop UI cannot function without
 * it (CLAUDE.md §26 — fail loudly, never hand back a half-bridge).
 */
export function createDesktopBridge(nativeBridge?: PlatformBridge | null): PlatformBridge {
  const bridge = nativeBridge ?? getDesktopNativeBridge();
  if (!bridge) {
    throw new Error(
      "createDesktopBridge(): window.demli is unavailable — this must run inside the " +
        "Electron renderer, or be given an explicit bridge.",
    );
  }
  return bridge;
}
