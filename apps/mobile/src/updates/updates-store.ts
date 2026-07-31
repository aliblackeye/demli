/**
 * OTA update state machine (Zustand — matches the app's other stores).
 *
 * Phases:
 *   idle                 no update pending / nothing to do
 *   checking             a check is in flight
 *   downloading          an OPTIONAL update is downloading in the background
 *   ready                an optional update is downloaded — show the banner
 *   critical-downloading a CRITICAL update is downloading (app is blocked)
 *   critical-reloading   reload dispatched into the critical update (blocked)
 *   critical-error       critical fetch/reload failed (blocked, offer retry)
 *
 * Optional updates NEVER block: on any error in the optional path we fall back
 * to `idle` and the user proceeds. Critical updates DO block: the gate renders a
 * full-screen screen for every `critical-*` phase until the reload succeeds.
 */
import { AppState } from "react-native";
import { create } from "zustand";
import type { AppTFunction } from "@/lib/i18n";
import { presentUpdateReadyNotification } from "@/push/push-manager";
import { checkForUpdate, fetchUpdate, reloadWithUpdate, updatesEnabled } from "./updates";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "critical-downloading"
  | "critical-reloading"
  | "critical-error";

/** Result surfaced to the manual "Check for updates" button in Settings. */
export type ManualCheckResult =
  | "disabled"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "critical"
  | "error";

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "Bilinmeyen hata";
}

/**
 * The active `t`, bound by {@link UpdateGate} (re-bound on language change) so
 * this non-React store can localize the OTA "update ready" notification. Null
 * before the first bind — we then skip notifying rather than emit English.
 */
let translate: AppTFunction | null = null;

/** Bind/clear the translator used for the update-ready notification. */
export function setUpdatesTranslator(t: AppTFunction | null): void {
  translate = t;
}

/**
 * When an optional update becomes ready while the app is NOT in the foreground,
 * present a local notification so a backgrounded user still learns to restart.
 * In the foreground the banner already covers it, so we suppress — the mobile
 * analog of the desktop's `document.hasFocus()` gate. Best-effort: skips when no
 * translator is bound yet, and the presenter itself never throws.
 */
function notifyReadyIfBackgrounded(): void {
  const t = translate;
  if (!t) return;
  if (AppState.currentState === "active") return;
  void presentUpdateReadyNotification(
    t("mobile:updates.notifyReadyTitle"),
    t("mobile:updates.notifyReadyBody"),
  );
}

const BUSY_PHASES: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  "checking",
  "downloading",
  "critical-downloading",
  "critical-reloading",
]);

interface UpdatesStore {
  phase: UpdatePhase;
  errorMessage: string | null;
  lastCheckAt: number | null;
  bannerDismissed: boolean;

  /** Run a check + (for critical) block-fetch-reload. `manual` surfaces a result. */
  check: (opts?: { manual?: boolean }) => Promise<ManualCheckResult>;
  /** Apply a downloaded optional update now (banner "restart"). */
  applyReady: () => Promise<void>;
  /** Retry a failed critical fetch/reload from the blocking screen. */
  retryCritical: () => Promise<void>;
  /** Hide the optional banner; the update still applies on next cold launch. */
  dismissBanner: () => void;
}

export const useUpdatesStore = create<UpdatesStore>()((set, get) => {
  /** The forced path: fetch then reload, staying blocked; on failure -> retry. */
  async function runCritical(): Promise<ManualCheckResult> {
    set({ phase: "critical-downloading", errorMessage: null });
    try {
      await fetchUpdate();
      set({ phase: "critical-reloading" });
      await reloadWithUpdate();
      // On success the app restarts and this line is never reached.
      return "critical";
    } catch (e) {
      set({ phase: "critical-error", errorMessage: errText(e) });
      return "error";
    }
  }

  return {
    phase: "idle",
    errorMessage: null,
    lastCheckAt: null,
    bannerDismissed: false,

    check: async ({ manual = false } = {}) => {
      if (!updatesEnabled()) return "disabled";

      const { phase } = get();
      if (BUSY_PHASES.has(phase)) return "downloading"; // something already running
      if (phase === "critical-error") return runCritical(); // stuck critical -> retry

      set({ phase: "checking", errorMessage: null });
      try {
        const outcome = await checkForUpdate();
        set({ lastCheckAt: Date.now() });

        if (!outcome.available) {
          set({ phase: "idle" });
          return "up-to-date";
        }
        if (outcome.critical) {
          return runCritical();
        }

        // Optional update: download quietly, then reveal the banner.
        set({ phase: "downloading" });
        const fetched = await fetchUpdate();
        if (fetched) {
          set({ phase: "ready", bannerDismissed: false });
          // Backgrounded users get a native heads-up; foregrounded ones see the banner.
          notifyReadyIfBackgrounded();
          return "ready";
        }
        set({ phase: "idle" });
        return "up-to-date";
      } catch (e) {
        // Optional path must never block — swallow to idle and let the user pass.
        set({ phase: "idle", errorMessage: errText(e) });
        void manual;
        return "error";
      }
    },

    applyReady: async () => {
      try {
        await reloadWithUpdate();
      } catch (e) {
        set({ errorMessage: errText(e) });
      }
    },

    retryCritical: async () => {
      await runCritical();
    },

    dismissBanner: () => set({ bannerDismissed: true }),
  };
});
