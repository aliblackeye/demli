/**
 * Mobile language-preference helpers (ADR 0009, wave I3) — the mobile mirror of
 * the desktop's `lib/i18n.ts`. They are the only two places that read/write the
 * raw persisted locale key, keeping the "system vs explicit" rule in one spot.
 *
 * "System default" is modelled as the ABSENCE of a stored choice: we switch to
 * the detected device locale in memory, then clear the persisted key so the next
 * cold launch re-detects the OS language. An explicit pick is re-persisted by
 * `createI18n`'s `languageChanged` hook, so `applyLanguagePreference` clears the
 * key AFTER `setLocale` for "system" — matching the desktop ordering.
 *
 * Storage is `expo-secure-store` (async), already baked into the APK, so this
 * adds no native module and stays OTA-safe (see lib/locale-storage.ts).
 */
import {
  detectDeviceLocale,
  setLocale,
  useTranslation,
  type Locale,
  type TFunction,
  type TranslateFn,
  type i18n as I18nInstance,
} from "@demli/i18n";
import { localeStorage } from "./locale-storage";

/**
 * The mobile app uses two namespaces: `common` (shared errors/buttons — the
 * default, so `t("errors.network")` needs no prefix) and `mobile` (RN-only copy,
 * addressed as `t("mobile:…")`). Bind BOTH here so every component's `t` accepts
 * keys from either — the mobile mirror of the desktop's `useAppTranslation`.
 */
export type AppTFunction = TFunction<["common", "mobile"]>;

/** `useTranslation` bound to the mobile namespaces (common default + mobile). */
export function useAppTranslation(): ReturnType<typeof useTranslation<["common", "mobile"]>> {
  return useTranslation(["common", "mobile"]);
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

/** A settings choice: an explicit locale, or "follow the OS language". */
export type LanguagePreference = "system" | Locale;

/** What the settings UI should show as selected: an explicit locale or system. */
export async function getLanguagePreference(): Promise<LanguagePreference> {
  const stored = await localeStorage.get();
  return stored === "en" || stored === "tr" ? stored : "system";
}

/**
 * Apply a settings choice live and persist it. "system" changes the active
 * locale to the detected device locale, then clears the stored key so future
 * launches keep following the OS (an explicit pick is re-persisted by
 * createI18n's languageChanged hook, which is why the clear is ordered last).
 */
export async function applyLanguagePreference(
  instance: I18nInstance,
  preference: LanguagePreference,
): Promise<void> {
  if (preference === "system") {
    await setLocale(instance, detectDeviceLocale());
    await localeStorage.clear();
    return;
  }
  await setLocale(instance, preference);
}
