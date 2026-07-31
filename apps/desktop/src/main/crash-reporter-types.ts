/**
 * Shared crash-reporting contract.
 *
 * Pure TypeScript types plus the IPC channel-name constants and payload bounds,
 * importing NOTHING from `electron` or `node` — mirroring `capture-types.ts` and
 * `secure-token-types.ts`. That keeps it safe to import from:
 *   - the main process (`crash-reporter.ts`)   — values + types
 *   - the preload bridge (`preload/index.ts`)  — values + types
 *   - the renderer (via a type-only import)     — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 */

/**
 * IPC channel names for crash reporting. Single source of truth — never
 * hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const CRASH_CHANNELS = {
  /**
   * renderer -> main (invoke): report a structured renderer-side error (a caught
   * React render error, or a global window.onerror / unhandledrejection) so it
   * can be appended to the local crash log. The payload is re-validated in main.
   */
  reportRenderer: "demli:crash:report-renderer",
} as const;

export type CrashChannel = (typeof CRASH_CHANNELS)[keyof typeof CRASH_CHANNELS];

/**
 * Upper bounds on the renderer-error payload. Errors are diagnostic strings, not
 * user content — these ceilings block an absurdly large payload from bloating
 * the crash log while leaving generous room for a real message + stack traces.
 */
export const CRASH_PAYLOAD_LIMITS = {
  /** Max characters for the error message. */
  message: 2000,
  /** Max characters for a JS stack trace. */
  stack: 8000,
  /** Max characters for a React component stack. */
  componentStack: 8000,
} as const;

/**
 * A structured renderer-side error report. The `message` is required; the two
 * stacks are best-effort diagnostics (present for real Errors, absent for
 * thrown non-Error values). All fields are truncated to
 * {@link CRASH_PAYLOAD_LIMITS} before they reach the wire, then re-validated and
 * re-bounded in the main process.
 */
export interface RendererErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
}

/**
 * The minimal crash surface exposed on `window.demli.crash`. Report-only:
 * the renderer can push an error report, nothing more. It never reads the crash
 * log or the minidump directory back out — those stay in the main process.
 */
export interface CrashBridge {
  /** Append a structured renderer error to the local crash log. */
  reportRendererError(report: RendererErrorReport): Promise<void>;
}
