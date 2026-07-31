/**
 * Mobile implementation of the `@demli/i18n` {@link LocaleStorage} seam
 * (ADR 0009 §4). The user's language choice is persisted in the OS keystore via
 * `expo-secure-store` — the same store already used for the session token
 * (see lib/token-storage.ts).
 *
 * Why SecureStore and not AsyncStorage: the app pins `runtimeVersion: "1.0.0"`,
 * so adding a NEW native module would change the native fingerprint and break
 * OTA delivery to installed APKs. `@react-native-async-storage/async-storage`
 * would be exactly that — a new native module. `expo-secure-store` is ALREADY a
 * dependency baked into the shipped APK, so reusing it adds no native code and
 * keeps OTA compatibility intact. A locale string is tiny (well under the ~2KB
 * SecureStore cap).
 *
 * `get`/`set` satisfy the async `LocaleStorage` interface; `clear` is an extra
 * used by the settings "System default" option to drop the explicit choice and
 * fall back to device-locale detection.
 */
import type { LocaleStorage } from "@demli/i18n";
import { secureStorage } from "./secure-storage";

const LOCALE_KEY = "demli.locale";

export const localeStorage: LocaleStorage & { clear: () => Promise<void> } = {
  get() {
    return secureStorage.getItem(LOCALE_KEY);
  },
  set(locale: string) {
    return secureStorage.setItem(LOCALE_KEY, locale);
  },
  clear() {
    return secureStorage.removeItem(LOCALE_KEY);
  },
};
