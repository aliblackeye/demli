/**
 * The SWITCH-RESET CONTRACT (ADR 0013) — the ordered teardown+bringup that makes
 * an account switch leave ZERO state behind from the previous account.
 *
 * This exists because of a live incident: switching accounts left the old
 * identity's state dangling — a "zombie session" (voice engine still on the old
 * room, WebSocket re-authing with the stale token, query cache serving the old
 * user's groups/DMs). The fix is not "remember to clean up" scattered across two
 * platforms — it is ONE ordered sequence, defined and TESTED here in shared code,
 * that both desktop and mobile drive by injecting their platform effects.
 *
 * The order is the contract. Three phases:
 *
 *   TEARDOWN (old token still valid — needed to leave the LiveKit room / notify
 *             peers over the still-open socket):
 *     1. endActiveCall      hang up any live/ringing DM call
 *     2. voiceLeaveDispose  voice engine leave() then dispose() — release room,
 *                           mic, screen tracks, worklets
 *     3. realtimeDisconnect close the WS bound to the OLD token (stop its backoff
 *                           reconnect from racing the swap)
 *
 *   PIVOT (the identity flips here; the ONLY step whose failure aborts the switch):
 *     4. activateToken      vault.setActive(next) + setAuthToken(next.token) +
 *                           mirror the token into TokenStorage (the boot path)
 *
 *   BRINGUP (new token):
 *     5. queryCacheClear    queryClient.clear() — drop ALL server cache from the
 *                           old identity (clear, not per-key removeQueries)
 *     6. storeReset         reset per-user in-memory stores (voice/unread/DM/nav…)
 *     7. realtimeConnect    RealtimeClient.connect(next.token) — fresh handshake
 *     8. pushReregister     bind the push token to the new account (mobile; desktop no-op)
 *     9. profileRefresh     getMe() → vault.upsert(next) + auth-store.setUser
 *
 * Teardown and bringup effects are BEST-EFFORT: a wedged voice-leave or a failed
 * push re-register must never strand the user on the old account, so each is
 * caught (and teardown steps are time-boxed) and recorded in the result instead
 * of aborting. Only the pivot is required.
 *
 * Framework-free (mirrors the dm-call controller): this file never imports
 * zustand, TanStack Query, or LiveKit — the platform passes those as callbacks.
 */

/** Which phase a step belongs to — teardown (old token) → pivot → bringup (new). */
export type AccountSwitchPhase = "teardown" | "pivot" | "bringup";

/** The ordered step identifiers of the switch-reset contract. */
export type AccountSwitchStepId =
  | "endActiveCall"
  | "voiceLeaveDispose"
  | "realtimeDisconnect"
  | "activateToken"
  | "queryCacheClear"
  | "storeReset"
  | "realtimeConnect"
  | "pushReregister"
  | "profileRefresh";

export interface AccountSwitchStep {
  id: AccountSwitchStepId;
  phase: AccountSwitchPhase;
  /** True only for the pivot — a failure here aborts the switch. */
  required: boolean;
  description: string;
}

/**
 * The canonical, ordered switch-reset plan. This array IS the contract — the
 * executor runs it in order, the ADR documents it, and the order test asserts it.
 * Do not reorder without updating ADR 0013 and the test.
 */
export const ACCOUNT_SWITCH_STEPS: readonly AccountSwitchStep[] = [
  { id: "endActiveCall", phase: "teardown", required: false, description: "Hang up any live or ringing DM call." },
  { id: "voiceLeaveDispose", phase: "teardown", required: false, description: "Voice engine leave() then dispose() — release room, mic, screen, worklets." },
  { id: "realtimeDisconnect", phase: "teardown", required: false, description: "Disconnect the WebSocket bound to the old token." },
  { id: "activateToken", phase: "pivot", required: true, description: "Set the vault active account and swap the auth token (setAuthToken + TokenStorage)." },
  { id: "queryCacheClear", phase: "bringup", required: false, description: "queryClient.clear() — drop all cached server data from the old identity." },
  { id: "storeReset", phase: "bringup", required: false, description: "Reset per-user in-memory stores (voice, unread, DM/call, navigation…)." },
  { id: "realtimeConnect", phase: "bringup", required: false, description: "Open a fresh WebSocket handshake with the new token." },
  { id: "pushReregister", phase: "bringup", required: false, description: "Re-register the push token against the new account (mobile; desktop no-op)." },
  { id: "profileRefresh", phase: "bringup", required: false, description: "getMe() → refresh the cached profile in the vault and the auth store." },
] as const;

/**
 * The platform effects for each step. Required effects cover the always-present
 * layers (media, realtime, token, query cache, stores); the rest are optional so
 * a platform without that layer (e.g. desktop push) simply omits them. Each may
 * be sync or async; the executor awaits whatever is returned.
 */
