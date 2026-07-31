/**
 * Session/auth store. Owns the session token and the authenticated user.
 *
 * Token persistence goes through the shared `TokenStorage` seam
 * (@demli/client-core, ADR 0002). Desktop implements it below over the
 * main-process secureToken bridge (Electron `safeStorage`, OS-encrypted on
 * disk); mobile implements the same interface with expo-secure-store. The token
 * never touches renderer-accessible storage (security-review M1).
 */

import { create } from "zustand";
import type { TokenStorage } from "@demli/client-core";
import type { User } from "@demli/types";
import { api, ApiClientError, setAuthToken } from "../lib/api-client";
import { desktopSessionMetadata } from "../lib/session-metadata";
import { ensureVaultLoaded, seedActiveAccount } from "../lib/account-manager";

/**
 * A user-facing auth-screen notice, kept as a stable `common.errors.*` key
 * rather than a rendered string so the store stays i18n-free (ADR 0009). The
 * auth screen localizes it with `t()` at render time.
 */
export type AuthNoticeKey = "errors.network" | "errors.sessionExpired";

/**
 * Pre-safeStorage builds persisted the token here in localStorage. We migrate
 * it into the secure store once (see {@link tokenStorage}.get) and then never
 * read or write this key again.
 *
 */
const LEGACY_TOKEN_STORAGE_KEY = "demli.session.token";

function readLegacyToken(): string | null {
  try {
    return window.localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearLegacyToken(): void {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

/**
 * safeStorage-backed {@link TokenStorage}. The token lives in the Electron main
 * process (OS-encrypted via `safeStorage`, persisted under userData) and is
 * reached only through the validated preload bridge — never localStorage, which
 * any renderer-context script (incl. XSS) can read (security-review M1).
 *
 * One-time migration: a token persisted by a pre-safeStorage build lives in
 * localStorage. The first {@link get} without a secure-store token lifts it
 * into the secure store and deletes the localStorage copy, so existing sessions
 * survive the upgrade. After that localStorage is never touched for the token.
 */
const tokenStorage: TokenStorage = {
  async get() {
    const secure = window.demli.secureToken;
    const existing = await secure.get();
    if (existing !== null) {
      // Secure store already owns the session — drop any stale legacy copy.
      clearLegacyToken();
      return existing;
    }
    // Migrate a legacy localStorage token into the secure store exactly once.
    const legacy = readLegacyToken();
    if (legacy !== null) {
      await secure.set(legacy);
      clearLegacyToken();
      return legacy;
    }
    return null;
  },
  async set(token) {
    await window.demli.secureToken.set(token);
  },
  async clear() {
    await window.demli.secureToken.clear();
    // Defensively drop any lingering legacy token so a logout can't leave one.
    clearLegacyToken();
  },
};

export type AuthStatus = "initializing" | "unauthenticated" | "authenticated";

interface AuthStore {
  status: AuthStatus;
  token: string | null;
  user: User | null;
  /** Notice shown on the auth screen (e.g. "session expired"), as a translation key. */
  notice: AuthNoticeKey | null;

  /** Validate any persisted token on boot. */
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    password: string,
    displayName?: string,
    /** ISO date of birth `YYYY-MM-DD` (M15) — for +18 content gating server-side. */
    birthdate?: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  /** Session died out from under us (401 / gateway 4401). */
  sessionExpired: () => void;
  setUser: (user: User) => void;
  /**
   * Swap the live bearer to `token` WITHOUT going through the login screen — the
   * account-switch pivot (ADR 0013 step 4). Sets the api bearer + the reactive
   * `token` + the secure-token boot cache; keeps `status` authenticated and the
   * current `user` until the switch's profileRefresh replaces it.
   */
  pivotSession: (token: string) => Promise<void>;
  /**
   * Local sign-out to the login screen (no server call — the caller already
   * revoked the token). Used by the account manager when no stored account
   * remains after logging out the last one.
   */
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
      const { user } = await api.getMe();
      set({ status: "authenticated", token, user, notice: null });
      // Seed/refresh this account as the vault's active record. Doubles as the
      // one-time migration for an existing single-account user (ADR 0013 §2).
      await seedActiveAccount(user, token);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "NETWORK") {
        // Server unreachable — keep the token, let the user retry from the
        // auth screen rather than silently destroying a valid session.
        set({ status: "unauthenticated", notice: "errors.network" });
        return;
      }
      setAuthToken(null);
      await tokenStorage.clear();
      set({ status: "unauthenticated", notice: "errors.sessionExpired" });
    }
  },

  login: async (username, password) => {
    const { token, user } = await api.login({
      username,
      password,
      ...desktopSessionMetadata(),
    });
    setAuthToken(token);
    await tokenStorage.set(token);
    set({ status: "authenticated", token, user, notice: null });
    await seedActiveAccount(user, token);
  },

  register: async (username, password, displayName, birthdate) => {
    const { token, user } = await api.register({
      username,
      password,
      displayName,
      birthdate,
      ...desktopSessionMetadata(),
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
        await api.logout();
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
      notice: "errors.sessionExpired",
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
