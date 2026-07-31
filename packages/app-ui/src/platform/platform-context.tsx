/**
 * Platform bridge React context.
 *
 * The shared product UI reads platform capabilities through `usePlatform()`
 * rather than touching `window.demli` or browser globals directly, so one
 * component tree renders unchanged on desktop and web — only the injected
 * bridge differs. Wire it once near the app root:
 *
 *   // desktop renderer (Phase 1)
 *   <PlatformProvider bridge={createDesktopBridge(window.demli)}>…</PlatformProvider>
 *
 *   // web app (Phase 1)
 *   <PlatformProvider bridge={createWebBridge({ version })}>…</PlatformProvider>
 *
 * Phase 0 ships the plumbing only — no component consumes it yet.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { PlatformBridge } from "./bridge-types";

const PlatformContext = createContext<PlatformBridge | null>(null);

export interface PlatformProviderProps {
  /** The concrete bridge for this surface (desktop or web). */
  bridge: PlatformBridge;
  children: ReactNode;
}

/** Makes a {@link PlatformBridge} available to the subtree via {@link usePlatform}. */
export function PlatformProvider({ bridge, children }: PlatformProviderProps): ReactNode {
  return <PlatformContext.Provider value={bridge}>{children}</PlatformContext.Provider>;
}

/**
 * Read the active {@link PlatformBridge}. Throws when no {@link PlatformProvider}
 * is above it in the tree — a programming error, surfaced loudly rather than
 * silently handing back a broken half-bridge.
 */
export function usePlatform(): PlatformBridge {
  const bridge = useContext(PlatformContext);
  if (bridge === null) {
    throw new Error(
      "usePlatform() must be used within a <PlatformProvider>. Wire one near the app root " +
        "with createDesktopBridge()/createWebBridge().",
    );
  }
  return bridge;
}

/**
 * Non-throwing variant: returns the bridge or `null` when there is no provider.
 * For the rare component that can render meaningfully without platform access.
 */
export function usePlatformOptional(): PlatformBridge | null {
  return useContext(PlatformContext);
}