export interface AccountSwitchEffects {
  /** Optional — platforms that fold call teardown into voice may omit this. */
  endActiveCall?: () => void | Promise<void>;
  voiceLeaveDispose: () => void | Promise<void>;
  realtimeDisconnect: () => void | Promise<void>;
  /** The pivot — must set the active account AND swap the auth token atomically. */
  activateToken: () => void | Promise<void>;
  queryCacheClear: () => void | Promise<void>;
  storeReset: () => void | Promise<void>;
  realtimeConnect: () => void | Promise<void>;
  pushReregister?: () => void | Promise<void>;
  profileRefresh?: () => void | Promise<void>;
}

export interface AccountSwitchOptions {
  /**
   * Max ms to await each TEARDOWN step before moving on, so a wedged voice-leave
   * or socket close can't strand the user on the old account. <= 0 disables the
   * guard (await indefinitely). Default 5000.
   */
  teardownTimeoutMs?: number;
  /**
   * Max ms to await each BRINGUP step before recording it as a soft error and
   * moving on. The bringup steps are network/native-bound (realtimeConnect,
   * pushReregister → Expo/FCM token mint, profileRefresh → getMe): on a real
   * device a slow/hung one of these must NEVER leave the covering switch overlay
   * up forever (the founder's "black screen — kill the app" report). <= 0 disables
   * the guard (await indefinitely) — the DEFAULT, so platforms that don't opt in
   * (e.g. desktop) keep the previous unbounded behavior. Mobile passes a value.
   */
  bringupTimeoutMs?: number;
}

export interface AccountSwitchStepError {
  step: AccountSwitchStepId;
  error: unknown;
}

export interface AccountSwitchResult {
  /** False only when the pivot (activateToken) failed — the switch did not happen. */
  ok: boolean;
  /** Non-fatal failures from best-effort steps, in the order they occurred. */
  errors: AccountSwitchStepError[];
}

const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;

/** Thrown internally when a teardown step exceeds its time box; surfaced as a step error. */
export class AccountSwitchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`account switch step timed out after ${timeoutMs}ms`);
    this.name = "AccountSwitchTimeoutError";
  }
}

function withTimeout(effect: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  const run = Promise.resolve().then(effect);
  if (timeoutMs <= 0) return run;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AccountSwitchTimeoutError(timeoutMs)), timeoutMs);
    run.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Execute the switch-reset contract in {@link ACCOUNT_SWITCH_STEPS} order.
 *
 * - Teardown steps run best-effort and time-boxed; a failure/timeout is recorded
 *   and the sequence continues (never strand the user on the old account).
 * - The pivot (activateToken) is awaited without a timeout; if it throws the
 *   switch is aborted and `{ ok: false }` is returned with the error.
 * - Bringup steps run best-effort (they use the NEW token / are local); failures
 *   are recorded but the switch still succeeds.
 *
 * Returns every non-fatal error so the UI can surface a soft warning
 * ("switched, but couldn't refresh notifications") without blocking the switch.
 */
export async function runAccountSwitch(
  effects: AccountSwitchEffects,
  options: AccountSwitchOptions = {},
): Promise<AccountSwitchResult> {
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  // Default 0 = disabled (unbounded), preserving the prior behavior for callers
  // that don't opt in (desktop). Mobile passes a value so a hung native/network
  // bringup step can't wedge the switch overlay forever.
  const bringupTimeoutMs = options.bringupTimeoutMs ?? 0;
  const errors: AccountSwitchStepError[] = [];

  const effectFor = (id: AccountSwitchStepId): (() => void | Promise<void>) | undefined => {
    switch (id) {
      case "endActiveCall":
        return effects.endActiveCall;
      case "voiceLeaveDispose":
        return effects.voiceLeaveDispose;
      case "realtimeDisconnect":
        return effects.realtimeDisconnect;
      case "activateToken":
        return effects.activateToken;
      case "queryCacheClear":
        return effects.queryCacheClear;
      case "storeReset":
        return effects.storeReset;
      case "realtimeConnect":
        return effects.realtimeConnect;
      case "pushReregister":
        return effects.pushReregister;
      case "profileRefresh":
        return effects.profileRefresh;
    }
  };

  for (const step of ACCOUNT_SWITCH_STEPS) {
    const effect = effectFor(step.id);
    if (!effect) continue; // optional step the platform doesn't implement

    if (step.phase === "pivot") {
      try {
        await Promise.resolve().then(effect);
      } catch (error) {
        errors.push({ step: step.id, error });
        return { ok: false, errors };
      }
      continue;
    }

    try {
      if (step.phase === "teardown") {
        await withTimeout(effect, teardownTimeoutMs);
      } else {
        // bringup — time-boxed only when the caller opts in (bringupTimeoutMs > 0);
        // otherwise awaited unbounded, exactly as before.
        await withTimeout(effect, bringupTimeoutMs);
      }
    } catch (error) {
      errors.push({ step: step.id, error });
    }
  }

  return { ok: true, errors };
}
