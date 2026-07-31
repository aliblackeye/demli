/**
 * JS-only device-language detection (ADR 0009 §4).
 *
 * No native modules — mobile pins `runtimeVersion: "1.0.0"`, so adding a native
 * dependency (e.g. expo-localization) would break OTA delivery to installed
 * APKs. Everything here works from pure JS globals available in Electron's
 * renderer, React Native's Hermes engine, and Node (tests):
 *
 * - Desktop / web: `navigator.languages` / `navigator.language`.
 * - Mobile (Hermes) / Node: `Intl.DateTimeFormat().resolvedOptions().locale`.
 */

import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./config.js";

/** Read the raw platform locale string (e.g. `"tr-TR"`), or undefined. */
function readRawLocale(): string | undefined {
  // Electron renderer / web — the most specific signal first.
  if (typeof navigator !== "undefined") {
    const nav = navigator as { language?: string; languages?: readonly string[] };
    const fromList = nav.languages?.find((entry) => typeof entry === "string" && entry.length > 0);
    if (fromList) return fromList;
    if (typeof nav.language === "string" && nav.language.length > 0) return nav.language;
  }

  // React Native (Hermes ships Intl) and Node — JS-only, no native module.
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  } catch {
    // Intl unavailable in this runtime — fall through to the default.
  }

  return undefined;
}

/**
 * Best-effort device locale, normalized to a supported {@link Locale}.
 * Takes the primary subtag (`"tr-TR"` → `"tr"`), lowercases it, and falls back
 * to {@link DEFAULT_LOCALE} for anything we do not ship.
 */
export function detectDeviceLocale(): Locale {
  const raw = readRawLocale();
  if (!raw) return DEFAULT_LOCALE;
  const primary = raw.toLowerCase().split(/[-_]/)[0] ?? DEFAULT_LOCALE;
  return isSupportedLocale(primary) ? primary : DEFAULT_LOCALE;
}
