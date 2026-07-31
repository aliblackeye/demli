/**
 * Guarded account switch (ADR 0013 hardening — P0 #100).
 *
 * Wraps the ordered {@link runAccountSwitch} with a PROBE-BEFORE-PIVOT guard and a
 * defensive post-pivot rollback, so a dead stored token can never strand the user
 * on the "session expired" login screen (see token-probe.ts for the incident).
 *
 * The decision, in order:
 *
 *   1. Probe the target token (no live-client mutation).
 *        - `unreachable` → return "offline"; NOTHING is torn down — stay put.
 *        - `invalid`     → return "reauth";  NOTHING is torn down — the caller
 *                          re-authenticates the target while the current session
 *                          keeps running untouched.
 *        - `valid`       → proceed to the ordered switch.
 *   2. Run the switch onto the target.
 *        - If the PIVOT itself fails (pathological — it is a local vault/token
 *          write), identity never flipped: restore `previous` and report "offline".
 *   3. Defensive rollback: the probe passed but a bringup step still hit a 401 —
 *      the token died in the race window between probe and pivot. Roll back to the
 *      still-valid `previous` account and report "reauth" for the target, instead
 *      of letting the dead new session fall through to the login black screen.
 *
 * Framework-free by construction (mirrors switch-reset.ts): the platform injects
 * the probe, the per-account effect factory, and the auth-error classifier.
 */

import { runAccountSwitch, type AccountSwitchEffects, type AccountSwitchOptions } from "./switch-reset.js";
import type { TokenProbeResult } from "./token-probe.js";

/**
 * The switch decision the platform glue acts on:
 *  - `switched` — the pivot committed; `warning` is true when a best-effort
 *    bringup step failed (soft, non-blocking notice).
 *  - `reauth`   — the target token is dead (or died mid-switch and was rolled
 *    back); the caller opens the re-auth flow prefilled for `account`. The
 *    current/previous session is intact.
 *  - `offline`  — the target could not be reached (or the pivot could not
 *    commit); the caller stayed on the current account and shows a soft warning.
 */
export type GuardedAccountSwitchStatus = "switched" | "reauth" | "offline";

export interface GuardedAccountSwitchResult<Account> {
  status: GuardedAccountSwitchStatus;
  /** The account the UI acts on: the one landed on / to re-auth / that was unreachable. */
  account: Account;
  /** `switched` only: a best-effort bringup step failed (soft warning). */
  warning: boolean;
}

export interface GuardedAccountSwitchInput<Account extends { token: string }> {
  /** The stored account to switch to. */
  target: Account;
  /**
   * The currently-active account to fall back to on a race/rollback, or null when
   * there is nothing to fall back to (e.g. the post-logout hop to the next account,
   * where the current session has already been signed out).
   */
  previous: Account | null;
  /** Probe a token's liveness without touching the live client (see probeAccountToken). */
  probeToken: (token: string) => Promise<TokenProbeResult>;
  /** Build the ordered switch effects for a given account (target, or `previous` on rollback). */
  makeEffects: (account: Account) => AccountSwitchEffects;
  /**
   * Classify a recorded bringup error as a session-auth (401) failure — drives the
   * defensive rollback. Injected so this core stays wire-agnostic (the platform
   * passes `err instanceof ApiClientError && err.code === "UNAUTHORIZED"`).
   */
  isAuthError?: (error: unknown) => boolean;
  /** Forwarded to {@link runAccountSwitch} (teardown time-box). */
  switchOptions?: AccountSwitchOptions;
}

/**
 * Execute a guarded switch. Never throws — every failure resolves to a
 * {@link GuardedAccountSwitchResult} the platform maps to its UX.
 */
export async function runGuardedAccountSwitch<Account extends { token: string }>(
  input: GuardedAccountSwitchInput<Account>,
): Promise<GuardedAccountSwitchResult<Account>> {
  const { target, previous, probeToken, makeEffects, isAuthError, switchOptions } = input;

  const probe = await probeToken(target.token);
  if (probe === "unreachable") return { status: "offline", account: target, warning: false };
  if (probe === "invalid") return { status: "reauth", account: target, warning: false };

  // probe === "valid": the token authenticated a moment ago — commit the switch.
  const result = await runAccountSwitch(makeEffects(target), switchOptions);

  if (!result.ok) {
    // The pivot (activateToken) threw — a local vault/token write failed, so
    // identity never flipped and we are still on `previous`. Bring `previous`
    // back up (teardown already ran) and report it as an unreachable switch: we
    // stayed put.
    if (previous) await runAccountSwitch(makeEffects(previous), switchOptions);
    return { status: "offline", account: target, warning: false };
  }

  const authFailedAfterPivot =
    isAuthError !== undefined &&
    result.errors.some((error) => error.step === "profileRefresh" && isAuthError(error.error));

  if (authFailedAfterPivot && previous) {
    // Race: the target token died AFTER the probe passed but the pivot still
    // committed. Roll back onto the previous (still-valid) account and send the
    // user to re-auth the target — never fall through to "session expired".
    await runAccountSwitch(makeEffects(previous), switchOptions);
    return { status: "reauth", account: target, warning: false };
  }

  return { status: "switched", account: target, warning: result.errors.length > 0 };
}
