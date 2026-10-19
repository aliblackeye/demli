/**
 * "Koyu Masa" typography for React Native: Inter (body) + Onest (display).
 *
 * Desktop/web self-host variable woff2 with a latin / latin-ext `unicode-range`
 * split. RN has no `@font-face` and no unicode-range, so `assets/fonts/*.ttf`
 * are the static instances Google Fonts serves for the same families (unwrapped
 * from WOFF to TTF), each subset to latin + latin-ext COMBINED — that union is
 * what keeps ı/İ/ğ/Ğ/ş/Ş rendering instead of tofu (ç/ö/ü live in latin, the
 * rest in latin-ext). Licences: assets/fonts/OFL-*.txt, THIRD-PARTY.md.
 *
 * One family per weight: RN ignores numeric `fontWeight` for custom families on
 * Android, so "Inter @ 600" has to be its own registered family.
 *
 * OTA-SAFE: `expo-font` is already a dependency of the `expo` package itself
 * (expo@57 → expo-font@~57), so it is autolinked into the existing native
 * build. Nothing new is added to the native layer; the .ttf files ride along as
 * regular expo-updates assets.
 */

import { useEffect, useState } from "react";
import * as Font from "expo-font";

/**
 * Family name → asset. The KEY is what `fontFamily` must be set to; it also
 * matches each file's embedded name table, so iOS (which resolves custom fonts
 * through the PostScript name) and Android agree.
 */
/* eslint-disable @typescript-eslint/no-require-imports --
   Metro resolves ASSETS through `require`, which returns the numeric module id
   expo-font expects. An ESM `import` of a .ttf has no ambient type here and is
   not the form Expo documents for `loadAsync`, so this is the one place in the
   app where require() is the correct call. */
export const FONT_ASSETS = {
  // Body — Inter 400 / 500 / 600.
  "Inter-Regular": require("../../assets/fonts/Inter-Regular.ttf"),
  "Inter-Medium": require("../../assets/fonts/Inter-Medium.ttf"),
  "Inter-SemiBold": require("../../assets/fonts/Inter-SemiBold.ttf"),
  // Display — Onest 500 / 600 / 700.
  "Onest-Medium": require("../../assets/fonts/Onest-Medium.ttf"),
  "Onest-SemiBold": require("../../assets/fonts/Onest-SemiBold.ttf"),
  "Onest-Bold": require("../../assets/fonts/Onest-Bold.ttf"),
} as const;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * How long the boot splash may wait on font assets before the app renders
 * anyway. Fonts are bundled locally so this normally resolves in well under a
 * frame; the cap exists so a corrupt asset or a slow first-run OTA asset fetch
 * can never trap the user on the splash screen. Past the cap we render in the
 * system face — degraded typography beats an app that will not open.
 */
const FONT_LOAD_TIMEOUT_MS = 2500;

export type FontLoadState = {
  /** True once the app may render — fonts loaded, failed, or timed out. */
  ready: boolean;
  /** True only when the custom families are actually registered. */
  loaded: boolean;
};

/**
 * Load the brand fonts, and tell the caller when it is safe to render.
 *
 * Deliberately resolves `ready` on failure and on timeout as well as on
 * success: an unregistered `fontFamily` does not throw in RN — both platforms
 * silently fall back to the system face — so the worst case of giving up is
 * plain typography, while the worst case of waiting forever is a dead app.
 */
export function useAppFonts(): FontLoadState {
  const [state, setState] = useState<FontLoadState>({ ready: false, loaded: false });

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(() => {
      if (!cancelled) {
        console.warn("[fonts] load timed out — rendering with the system font");
        setState({ ready: true, loaded: false });
      }
    }, FONT_LOAD_TIMEOUT_MS);

    Font.loadAsync(FONT_ASSETS)
      .then(() => {
        if (!cancelled) setState({ ready: true, loaded: true });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("[fonts] load failed — rendering with the system font", error);
          setState({ ready: true, loaded: false });
        }
      })
      .finally(() => {
        clearTimeout(timer);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return state;
}
