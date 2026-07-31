/**
 * Shared secure-token contract.
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring `capture-types.ts`. That keeps it safe
 * to import from:
 *   - the main process (`secure-token.ts`)          — values + types
 *   - the preload bridge (`preload/index.ts`)       — values + types
 *   - the renderer (via a type-only import)          — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 */

/**
 * IPC channel names for the secure session-token store. Single source of truth
 * — never hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 *
 * The token is persisted OS-encrypted (Electron `safeStorage`) in the main
 * process and reached only through these validated channels; it never touches
 * renderer-accessible storage (security-review M1).
 */
export const SECURE_TOKEN_CHANNELS = {
  /** renderer -> main (invoke): read the persisted session token, or null. */
  get: "demli:token:get",
  /** renderer -> main (invoke): persist a session token (validated in main). */
  set: "demli:token:set",
  /** renderer -> main (invoke): delete the persisted session token. */
  clear: "demli:token:clear",
} as const;

export type SecureTokenChannel =
  (typeof SECURE_TOKEN_CHANNELS)[keyof typeof SECURE_TOKEN_CHANNELS];

/**
 * The minimal secure-token surface exposed on `window.demli.secureToken`.
 * This is the desktop implementation of the shared `TokenStorage` seam
 * (@demli/client-core, ADR 0002): async get/set/clear, nothing more.
 */
export interface SecureTokenBridge {
  /** Resolve the persisted token, or null when none is stored / decryptable. */
  get(): Promise<string | null>;
  /** Persist a non-empty session token (OS-encrypted on disk). */
  set(token: string): Promise<void>;
  /** Remove any persisted token. */
  clear(): Promise<void>;
}
