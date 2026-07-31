/**
 * Persistence seam for the user's locale choice (ADR 0009 §4).
 *
 * The package never imports a concrete store — each app supplies an adapter so
 * the core stays native-free:
 * - Desktop wraps `localStorage` (sync).
 * - Mobile wraps `@react-native-async-storage/async-storage` (async).
 *
 * Both `get` and `set` may be sync OR async; `createI18n` awaits them.
 */
export interface LocaleStorage {
  /** Return the persisted locale string, or null if none is stored. */
  get(): string | null | Promise<string | null>;
  /** Persist the chosen locale string. */
  set(locale: string): void | Promise<void>;
}

/**
 * In-memory adapter — the default when no persistence is provided, and handy in
 * tests. Holds the value only for the lifetime of the process.
 */
export function createMemoryStorage(initial: string | null = null): LocaleStorage {
  let value = initial;
  return {
    get: () => value,
    set: (locale: string) => {
      value = locale;
    },
  };
}
