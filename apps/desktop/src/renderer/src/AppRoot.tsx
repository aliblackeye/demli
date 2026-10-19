/**
 * The renderer's root — shared by BOTH surfaces.
 *
 * apps/desktop/src/renderer/src/main.tsx (Electron) and apps/web/src/main.tsx
 * (browser) each do their own platform setup and then render exactly this, so
 * the boot sequence, the splash and the i18n/error-boundary nesting can never
 * drift between desktop and web.
 *
 * Two things happen here that cannot live inside <App/>:
 *
 *  1. The i18n instance is created BEFORE <App/> mounts (catalogs + locale
 *     resolved, so the UI never paints an untranslated frame). That makes it a
 *     real boot phase — and one the splash must be able to show progress for,
 *     which is why the splash is a SIBLING of <App/> rather than a child.
 *  2. The brand fonts are explicitly requested and awaited, so "the shell is
 *     painted in the right typeface" is an observable event rather than a guess.
 *
 * Both feed stores/boot-store, which the splash reads. See BootSplash for the
 * anti-stall rules.
 */

import { useCallback, useEffect, useState } from "react";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { App } from "./App";
import { BootSplash } from "./components/BootSplash";
import { BootUpdateBinder } from "./components/BootUpdateBinder";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { createDesktopI18n } from "./lib/i18n";
import { markBootPhase, useBootStore } from "./stores/boot-store";

/**
 * Longest we will wait on the brand webfonts before opening anyway. They are
 * `font-display: swap`, so a slow font never blocks readable text — waiting past
 * this would only delay a usable app for a cosmetic reason.
 */
const FONT_GRACE_MS = 2_500;

/**
 * Ask for the two brand faces and resolve once they are usable.
 *
 * `document.fonts.ready` alone is not a real signal here: with nothing yet
 * rendered in those faces there is nothing "pending", so it can resolve before a
 * single byte is fetched. Explicitly `load()`ing the exact face/weight pairs the
 * shell paints with is what makes this phase mean something.
 */
async function loadBrandFonts(): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts?.load) return;
  await Promise.all([
    fonts.load('400 1rem "Inter"'),
    fonts.load('600 1rem "Inter"'),
    fonts.load('600 1rem "Onest"'),
  ]);
  await fonts.ready;
}

export function AppRoot(): JSX.Element {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);

  // A crash during boot must not leave the splash covering the crash fallback:
  // force the boot complete so the splash fades and the user sees the error.
  const abortSplash = useCallback(() => useBootStore.getState().finishBoot(), []);

  // Phase "shell" — brand typography is on screen (or we stopped waiting).
  useEffect(() => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      markBootPhase("shell");
    };
    const grace = window.setTimeout(finish, FONT_GRACE_MS);
    void loadBrandFonts().then(finish, finish);
    return () => window.clearTimeout(grace);
  }, []);

  // Phase "i18n" — catalogs bundled + locale resolved (persisted → device → en).
  useEffect(() => {
    let cancelled = false;
    void createDesktopI18n().then((instance) => {
      if (cancelled) return;
      markBootPhase("i18n");
      setI18n(instance);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {/* Provider OUTSIDE the boundary so the crash fallback can localize its
          copy — I18nextProvider only forwards context, it cannot realistically
          throw. Mounted as soon as i18n resolves; the splash covers the gap. */}
      {i18n !== null && (
        <I18nextProvider i18n={i18n}>
          <ErrorBoundary onError={abortSplash}>
            <App />
          </ErrorBoundary>
        </I18nextProvider>
      )}
      {/* Headless. Mounted OUTSIDE the i18n gate and outside <App/> because the
          feed's answer can land before either exists — and because this mounting
          exactly once per renderer load is what makes the startup update a
          cold-start-only flow (a tray restore does not reload the renderer).
          It is inert on web: no updater bridge, so it releases immediately. */}
      <BootUpdateBinder />
      {/* Sibling, not child: it has to be on screen for the phases that run
          BEFORE <App/> exists, and it overlays the app while the later phases
          finish so the shell is already painted underneath when it fades. */}
      <BootSplash translationsReady={i18n !== null} />
    </>
  );
}
