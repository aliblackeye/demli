/**
 * Boot progress store — the REAL startup phases of the mobile app.
 *
 * The splash (components/BootSplash) must never show a made-up percentage
 * (CLAUDE.md §35). So this store owns nothing but a list of phases the app
 * genuinely waits for, and each phase is completed by the code that actually
 * finishes that work:
 *
 *   fonts     brand .ttf registered      → app/_layout (useAppFonts)
 *   i18n      catalogs + locale resolved → app/_layout (createI18n)
 *   session   persisted token validated  → BootPhaseBinder (auth-store status)
 *   data      first server payload       → BootDataBinder  (useGroups settled)
 *   realtime  gateway handshake done     → BootDataBinder  (connectionStatus)
 *
 * The last two only exist for a signed-in boot: a boot that lands on the sign-in
 * screen has no server data and no socket, so those phases are DROPPED (removed
 * from the denominator) rather than faked to 100%.
 *
 * Progress is therefore `completed / applicable` — monotonic (completed only
 * grows, applicable only shrinks) and always derived from something that really
 * happened.
 *
 * ── Never trap the user ─────────────────────────────────────────────────────
 * A splash that can hang forever turns a slow network into an app that "does not
 * open" — and on a phone that reads as a broken install. Three independent
 * guarantees prevent it:
 *
 *  1. `data` and `realtime` are OPTIONAL — {@link BootState.degraded} finishes
 *     them after a short grace (BootDataBinder), so a dead socket or a failed
 *     fetch can never block the shell; the in-app connection banner takes over.
 *  2. `fonts` self-resolves on failure/timeout (useAppFonts), so a corrupt asset
 *     degrades typography instead of the whole app.
 *  3. {@link BootStore.finishBoot} force-completes everything, and a blocking
 *     phase that stalls raises {@link BootState.failedPhase} so the splash can
 *     offer a real action ("try again" / "restart") instead of a spinner.
 *
 * This is a deliberate port of the desktop renderer's `stores/boot-store.ts`
 * (same model, same guarantees) adapted to the mobile phase list — no `window`,
 * no DOM.
 */

import { create } from "zustand";

/** One real startup step. Order is the order the splash narrates them in. */
export type BootPhase = "fonts" | "i18n" | "session" | "data" | "realtime";

/** Canonical phase order — also the initial `applicable` list. */
export const BOOT_PHASES: readonly BootPhase[] = [
  "fonts",
  "i18n",
  "session",
  "data",
  "realtime",
];

/**
 * Phases that must finish before the app is usable at all. A stall in one of
 * these is what earns the splash's error state + "try again"; a stall anywhere
 * else is simply completed as degraded and the app opens.
 */
export const BLOCKING_BOOT_PHASES: readonly BootPhase[] = ["fonts", "i18n", "session"];

export interface BootState {
  /** "booting" until every applicable phase is complete. */
  status: "booting" | "done";
  /** Phases this boot still expects to run, in order. Shrinks on drop. */
  applicable: BootPhase[];
  /** Phases that have finished (in completion order). */
  completed: BootPhase[];
  /** Phases that finished WITHOUT succeeding (e.g. the socket never came up). */
  degraded: BootPhase[];
  /** The phase currently being waited on — the first applicable, incomplete one. */
  phase: BootPhase | null;
  /** `Date.now()` of the last {@link BootState.phase} change; the watchdog keys on it. */
  phaseSince: number;
  /** A blocking phase gave up waiting; the splash shows its retry UI. */
  failedPhase: BootPhase | null;
}

interface BootActions {
  /** Mark a phase finished. Idempotent; ignores phases that were dropped. */
  completeBootPhase: (phase: BootPhase) => void;
  /** Finish a phase that never succeeded (optional work we refuse to wait on). */
  degradeBootPhase: (phase: BootPhase) => void;
  /** Rule phases out of this boot entirely (they leave the denominator). */
  dropBootPhases: (...phases: BootPhase[]) => void;
  /** The watchdog gave up on a blocking phase — show the retry UI. */
  failBootPhase: (phase: BootPhase) => void;
  /** User pressed "try again": clear the error and restart the stall clock. */
  clearBootFailure: () => void;
  /** Force the whole boot complete — the last-resort escape hatch. */
  finishBoot: () => void;
  /** Test seam only: back to a pristine pre-boot state. */
  resetBoot: () => void;
}

