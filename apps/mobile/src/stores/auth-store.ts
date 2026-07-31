/**
 * Session/auth store — the mobile mirror of the desktop renderer's
 * stores/auth-store.ts. Owns the session token and authenticated user.
 *
 * Token persistence goes through the shared `TokenStorage` seam (ADR 0002);
 * here it is backed by `expo-secure-store` (see lib/token-storage.ts) rather
 * than the desktop's localStorage. The HTTP client is the runtime-reconfigurable
 * mobile wrapper (lib/clients.ts).
 */
import { create } from "zustand";
import type { User } from "@demli/types";
import { ApiClientError, getApi, setAuthToken } from "../lib/clients";
import { tokenStorage } from "../lib/token-storage";
import { mobileSessionMetadata } from "../lib/session-metadata";
import { ensureVaultLoaded, seedActiveAccount } from "../lib/account-manager";

export type AuthStatus = "initializing" | "unauthenticated" | "authenticated";

/**
 * Stable, language-neutral notice shown on the sign-in screen. The store is
 * React-free (no `t`), so it holds a code the screen maps to a `common.errors.*`
 * string at render time (ADR 0009) instead of a baked English sentence.
 */
export type AuthNotice = "sessionExpired" | "network";

interface AuthStore {
  status: AuthStatus;
  token: string | null;
  user: User | null;
  /** User-facing notice code shown on the auth screen; localized at render. */
  notice: AuthNotice | null;

  /** Validate any persisted token on boot. */
  initialize: () => Promise<void>;
  /**
   * Sign in. `reactivate` re-sends the login with the reactivation flag so a
   * frozen (soft-deleted) account within its grace window is restored instead of
   * answering `403 ACCOUNT_FROZEN` (M15).
   */
  login: (username: string, password: string, reactivate?: boolean) => Promise<void>;
  register: (
    username: string,
    password: string,
    displayName?: string,
    /** ISO `YYYY-MM-DD` date of birth (M15) — drives the me-only 18+ gate. */
    birthdate?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  /** Session died out from under us (401 / gateway 4401). */
  sessionExpired: () => void;
  setUser: (user: User) => void;
  /**
   * Swap the live bearer to `token` WITHOUT going through the login screen — the
   * account-switch pivot (ADR 0013 step 4). Sets the api bearer + reactive
   * `token` + the secure-token boot cache; keeps `status` authenticated and the
   * current `user` until the switch's profileRefresh replaces it.
   */
  pivotSession: (token: string) => Promise<void>;
  /** Local sign-out to the login screen (no server call — caller already revoked). */
  signOutLocal: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
  status: "initializing",
  token: null,
  user: null,
  notice: null,

  initialize: async () => {
    // Load the account vault first so the switcher has its stored accounts even
    // when this boot ends up unauthenticated (e.g. the active token expired).
    await ensureVaultLoaded();
    const token = await tokenStorage.get();
    if (!token) {
      set({ status: "unauthenticated" });
      return;
    }
    setAuthToken(token);
    try {
      const { user } = await getApi().getMe();
      set({ status: "authenticated", token, user, notice: null });
      // Seed/refresh this account as the vault's active record. Doubles as the
      // one-time migration for an existing single-account user (ADR 0013 §2).
      await seedActiveAccount(user, token);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "NETWORK") {
        // Server unreachable — keep the token, let the user retry rather than
        // silently destroying a valid session (common when the server URL is
        // wrong or the host is asleep).
        set({ status: "unauthenticated", notice: "network" });
        return;
      }
      setAuthToken(null);
      await tokenStorage.clear();
      set({ status: "unauthenticated", notice: "sessionExpired" });
    }
  },

  login: async (username, password, reactivate) => {
    // Build the body as a variable so the additive `reactivate` field (not in the
    // shared login type — client-core is owned elsewhere and forwards the body
    // verbatim) passes without an object-literal excess-property error.
    const base = { username, password, ...mobileSessionMetadata() };
    const body = reactivate ? { ...base, reactivate: true } : base;
    const { token, user } = await getApi().login(body);
    setAuthToken(token);
    await tokenStorage.set(token);
    set({ status: "authenticated", token, user, notice: null });
    await seedActiveAccount(user, token);
  },

  register: async (username, password, displayName, birthdate) => {
    const { token, user } = await getApi().register({
      username,
      password,
      displayName,
      ...(birthdate ? { birthdate } : {}),
      ...mobileSessionMetadata(),
    });
    setAuthToken(token);
    await tokenStorage.set(token);
    set({ status: "authenticated", token, user, notice: null });
    await seedActiveAccount(user, token);
  },

  logout: async () => {
    const hadToken = get().token !== null;
    if (hadToken) {
      try {
        await getApi().logout();
      } catch {
        // Best effort — the local session is cleared regardless.
      }
    }
    setAuthToken(null);
    await tokenStorage.clear();
    set({ status: "unauthenticated", token: null, user: null, notice: null });
  },

  sessionExpired: () => {
    setAuthToken(null);
    void tokenStorage.clear();
    set({
      status: "unauthenticated",
      token: null,
      user: null,
      notice: "sessionExpired",
    });
  },

  setUser: (user) => set({ user }),

  pivotSession: async (token) => {
    setAuthToken(token);
    set({ token, notice: null });
    await tokenStorage.set(token);
  },

  signOutLocal: async () => {
    setAuthToken(null);
    await tokenStorage.clear();
    set({ status: "unauthenticated", token: null, user: null, notice: null });
  },
}));
