/**
 * Startup update flow — the pure state machine.
 *
 * Founder requirement: "bilgisayar yeni açılırken her zaman yeni sürüm varsa
 * indirsin loadingde … otomatik halletsin". So on a COLD START, while the boot
 * splash is up, we let the app finish updating itself instead of opening an
 * already-stale build and nagging with a badge.
 *
 * This module is deliberately framework-free: no React, no zustand, no timers,
 * no IPC. It is a reducer over `(state, event) -> (state, effects)`, where time
 * arrives as a number on every event. That is what makes the one guarantee that
 * matters here testable without a DOM (see ./boot-update.test.ts):
 *
 *   ***A SLOW OR DEAD NETWORK MUST NEVER STOP THE APP FROM OPENING.***
 *
 * This codebase has already paid for that lesson once (BootSplash's stall
 * watchdogs). An update flow bolted onto the splash is the single easiest way to
 * reintroduce "the app does not open", so every waiting state below has a hard,
 * unconditional deadline, and every deadline ends in exactly one place: a
 * `release` effect that hands the update back to the ordinary in-app flow (the
 * top-right UpdateBadge) and lets the boot finish.
 *
 * ── Where it sits in the boot ───────────────────────────────────────────────
 * The flow owns ONE boot phase (`"update"`, see stores/boot-store.ts). Holding
 * that phase incomplete is the only way it can keep the splash on screen, and
 * releasing it is the only way it can let go — so it can never invent a new way
 * to block, and `finishBoot()` still overrides everything.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *  - It never runs outside a cold start. There is no background auto-download
 *    while the user is in the app; `autoDownload` stays false in main and the
 *    badge keeps owning user-initiated updates.
 *  - It never touches MANDATORY updates: main auto-downloads + force-installs
 *    those and CriticalUpdateOverlay owns the UI, so seeing `critical` here
 *    releases immediately rather than racing it.
 */

import type { UpdateStatus } from "./update-status";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * How long we wait for the feed to give a DEFINITE answer.
 *
 * Cheap because it is nearly free: main starts its check the moment the app is
 * ready — before the window has even loaded — so by the time the renderer arms
 * this machine the round-trip is usually already resolved. 2.5s covers a slow
 * TLS handshake without adding a visible pause to the common "up to date" boot.
 * Offline is faster still: electron-updater errors out and we release at once.
 */
export const BOOT_UPDATE_CHECK_BUDGET_MS = 2_500;

/**
 * How long a startup download may run before we stop waiting and open the app.
 *
 * 20s buys the whole installer on any ordinary broadband line (~5 MB/s), which
 * is the case this feature exists for. Slower than that and finishing at boot is
 * the wrong trade: main keeps downloading in the background, the badge picks the
 * same download up mid-flight, and `autoInstallOnAppQuit` applies it on exit —
 * nothing is lost by opening now.
 */
export const BOOT_UPDATE_DOWNLOAD_BUDGET_MS = 20_000;

/**
 * A download that has not moved a single percent for this long is treated as
 * dead (captive portal, dropped Wi-Fi, throttled to nothing) and released
 * immediately, without burning the rest of the budget.
 */
export const BOOT_UPDATE_STALL_MS = 6_000;

/**
 * At the deadline, a download this far along gets ONE extension: abandoning at
 * 90% only to re-download later is worse for the user than a few more seconds
 * of a bar they can see moving.
 */
export const BOOT_UPDATE_NEAR_DONE_PERCENT = 75;

/** Length of that single extension. Absolute worst case is budget + this. */
export const BOOT_UPDATE_NEAR_DONE_GRACE_MS = 10_000;

/**
 * How long "Güncelleme uygulanıyor…" stays on screen before we actually quit.
 * The restart must never be a surprise — the user came here to open the app, so
 * they get told what is about to happen first.
 */
export const BOOT_UPDATE_INSTALL_NOTICE_MS = 1_200;

/**
 * If `quitAndInstall()` has not taken the process down by now, it is not going
 * to (a locked installer, a blocked elevation prompt). Release and open the app
 * on the CURRENT version; the package is downloaded, so the badge offers the
 * restart and the quit-time installer still applies it later.
 */
export const BOOT_UPDATE_APPLY_FALLBACK_MS = 8_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `idle`        not armed yet (also the state on a surface with no updater).
 * `checking`    waiting for the feed's verdict, bounded by the check budget.
 * `downloading` a startup download is in flight; `percent` is main's real one.
 * `installing`  downloaded; showing the "applying" notice before we quit.
 * `applying`    `quitAndInstall()` requested; the process should be going away.
 * `released`    terminal — the boot phase is free and the app opens.
 */
export type BootUpdateStage =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "applying"
  | "released";

