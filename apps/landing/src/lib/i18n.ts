"use client";

/**
 * Landing i18n — paylaşılan @demli/i18n motoru, ikinci bir sistem değil.
 * Metinler packages/i18n `landing` namespace'inde durur (TR⇄EN parite
 * testi + tip güvenliği oradan gelir). Yalnız `landing` dilimi yüklenir;
 * ürün katalogları pazarlama sayfasına taşınmaz.
 */

import {
  createI18nFor,
  landingResources,
  setLocale,
  type Locale,
  type LocaleStorage,
  type i18n as I18nInstance,
} from "@demli/i18n";

/** Masaüstü istemciyle aynı anahtar (ileride tek origin olursa çakışmasın). */
const STORAGE_KEY = "demli.locale";

/** localStorage fırlatabilir (gizli mod, politika) — sayfa dil tercihini
 *  kaydedemese de açılmak zorunda; iki taraf da sessizce düşer. */
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
      // Tercih kalıcı değil; algılama her ziyarette çalışır.
    }
  },
};

/** Tek landing i18n örneği (ilk render'dan önce beklenir). */
export function createLandingI18n(): Promise<I18nInstance> {
  return createI18nFor(
    { ns: ["landing"], defaultNS: "landing", resources: landingResources },
    { storage },
  );
}

/** Dil seçiciden geçiş; tercih storage'a yazılır. */
export function changeLocale(instance: I18nInstance, locale: Locale): Promise<void> {
  return setLocale(instance, locale);
}
