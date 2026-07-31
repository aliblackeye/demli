/**
 * Desktop implementation of the shared {@link VaultStorage} seam
 * (@demli/client-core account-vault, ADR 0013).
 *
 * The multi-account vault holds every signed-in account's session TOKEN, so it is
 * at least as sensitive as the single session token and must live under the same
 * OS-encrypted store — never renderer-accessible storage (security parity with
 * the token, security-review M1). It is reached only through the validated
 * preload bridge `window.demli.secureVault` (safeStorage in the main process,
 * see main/secure-vault.ts) — mirroring `stores/auth-store.ts` `tokenStorage`.
 *
 * String in / string out (serialized JSON) — `AccountVault` owns the shape and
 * the normalize/repair; this adapter is pure I/O.
 */

import type { VaultStorage } from "@demli/client-core";

export const vaultStorage: VaultStorage = {
  get() {
    return window.demli.secureVault.get();
  },
  set(value) {
    return window.demli.secureVault.set(value);
  },
  clear() {
    return window.demli.secureVault.clear();
  },
};