/** Why the flow let go. Recorded for logs and for the drop/degrade decision. */
export type BootUpdateRelease =
  /** No updater on this surface (web build, or no preload bridge at all). */
  | "unsupported"
  /** Updater inactive — an unpackaged/dev run. */
  | "disabled"
  /** The feed says we are current. The overwhelmingly common case. */
  | "up-to-date"
  /** Mandatory update: main force-installs it and the blocking overlay owns the UI. */
  | "critical"
  /** The check itself failed (offline, DNS not up yet, feed down). */
  | "check-failed"
  /** The feed did not answer inside {@link BOOT_UPDATE_CHECK_BUDGET_MS}. */
  | "check-timeout"
  /** The download errored out. */
  | "download-failed"
  /** The download made no progress for {@link BOOT_UPDATE_STALL_MS}. */
  | "download-stalled"
  /** The download ran past its budget. */
  | "download-timeout"
  /** `quitAndInstall()` did not take the process down. */
  | "install-timeout"
  /** Something outside finished the boot (crash fallback, forced finish). */
  | "abandoned";

export interface BootUpdateState {
  stage: BootUpdateStage;
  /** Version being handled; "" while unknown. */
  version: string;
  /** Real download percent (0-100) from main's `download-progress` events. */
  percent: number;
  /** Timestamp the CURRENT stage's clock started. */
  since: number;
  /** Timestamp `percent` last actually moved — the stall clock. */
  progressAt: number;
  /** The near-done extension has been granted (at most once). */
  extended: boolean;
  /** True once the splash took the flow over (download or install shown). */
  engaged: boolean;
  /** Set when the flow ends; null before that. */
  release: BootUpdateRelease | null;
}

export type BootUpdateEvent =
  /** Splash mounted. `supported` is false on web / with no preload bridge. */
  | { type: "arm"; at: number; supported: boolean }
  /** A status from main (only dispatch once the bridge has really answered). */
  | { type: "status"; at: number; status: UpdateStatus }
  /** Clock pulse — the only thing that can trip a deadline. */
  | { type: "tick"; at: number }
  /** The boot finished by some other route; stand down without acting. */
  | { type: "abandon"; at: number };

export type BootUpdateEffect =
  /** Ask main to begin the download (`available` -> `downloading`). */
  | { type: "start-download" }
  /** Ask main to install + relaunch (`ready` -> quitAndInstall). */
  | { type: "apply" }
  /**
   * Let the boot finish. `engaged` distinguishes "this boot never had an update
   * to install" (drop the phase — the bar must look exactly as it does today)
   * from "we tried and had to give up" (degrade it — it happened, it failed).
   */
  | { type: "release"; reason: BootUpdateRelease; engaged: boolean };

export interface BootUpdateResult {
  state: BootUpdateState;
  effects: BootUpdateEffect[];
}

