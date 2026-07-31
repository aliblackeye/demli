/**
 * System-idle DECISION logic — pure, electron-free, unit-testable.
 *
 * `system-idle.ts` is the Electron shell (powerMonitor + IPC + timers); every
 * rule that decides "is the user away?" lives here so it can be tested in plain
 * Node (mirrors the `pending-update.ts` / `auto-update.ts` split).
 */

import type { SystemIdleReason, SystemIdleState } from "./system-idle-types";

/** The one shape the decision needs to know about the machine. */
export interface SystemIdleInput {
  /** The machine is asleep (`powerMonitor` suspend, not yet resumed). */
  suspended: boolean;
  /** The session is locked (`powerMonitor` lock-screen, not yet unlocked). */
  locked: boolean;
  /**
   * Seconds since the last OS-wide input, from
   * `powerMonitor.getSystemIdleTime()`. `null` when the platform could not
   * answer (the call threw) — see the fail-safe below.
   */
  idleSeconds: number | null;
  /** The renderer's inactivity budget, already validated/bounded. */
  thresholdMs: number;
}

/** The active (present) state — the single literal, so identity checks stay easy. */
export const ACTIVE_STATE: SystemIdleState = { idle: false, reason: null };

/**
 * Decide the current idle state.
 *
 * Precedence: sleep > lock > inactivity clock. Sleeping and locking are
 * unambiguous "the human is not there" signals and take effect INSTANTLY (the
 * inactivity clock would otherwise take the full threshold to agree), while a
 * locked-then-slept machine should report the stronger reason.
 *
 * FAIL SAFE: an unknown idle time resolves to ACTIVE, never to away. Showing a
 * present user as online is a harmless no-op; showing a present user as "boşta"
 * because a platform call misbehaved is a visible lie to their friends.
 */
export function resolveSystemIdleState(input: SystemIdleInput): SystemIdleState {
  if (input.suspended) return { idle: true, reason: "suspended" };
  if (input.locked) return { idle: true, reason: "locked" };
  if (input.idleSeconds === null || !Number.isFinite(input.idleSeconds)) {
    return ACTIVE_STATE;
  }
  const idleMs = Math.max(0, input.idleSeconds) * 1000;
  return idleMs >= input.thresholdMs
    ? { idle: true, reason: "inactivity" }
    : ACTIVE_STATE;
}

/** True when two states are indistinguishable, so no transition is broadcast. */
export function sameSystemIdleState(
  a: SystemIdleState,
  b: SystemIdleState,
): boolean {
  return a.idle === b.idle && a.reason === b.reason;
}

/**
 * How long to wait before re-reading the clock.
 *
 * Two speeds on purpose. While ACTIVE nothing is time-critical — the only event
 * we can miss is crossing a multi-minute threshold, so a lazy poll is correct
 * and cheap. While AWAY the user's return must feel instant ("mouse oynatınca
 * çevrimiçiye dönmeli"), so we read the (very cheap: GetLastInputInfo) clock
 * every couple of seconds until they come back.
 */
export const ACTIVE_POLL_MS = 15_000;
/** @see ACTIVE_POLL_MS */
export const IDLE_POLL_MS = 2_000;

/** Poll delay for the state we are currently in. */
export function pollDelayMs(state: SystemIdleState): number {
  return state.idle ? IDLE_POLL_MS : ACTIVE_POLL_MS;
}

/** Re-export for consumers of this module (keeps imports to one place). */
export type { SystemIdleReason, SystemIdleState };
