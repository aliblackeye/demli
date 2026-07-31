/**
 * Shared system-idle contract (OS-WIDE inactivity detection).
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring the other `*-types.ts` modules. Safe to
 * import from:
 *   - the main process (`system-idle.ts`, `system-idle-state.ts`)
 *   - the preload bridge (`preload/index.ts`)
 *   - the renderer (via a type-only import)
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 *
 * WHY THIS EXISTS
 * ---------------
 * The renderer can only observe activity that reaches ITS window
 * (`window.addEventListener`). That answers "is the user using Demli?", which is
 * the wrong question: the founder asked for "bilgisayarda bir yere dokunmayınca"
 * — i.e. the user working in a browser/game/editor is NOT away. Only the main
 * process can answer that, via `powerMonitor.getSystemIdleTime()` (seconds since
 * the last OS-wide input) plus the lock/sleep events. So main measures, and the
 * renderer is told the ANSWER over these channels.
 */

/**
 * IPC channel names for the system-idle watcher. Single source of truth — never
 * hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const SYSTEM_IDLE_CHANNELS = {
  /**
   * renderer -> main (invoke): start/re-arm the watcher with the caller's
   * threshold ({@link SystemIdleWatchOptions}); resolves to the CURRENT
   * {@link SystemIdleState} so the renderer can apply it without waiting for a
   * transition.
   */
  start: "demli:system-idle:start",
  /** renderer -> main (invoke, no payload): stop watching (logout / teardown). */
  stop: "demli:system-idle:stop",
  /** main -> renderer (send): a {@link SystemIdleState} TRANSITION occurred. */
  changed: "demli:system-idle:changed",
} as const;

export type SystemIdleChannel =
  (typeof SYSTEM_IDLE_CHANNELS)[keyof typeof SYSTEM_IDLE_CHANNELS];

/**
 * Why the OS considers the user away. Reported for diagnostics/logging only —
 * every reason means the same thing to the presence layer ("away"), so the
 * renderer must never branch on it for behaviour.
 */
export type SystemIdleReason =
  /** No OS-wide input (keyboard/mouse/touch) for at least the threshold. */
  | "inactivity"
  /** The session is locked (`powerMonitor` lock-screen). */
  | "locked"
  /** The machine went to sleep (`powerMonitor` suspend). */
  | "suspended";

/**
 * The only thing main tells the renderer about the user's machine: a boolean and
 * a coarse reason. Deliberately NOT the raw idle duration — the renderer has no
 * use for it, and a precise "user has been away 4h37m" reading is more
 * information than the UI layer needs about the person's machine (§28: keep the
 * exposed surface minimal).
 */
export interface SystemIdleState {
  /** True while the OS reports the user as away. */
  idle: boolean;
  /** Why we are away; always null while `idle` is false. */
  reason: SystemIdleReason | null;
}

/** Inactivity budget the caller wants, in milliseconds. Bounds below. */
export interface SystemIdleWatchOptions {
  /**
   * No OS-wide input for this long => idle. The RENDERER owns this number (a
   * single constant in `stores/idle-auto.ts`) and main re-validates it against
   * the bounds below, so the threshold stays configurable from one place without
   * main trusting whatever the renderer sends.
   */
  thresholdMs: number;
}

/** Lower bound for {@link SystemIdleWatchOptions.thresholdMs} (30 s). */
export const SYSTEM_IDLE_THRESHOLD_MIN_MS = 30_000;
/** Upper bound for {@link SystemIdleWatchOptions.thresholdMs} (24 h). */
export const SYSTEM_IDLE_THRESHOLD_MAX_MS = 24 * 60 * 60_000;

/**
 * The minimal system-idle surface exposed on `window.demli.systemIdle`.
 *
 * The renderer can only arm/disarm the watcher and listen; it gets no access to
 * `powerMonitor`, no raw idle duration, and no other main-process capability.
 * `start`'s payload is a single bounded integer, re-validated in main.
 */
export interface SystemIdleBridge {
  /** Arm (or re-arm) the watcher; resolves to the state as of right now. */
  start(options: SystemIdleWatchOptions): Promise<SystemIdleState>;
  /** Disarm the watcher. Idempotent. */
  stop(): Promise<void>;
  /**
   * Subscribe to idle/active TRANSITIONS. Only the sanitized payload reaches the
   * callback — never the raw IPC event. Returns an unsubscribe function.
   */
  onChanged(listener: (state: SystemIdleState) => void): () => void;
}