export function initialBootUpdateState(): BootUpdateState {
  return {
    stage: "idle",
    version: "",
    percent: 0,
    since: 0,
    progressAt: 0,
    extended: false,
    engaged: false,
    release: null,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** No-op result — returns the SAME state object so subscribers don't re-render. */
function idle(state: BootUpdateState): BootUpdateResult {
  return { state, effects: [] };
}

/** The single exit. Every deadline, error and unexpected transition ends here. */
function release(
  state: BootUpdateState,
  at: number,
  reason: BootUpdateRelease,
): BootUpdateResult {
  if (state.stage === "released") {
    return idle(state);
  }
  return {
    state: { ...state, stage: "released", since: at, release: reason },
    effects: [{ type: "release", reason, engaged: state.engaged }],
  };
}

function beginDownload(
  state: BootUpdateState,
  at: number,
  version: string,
  percent: number,
): BootUpdateState {
  return {
    ...state,
    stage: "downloading",
    version,
    percent,
    since: at,
    progressAt: at,
    extended: false,
    engaged: true,
  };
}

function beginInstall(
  state: BootUpdateState,
  at: number,
  version: string,
): BootUpdateState {
  return {
    ...state,
    stage: "installing",
    version,
    percent: 100,
    since: at,
    progressAt: at,
    engaged: true,
  };
}

function onStatusWhileChecking(
  state: BootUpdateState,
  at: number,
  status: UpdateStatus,
): BootUpdateResult {
  switch (status.kind) {
    case "checking":
      return idle(state);
    case "disabled":
      return release(state, at, "disabled");
    case "up-to-date":
      return release(state, at, "up-to-date");
    case "error":
      return release(state, at, "check-failed");
    case "available":
      // Mandatory updates belong to main + CriticalUpdateOverlay; a second
      // driver would double-trigger the download and fight over the restart.
      if (status.critical) {
        return release(state, at, "critical");
      }
      return {
        state: beginDownload(state, at, status.version, 0),
        effects: [{ type: "start-download" }],
      };
    case "downloading":
      if (status.critical) {
        return release(state, at, "critical");
      }
      // Main started this itself (the crash-recovery resume path). Ride along and
      // narrate it — no second `downloadUpdate()` call.
      return { state: beginDownload(state, at, status.version, status.percent), effects: [] };
    case "ready":
      if (status.critical) {
        return release(state, at, "critical");
      }
      return { state: beginInstall(state, at, status.version), effects: [] };
    default:
      return idle(state);
  }
}

function onStatusWhileDownloading(
  state: BootUpdateState,
  at: number,
  status: UpdateStatus,
): BootUpdateResult {
  switch (status.kind) {
    case "downloading": {
      if (status.critical) {
        return release(state, at, "critical");
      }
      // Monotonic: a percent that goes backwards (a retried range request) must
      // not look like the bar unwinding, and must not reset the stall clock.
      const percent = Math.max(state.percent, clampPercent(status.percent));
      if (percent === state.percent) {
        return idle(state);
      }
      return { state: { ...state, percent, progressAt: at }, effects: [] };
    }
    case "ready":
      if (status.critical) {
        return release(state, at, "critical");
      }
      return { state: beginInstall(state, at, status.version), effects: [] };
    case "error":
      return release(state, at, "download-failed");
    default:
      // available / checking / up-to-date / disabled mid-download means main
      // dropped the job (a manual re-check, a feed change). Nothing to wait for.
      return release(state, at, "download-failed");
  }
}

function onTick(state: BootUpdateState, at: number): BootUpdateResult {
  switch (state.stage) {
    case "checking":
      return at - state.since >= BOOT_UPDATE_CHECK_BUDGET_MS
        ? release(state, at, "check-timeout")
        : idle(state);

    case "downloading": {
      if (at - state.progressAt >= BOOT_UPDATE_STALL_MS) {
        return release(state, at, "download-stalled");
      }
      const deadline =
        state.since +
        BOOT_UPDATE_DOWNLOAD_BUDGET_MS +
        (state.extended ? BOOT_UPDATE_NEAR_DONE_GRACE_MS : 0);
      if (at < deadline) {
        return idle(state);
      }
      if (!state.extended && state.percent >= BOOT_UPDATE_NEAR_DONE_PERCENT) {
        return { state: { ...state, extended: true }, effects: [] };
      }
      return release(state, at, "download-timeout");
    }

    case "installing":
      return at - state.since >= BOOT_UPDATE_INSTALL_NOTICE_MS
        ? {
            state: { ...state, stage: "applying", since: at },
            effects: [{ type: "apply" }],
          }
        : idle(state);

    case "applying":
      return at - state.since >= BOOT_UPDATE_APPLY_FALLBACK_MS
        ? release(state, at, "install-timeout")
        : idle(state);

    default:
      return idle(state);
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Advance the startup-update flow. Pure: same input, same output, no clock of
 * its own — `at` is supplied by the caller so every deadline is testable.
 */
export function reduceBootUpdate(
  state: BootUpdateState,
  event: BootUpdateEvent,
): BootUpdateResult {
  if (state.stage === "released") {
    return idle(state);
  }

  switch (event.type) {
    case "arm":
      // Idempotent: React StrictMode mounts the binder twice in dev, and a
      // second arm must not restart the clock or re-run the flow.
      if (state.stage !== "idle") {
        return idle(state);
      }
      if (!event.supported) {
        return release(state, event.at, "unsupported");
      }
      return {
        state: { ...state, stage: "checking", since: event.at, progressAt: event.at },
        effects: [],
      };

    case "status":
      switch (state.stage) {
        case "checking":
          return onStatusWhileChecking(state, event.at, event.status);
        case "downloading":
          return onStatusWhileDownloading(state, event.at, event.status);
        case "installing":
        case "applying":
          // Past the point of no return; only a hard failure is worth reacting
          // to (the fallback timer covers everything else).
          return event.status.kind === "error"
            ? release(state, event.at, "download-failed")
            : idle(state);
        default:
          return idle(state);
      }

    case "tick":
      return onTick(state, event.at);

    case "abandon":
      return release(state, event.at, "abandoned");

    default:
      return idle(state);
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * What (if anything) the splash should say INSTEAD of its ordinary phase copy.
 * `null` means "the update flow has nothing to show" — either it is still
 * checking (invisible, sub-second, and the real phases are more informative) or
 * it is done.
 */
export type BootUpdateDisplay =
  | { mode: "downloading"; percent: number }
  | { mode: "installing" }
  | { mode: "restarting" }
  | null;

export function selectBootUpdateDisplay(state: BootUpdateState): BootUpdateDisplay {
  switch (state.stage) {
    case "downloading":
      return { mode: "downloading", percent: state.percent };
    case "installing":
      return { mode: "installing" };
    case "applying":
      return { mode: "restarting" };
    default:
      return null;
  }
}

/**
 * True while the splash is narrating the UPDATE rather than the boot. The splash
 * uses this to (a) show the download percent in the bar and (b) suspend its
 * post-session "open anyway" ceiling — this flow has its own hard deadlines, and
 * cutting a visible download short at 10s would defeat the whole feature.
 */
export function isBootUpdateActive(stage: BootUpdateStage): boolean {
  return stage === "downloading" || stage === "installing" || stage === "applying";
}
