/**
 * Desktop i18n bootstrap (ADR 0009, wave I2).
 *
 * Wraps `@demli/i18n`'s `createI18n` with a `localStorage` persistence
 * adapter. Locale resolution at startup: persisted choice → device language
 * (navigator) → "en". The app follows the OS language until the user makes an
 * explicit pick in settings.
 *
 * "System default" in the settings UI is modelled as the ABSENCE of a stored
 * key: we switch to the detected locale in memory, then delete the persisted
 * key so the next launch re-detects. That is why this module owns both
 * `applyLanguagePreference` and `getLanguagePreference` — they are the only two
 * places that read/write the raw storage key, keeping the "system vs explicit"
 * rule in one spot.
 */

import {
  createI18n,
  detectDeviceLocale,
  setLocale,
  useTranslation,
  type Locale,
  type LocaleStorage,
  type TFunction,
  type TranslateFn,
  type i18n as I18nInstance,
} from "@demli/i18n";

/**
 * The desktop uses two namespaces: `common` (shared errors/buttons — the default,
 * so `t("errors.network")` needs no prefix) and `desktop` (Electron-only copy,
 * addressed as `t("desktop:…")`). Bind both here so every component's `t` accepts
 * keys from either.
 */
export type AppTFunction = TFunction<["common", "desktop"]>;

/** `useTranslation` bound to the desktop's namespaces (common default + desktop). */
export function useAppTranslation(): ReturnType<typeof useTranslation<["common", "desktop"]>> {
  return useTranslation(["common", "desktop"]);
}

/**
 * Adapt the app's strictly-typed `t` to the structural {@link TranslateFn}
 * accepted by `resolveSystemMessage`. The literal-key union of AppTFunction is
 * narrower than `(key: string) => string`, so a direct pass fails contravariance;
 * the cast is safe because the resolver only ever requests `common:system.*`
 * keys, all present in the typed catalog (guarded by the i18n package's tests).
 */
export function toTranslateFn(t: AppTFunction): TranslateFn {
  return t as unknown as TranslateFn;
}

/** localStorage key holding the user's explicit locale choice (if any). */
const STORAGE_KEY = "demli.locale";

const storage: LocaleStorage = {
  get: () => localStorage.getItem(STORAGE_KEY),
  set: (value) => localStorage.setItem(STORAGE_KEY, value),
};

/** A settings choice: an explicit locale, or "follow the OS language". */
export type LanguagePreference = "system" | Locale;

/** Create the single desktop i18n instance (await before first render). */
export function createDesktopI18n(): Promise<I18nInstance> {
  return createI18n({ storage });
}

/** What the settings UI should show as selected: an explicit locale or system. */
export function getLanguagePreference(): LanguagePreference {
  const stored = storage.get();
  return stored === "en" || stored === "tr" ? stored : "system";
}

/**
 * Apply a settings choice live and persist it. "system" changes the active
 * locale to the detected device locale, then clears the stored key so future
 * launches keep following the OS (an explicit pick is re-persisted by
 * createI18n's languageChanged hook).
 */
export async function applyLanguagePreference(
  instance: I18nInstance,
  preference: LanguagePreference,
): Promise<void> {
  if (preference === "system") {
    await setLocale(instance, detectDeviceLocale());
    // Ordered after setLocale: the languageChanged hook persists the detected
    // locale synchronously during changeLanguage; removing it here wins.
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  await setLocale(instance, preference);
}
