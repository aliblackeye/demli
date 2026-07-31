/**
 * Client storage-key namespace.
 *
 * Every client-side persisted key is namespaced `demli.` or `demli:` —
 * localStorage on desktop/web, SecureStore on mobile. Kept in one dependency-free
 * module so the prefix has a single definition all three surfaces import.
 */

/** Namespace every client-persisted key is prefixed with. */
export const STORAGE_NAMESPACE = "demli";

/** The async key/value seam shared by expo-secure-store and AsyncStorage. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
