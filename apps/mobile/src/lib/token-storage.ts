/**
 * Mobile implementation of the shared {@link TokenStorage} seam
 * (@demli/client-core, ADR 0002). The desktop analog uses `localStorage`;
 * mobile persists the session token in the OS keystore via `expo-secure-store`,
 * which is already async — a natural fit for the async interface.
 *
 * SecureStore values are capped at ~2KB; session tokens are well under that.
 */
import type { TokenStorage } from "@demli/client-core";
import { secureStorage } from "./secure-storage";

const TOKEN_KEY = "demli.session.token";

export const tokenStorage: TokenStorage = {
  get() {
    return secureStorage.getItem(TOKEN_KEY);
  },
  set(token) {
    return secureStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    return secureStorage.removeItem(TOKEN_KEY);
  },
};