export type BootStore = BootState & BootActions;

function initialState(): BootState {
  return {
    status: "booting",
    applicable: [...BOOT_PHASES],
    completed: [],
    degraded: [],
    phase: BOOT_PHASES[0] ?? null,
    phaseSince: Date.now(),
    failedPhase: null,
  };
}

/**
 * Recompute the derived fields after `applicable`/`completed` changed. Keeps
 * `phase`/`phaseSince`/`status` in one place so no action can forget one, and
 * leaves `phaseSince` untouched when the current phase did not actually change
 * (otherwise the stall watchdog would reset on every unrelated update).
 */
function derive(
  state: BootState,
  next: Pick<BootState, "applicable" | "completed" | "degraded">,
): BootState {
  const done = new Set(next.completed);
  const phase = next.applicable.find((p) => !done.has(p)) ?? null;
  const complete = phase === null;
  return {
    ...state,
    ...next,
    phase,
    phaseSince: phase === state.phase ? state.phaseSince : Date.now(),
    status: complete ? "done" : "booting",
    // A phase that completed can no longer be the failing one.
    failedPhase:
      state.failedPhase !== null && done.has(state.failedPhase) ? null : state.failedPhase,
  };
}

export const useBootStore = create<BootStore>()((set, get) => ({
  ...initialState(),

  completeBootPhase: (phase) => {
    const state = get();
    if (state.completed.includes(phase)) return;
    // Dropped phases are not part of this boot — completing one is a no-op
    // rather than an error, so a late callback from a torn-down binder is safe.
    if (!state.applicable.includes(phase)) return;
    set(
      derive(state, {
        applicable: state.applicable,
        completed: [...state.completed, phase],
        degraded: state.degraded,
      }),
    );
  },

  degradeBootPhase: (phase) => {
    const state = get();
    if (state.completed.includes(phase)) return;
    if (!state.applicable.includes(phase)) return;
    set(
      derive(state, {
        applicable: state.applicable,
        completed: [...state.completed, phase],
        degraded: state.degraded.includes(phase) ? state.degraded : [...state.degraded, phase],
      }),
    );
  },

  dropBootPhases: (...phases) => {
    const state = get();
    const drop = new Set(phases);
    const applicable = state.applicable.filter((p) => !drop.has(p));
    if (applicable.length === state.applicable.length) return;
    set(
      derive(state, {
        applicable,
        // A dropped phase must also leave `completed`, or progress could exceed 1.
        completed: state.completed.filter((p) => !drop.has(p)),
        degraded: state.degraded.filter((p) => !drop.has(p)),
      }),
    );
  },

  failBootPhase: (phase) => {
    const state = get();
    if (state.status === "done") return;
    if (state.phase !== phase) return;
    if (state.failedPhase === phase) return;
    set({ failedPhase: phase });
  },

  clearBootFailure: () => {
    if (get().failedPhase === null) return;
    // Restart the stall clock too: a retry deserves the full grace period again.
    set({ failedPhase: null, phaseSince: Date.now() });
  },

  finishBoot: () => {
    const state = get();
    if (state.status === "done") return;
    const missing = state.applicable.filter((p) => !state.completed.includes(p));
    set(
      derive(state, {
        applicable: state.applicable,
        completed: [...state.completed, ...missing],
        degraded: [...state.degraded, ...missing.filter((p) => !state.degraded.includes(p))],
      }),
    );
  },

  resetBoot: () => set(initialState()),
}));

/**
 * Fraction of this boot that is genuinely finished, 0..1. `applicable` is never
 * empty in practice (the blocking phases can't be dropped), but the guard keeps
 * the selector total.
 */
export function selectBootProgress(state: BootState): number {
  if (state.status === "done") return 1;
  if (state.applicable.length === 0) return 1;
  return state.completed.length / state.applicable.length;
}

/** True when the phase we are waiting on must succeed before the app is usable. */
export function isBlockingBootPhase(phase: BootPhase | null): boolean {
  return phase !== null && BLOCKING_BOOT_PHASES.includes(phase);
}

/** Imperative helper for non-React callers (effects, promise callbacks). */
export const markBootPhase = (phase: BootPhase): void =>
  useBootStore.getState().completeBootPhase(phase);
