/**
 * Landing-page i18n — the SHARED @demli/i18n engine, not a second system.
 *
 * The copy lives in the `landing` namespace of packages/i18n, so it gets the
 * same TR⇄EN key-parity test and the same compile-time key typing as the product
 * catalogs. Initial locale resolution is the package's standard chain:
 * persisted choice → browser language → "en".
 *
 * `createI18nFor` + `landingResources` rather than plain `createI18n`: the full
 * tree also carries the desktop and mobile catalogs (~170 KB of product copy) —
 * dead weight on a marketing page. Loading only the `landing` slice lets the
 * bundler drop the rest instead of shipping strings nobody here can read.
 */

import {
  createI18nFor,
  landingResources,
  setLocale,
  type Locale,
  type LocaleStorage,
  type i18n as I18nInstance,
} from "@demli/i18n";

/**
 * Same key the desktop renderer uses. The landing page and the web client are
 * different origins today (getdemli.com vs app.getdemli.com), so nothing is
 * actually shared — but if they ever land on one origin, they agree instead of
 * fighting over two keys.
 */
const STORAGE_KEY = "demli.locale";

/**
 * localStorage can throw (Safari private mode, storage disabled by policy). A
 * landing page must never fail to render over a language preference, so both
 * sides swallow errors and degrade to "detect every visit".
 */
const storage: LocaleStorage = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Preference is not persistable in this browser — detection still works.
    }
  },
};

/** Create the single landing i18n instance (await before first render). */
export function createLandingI18n(): Promise<I18nInstance> {
  return createI18nFor(
    { ns: ["landing"], defaultNS: "landing", resources: landingResources },
    { storage },
  );
}

/** Switch language from the picker; createLandingI18n's hook persists it. */
export function changeLocale(instance: I18nInstance, locale: Locale): Promise<void> {
  return setLocale(instance, locale);
}
