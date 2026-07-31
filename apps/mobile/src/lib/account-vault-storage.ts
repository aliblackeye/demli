/**
 * Mobile implementation of the shared {@link VaultStorage} seam
 * (@demli/client-core account-vault, ADR 0013). The multi-account vault holds
 * every signed-in account's session TOKEN, so — like the single session token
 * (lib/token-storage.ts) — it lives in the OS keystore via `expo-secure-store`,
 * never plain storage. Same string-in / string-out JSON contract, a second key
 * beside the token; no new native module, so it stays OTA-safe.
 *
 * SecureStore values are size-limited (~2KB) on some platforms. The vault caps at
 * MAX_STORED_ACCOUNTS = 8 opaque tokens + short profiles, which stays well under
 * that at any realistic account count.
 */
import { ACCOUNT_VAULT_STORAGE_KEY, type VaultStorage } from "@demli/client-core";
import { secureStorage } from "./secure-storage";

export const vaultStorage: VaultStorage = {
  get() {
    return secureStorage.getItem(ACCOUNT_VAULT_STORAGE_KEY);
  },
  set(value) {
    // Best-effort: a keystore failure leaves the in-memory vault authoritative
    // for this session, it just won't survive a relaunch (mirrors tokenStorage).
    return secureStorage.setItem(ACCOUNT_VAULT_STORAGE_KEY, value);
  },
  clear() {
    return secureStorage.removeItem(ACCOUNT_VAULT_STORAGE_KEY);
  },
};
