import { useEffect, useState } from "react";

/**
 * Viewport width (CSS px) at or below which the app shell switches from the
 * four-column desktop layout to the single-column mobile layout (drawers).
 *
 * Kept deliberately BELOW the Electron BrowserWindow `minWidth` (940, see
 * apps/desktop/src/main/index.ts). The desktop window can never be narrower than
 * 940 CSS px, so it always renders the wide layout — the mobile branch only ever
 * triggers on a genuinely narrow web viewport (a phone). Raising this at/above
 * 940 would let a merely-small desktop window fall into mobile mode, which is why
 * the gap to 940 is intentional. Mirrors the `--breakpoint-wide: 900px` token in
 * styles/globals.css.
 */
export const MOBILE_MAX_WIDTH = 899;

/**
 * Subscribe to a CSS media query. Returns the current match and updates on
 * change. SSR-safe (returns false when `matchMedia` is unavailable), and seeds
 * its initial value synchronously so the first paint already uses the right
 * layout — no wide→mobile flash on a phone.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    // Re-sync in case the viewport changed between the initial render and effect.
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * True when the viewport is narrow enough to use the mobile single-column shell.
 * See {@link MOBILE_MAX_WIDTH} for why the threshold sits under Electron's
 * window minimum.
 */
export function useIsMobileViewport(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
}
