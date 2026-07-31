/**
 * Shared secure-vault contract (M15 / ADR 0013 — multi-account vault).
 *
 * A SECOND encrypted single-value slot beside the secure-token store
 * (`secure-token-types.ts`). It persists the account-vault JSON blob — the
 * registry of every signed-in account (their tokens + cached profiles) the
 * switcher flips between. Kept as its own fixed channel/file rather than
 * overloading the token slot, exactly as ADR 0013 §2 prescribes (the vault sits
 * BESIDE `TokenStorage`, which stays the boot fast-cache).
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring `secure-token-types.ts`. Safe to import
 * from the main process (values + types), the preload bridge (values + types),
 * and the renderer (type-only). Do not add electron/node imports here.
 */

/**
 * IPC channel names for the secure account-vault store. Single source of truth —
 * never hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 *
 * The vault holds MULTIPLE session tokens, so it is at least as sensitive as the
 * single token; it is persisted OS-encrypted (Electron `safeStorage`) in the main
 * process and reached only through these validated channels — never
 * renderer-accessible storage (security parity with security-review M1).
 */
export const SECURE_VAULT_CHANNELS = {
  /** renderer -> main (invoke): read the persisted vault blob, or null. */
  get: "demli:vault:get",
  /** renderer -> main (invoke): persist the vault blob (validated in main). */
  set: "demli:vault:set",
  /** renderer -> main (invoke): delete the persisted vault blob. */
  clear: "demli:vault:clear",
} as const;

export type SecureVaultChannel =
  (typeof SECURE_VAULT_CHANNELS)[keyof typeof SECURE_VAULT_CHANNELS];

/**
 * The minimal secure-vault surface exposed on `window.demli.secureVault`.
 * This is the desktop implementation of the shared `VaultStorage` seam
 * (@demli/client-core account-vault, ADR 0013): async get/set/clear over a
 * serialized JSON string, nothing more — the exact string in / string out shape
 * of `SecureTokenBridge`, so the same encrypted backend fits unchanged.
 */
export interface SecureVaultBridge {
  /** Resolve the persisted vault blob, or null when none is stored / decryptable. */
  get(): Promise<string | null>;
  /** Persist the (non-empty) serialized vault blob (OS-encrypted on disk). */
  set(value: string): Promise<void>;
  /** Remove the persisted vault (full sign-out of every account). */
  clear(): Promise<void>;
}
