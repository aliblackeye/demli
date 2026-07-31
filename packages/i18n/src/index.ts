/**
 * @demli/i18n — shared localization for desktop AND mobile (ADR 0009).
 *
 * One i18next engine, one catalog format, one `useTranslation` API on both
 * platforms. Pure JS (no native modules), so mobile stays OTA-safe.
 *
 * - config.ts          — SUPPORTED_LOCALES / NAMESPACES / isSupportedLocale.
 * - detect.ts          — detectDeviceLocale() (JS-only, navigator + Intl).
 * - storage.ts         — LocaleStorage adapter seam (per-app impl).
 * - create-i18n.ts     — createI18n({ lng?, storage }) + createI18nFor(bundle)
 *                        (namespace subset, for surfaces like apps/landing that
 *                        must not bundle the product catalogs) + setLocale().
 * - system-messages.ts — resolveSystemMessage() for `@sys:` tokens.
 * - locales/           — en/tr catalogs (common owned here; desktop/mobile I2/I3).
 *
 * Integration (desktop I2 / mobile I3):
 *   const i18n = await createI18n({ storage });   // storage wraps localStorage/AsyncStorage
 *   <I18nextProvider i18n={i18n}>…</I18nextProvider>
 *   const { t } = useTranslation();               // default ns = "common"
 */

// Register the i18next key-safety augmentation for every consumer (side effect).
import "./i18next-env.js";

export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  NAMESPACES,
  DEFAULT_NAMESPACE,
  isSupportedLocale,
  type Locale,
  type Namespace,
} from "./config.js";
export { detectDeviceLocale } from "./detect.js";
export { createMemoryStorage, type LocaleStorage } from "./storage.js";
export {
  createI18n,
  createI18nFor,
  setLocale,
  type CreateI18nOptions,
  type I18nBundle,
} from "./create-i18n.js";
export { resources, landingResources, type Resources } from "./resources.js";
export {
  SYSTEM_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_TOKENS,
  isSystemMessageToken,
  resolveSystemMessage,
  systemMessageContent,
  type SystemMessageToken,
  type TranslateFn,
} from "./system-messages.js";

// Single React-binding surface so both apps use the same react-i18next instance.
export { useTranslation, Trans, I18nextProvider, initReactI18next } from "react-i18next";
export type { TFunction, i18n } from "i18next";
