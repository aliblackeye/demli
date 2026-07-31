/**
 * The single expo-secure-store seam for everything the mobile app persists.
 *
 * ONE adapter instead of eleven: every persisted zustand store used to carry its
 * own byte-identical `secureStorage` object, so a fix to one of them had to be
 * repeated eleven times or it silently applied to some settings and not others.
 *
 * Every operation swallows its errors: a locked or unavailable keystore must
 * degrade to "this setting won't survive a restart", never to a crash on boot.
 */
import * as SecureStore from "expo-secure-store";
import type { StateStorage } from "zustand/middleware";
import type { AsyncKeyValueStorage } from "@demli/client-core";

const rawSecureStorage: AsyncKeyValueStorage = {
  async getItem(key) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Keystore unavailable — the value just won't survive a restart.
    }
  },
  async removeItem(key) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Nothing to clear.
    }
  },
};

/**
 * SecureStore satisfying zustand's async `StateStorage` seam. Use this
 * everywhere instead of calling SecureStore directly, so every persisted store
 * shares one error-swallowing adapter.
 */
export const secureStorage: AsyncKeyValueStorage & StateStorage = rawSecureStorage;
