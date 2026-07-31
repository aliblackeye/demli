/**
 * Session-token persistence seam. The interface lives here (shared); the
 * IMPLEMENTATION stays per-app because storage is platform-specific:
 *
 * - desktop  → localStorage today, Electron `safeStorage` behind the preload
 *              bridge later (M5 hardening); see stores/auth-store.ts.
 * - mobile   → `expo-secure-store`.
 *
 * Async by design so the secure-store backends (which are async) fit without
 * changing this contract.
 */
export interface TokenStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}
