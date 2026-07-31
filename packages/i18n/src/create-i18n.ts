/**
 * i18next bootstrap shared by desktop and mobile (ADR 0009 §2/§4).
 *
 * `createI18n` resolves the initial locale (explicit arg → persisted choice →
 * detected device locale → "en"), initializes an i18next instance with the
 * React binding attached, and — when a storage adapter is given — persists the
 * user's locale on every subsequent change. Returns the instance to hand to an
 * `I18nextProvider`.
 */

import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  isSupportedLocale,
  NAMESPACES,
  SUPPORTED_LOCALES,
  type Locale,
} from "./config.js";
import { detectDeviceLocale } from "./detect.js";
import { resources } from "./resources.js";
import type { LocaleStorage } from "./storage.js";

export interface CreateI18nOptions {
  /** Explicit locale override (e.g. one already resolved by the app). */
  lng?: Locale;
  /** Persistence adapter for the user's choice; omit for no persistence. */
  storage?: LocaleStorage;
}

/**
 * A namespace slice plus the catalogs backing it — everything i18next needs to
 * initialise. Exists so a surface can load PART of the tree: the public landing
 * page needs `landing` only, and statically importing the whole tree would put
 * the desktop + mobile catalogs (~170 KB) in a marketing bundle.
 *
 * Passing the bundle in (rather than selecting from the full tree at runtime) is
 * what makes it a bundler concern instead of a runtime one — an unreferenced
 * catalog is dropped from the build entirely.
 */
export interface I18nBundle {
  /** Namespaces to register. */
  ns: readonly string[];
  /** Namespace unprefixed keys resolve against; must be one of `ns`. */
  defaultNS: string;
  /** locale → namespace → catalog. */
  resources: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

async function resolveInitialLocale(options: CreateI18nOptions): Promise<Locale> {
  if (options.lng && isSupportedLocale(options.lng)) return options.lng;
  if (options.storage) {
    try {
      const stored = await options.storage.get();
      if (isSupportedLocale(stored)) return stored;
    } catch {
      // Unreadable storage — fall back to detection.
    }
  }
  return detectDeviceLocale();
}

/** Fire-and-forget persistence; a failing store must never break a UI change. */
function persist(storage: LocaleStorage, locale: string): void {
  try {
    void Promise.resolve(storage.set(locale)).catch(() => undefined);
  } catch {
    // set() threw synchronously — ignore.
  }
}

/**
 * Initialise an i18next instance for a specific namespace slice. `createI18n` is
 * the "everything" case of this; a surface that only needs part of the catalog
 * (apps/landing) calls this directly with its own bundle so the rest is never
 * bundled in the first place.
 */
export async function createI18nFor(
  bundle: I18nBundle,
  options: CreateI18nOptions = {},
): Promise<I18nInstance> {
  const lng = await resolveInitialLocale(options);
  const instance = i18next.createInstance();

  await instance.use(initReactI18next).init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: bundle.ns as string[],
    defaultNS: bundle.defaultNS,
    resources: bundle.resources as Record<string, Record<string, object>>,
    returnNull: false,
    interpolation: {
      // React (DOM) and React Native escape output themselves.
      escapeValue: false,
    },
    react: {
      // Avoid forcing a Suspense boundary; catalogs are bundled and sync.
      useSuspense: false,
    },
  });

  // Persist only user-driven changes: the listener is attached AFTER init, so
  // the initial (detected) locale is not frozen — the app keeps following the
  // OS language until the user explicitly picks one.
  const { storage } = options;
  if (storage) {
    instance.on("languageChanged", (next: string) => {
      if (isSupportedLocale(next)) persist(storage, next);
    });
  }

  return instance;
}

/**
 * The product-app bootstrap: every namespace, every catalog. Desktop and mobile
 * call this; the signature and behaviour are unchanged.
 */
export function createI18n(options: CreateI18nOptions = {}): Promise<I18nInstance> {
  return createI18nFor(
    { ns: NAMESPACES, defaultNS: DEFAULT_NAMESPACE, resources },
    options,
  );
}

/** Change the active locale (persistence, if any, runs via createI18n's hook). */
export async function setLocale(instance: I18nInstance, locale: Locale): Promise<void> {
  await instance.changeLanguage(locale);
}
