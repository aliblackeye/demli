/**
 * Shared auto-update contract.
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron`, `electron-updater`, or `node` — mirroring `capture-types.ts`,
 * `secure-token-types.ts`, and `crash-reporter-types.ts`. That keeps it safe to
 * import from:
 *   - the main process (`auto-update.ts`)      — values + types
 *   - the preload bridge (`preload/index.ts`)  — values + types
 *   - the renderer (via a type-only import)     — types only
 *
 * Do not add electron/node/electron-updater imports here, or the renderer bundle
 * will break.
 */

/**
 * IPC channel names for auto-update. Single source of truth — never hard-code
 * these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const UPDATE_CHANNELS = {
  /** renderer -> main (invoke): trigger a manual update check; resolves to the current {@link UpdateStatus}. */
  check: "demli:updates:check",
  /** renderer -> main (invoke): read the last-known {@link UpdateStatus} (seeds the UI on mount). */
  getStatus: "demli:updates:get-status",
  /**
   * renderer -> main (invoke): apply the update. If an update is available it
   * begins the download; once downloaded it quits and installs. No-op for any
   * other state (a renderer can never force an unexpected restart).
   */
  downloadAndInstall: "demli:updates:download-and-install",
  /** main -> renderer (send): pushes every {@link UpdateStatus} transition. */
  status: "demli:updates:status",
} as const;

export type UpdateChannel =
  (typeof UPDATE_CHANNELS)[keyof typeof UPDATE_CHANNELS];

/**
 * Which operation failed. The main process is language-agnostic: it emits this
 * machine code, and the renderer localizes it (ADR 0009 — main can't use React
 * hooks, so it never authors user-facing text). Never a raw stack (CLAUDE.md §26).
 */
export type UpdateErrorScope = "check" | "download";

/**
 * The update lifecycle as a discriminated union. The `critical` flag on the
 * available/downloading/ready states marks a MANDATORY (force) update: the main
 * process auto-downloads it and, once ready, quits + installs without letting the
 * user skip (see `auto-update.ts`). The renderer uses the flag to show a blocking
 * required-update overlay.
 */
export type UpdateStatus =
  /** Updater inactive — dev build or not packaged. Nothing will ever download. */
  | { kind: "disabled" }
  /** A check is in flight. */
  | { kind: "checking" }
  /** No newer version on the feed. */
  | { kind: "up-to-date"; version: string }
  /** A newer version exists; awaiting user action (non-critical) or auto-download (critical). */
  | { kind: "available"; version: string; critical: boolean }
  /** The update package is downloading. `percent` is 0–100. */
  | { kind: "downloading"; version: string; percent: number; critical: boolean }
  /** The update is downloaded and ready to install on restart. */
  | { kind: "ready"; version: string; critical: boolean }
  /** The last check/download failed. `scope` is the machine code the renderer localizes. */
  | { kind: "error"; scope: UpdateErrorScope };

export type UpdateStatusKind = UpdateStatus["kind"];

/**
 * The minimal update surface exposed on `window.demli.updates`.
 *
 * All renderer -> main calls are argument-free, so there is no untrusted payload
 * to smuggle across the bridge (the only inbound data is the outbound status the
 * main process authors). `downloadAndInstall` is state-guarded in main, so the
 * renderer cannot force an install/quit at will.
 */
export interface UpdatesBridge {
  /** Trigger a manual check. Resolves to the resulting status. */
  check(): Promise<UpdateStatus>;
  /** Read the current status (used to seed the UI when a view mounts). */
  getStatus(): Promise<UpdateStatus>;
  /**
   * Subscribe to status transitions. Returns an unsubscribe function. Only the
   * sanitized {@link UpdateStatus} payload reaches the callback — never the raw
   * IPC event.
   */
  onStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Download (if available) then install-on-restart (if downloaded). No-op otherwise. */
  downloadAndInstall(): Promise<void>;
}
