/**
 * Locale + namespace configuration — the single source of truth shared by
 * desktop and mobile (ADR 0009). Keep this list in sync with the JSON catalogs
 * under `locales/` and the i18next augmentation in `i18next-env.ts`.
 */

/** Every locale the app ships. Add a locale here AND add its catalogs. */
export const SUPPORTED_LOCALES = ["en", "tr"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Safe fallback whenever detection/persistence yields nothing usable. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Translation namespaces, split by ownership:
 * - `common`  — shared by both platforms (errors, buttons, system messages).
 * - `desktop` — Electron-only strings (filled by wave I2).
 * - `mobile`  — React Native-only strings (filled by wave I3).
 * - `landing` — the public marketing page at getdemli.com (apps/landing).
 *
 * `landing` lives here rather than in its own system so the TR⇄EN parity test
 * (and the compile-time key typing) covers it exactly like the product copy;
 * the catalog is a few hundred bytes, so the product apps carrying it costs
 * nothing measurable.
 */
export const NAMESPACES = ["common", "desktop", "mobile", "landing"] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Unprefixed keys resolve here, so shared code writes `t("errors.network")`. */
export const DEFAULT_NAMESPACE: Namespace = "common";

/** Type guard + runtime check that a raw string is a locale we support. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
