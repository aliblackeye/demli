/**
 * Startup splash — Demli mark, a REAL progress bar, and one line of status.
 *
 * The bar is driven by {@link useBootStore}, whose phases are completed by the
 * code that actually finishes each piece of startup work (fonts, i18n catalogs,
 * session restore, first server payload, gateway handshake). Nothing here
 * animates a fake percentage (CLAUDE.md §35).
 *
 * ── Never a dead end ────────────────────────────────────────────────────────
 * A splash that can hang is worse than no splash: it makes the app look like it
 * does not open at all. Three layers stop that:
 *  - the non-blocking phases finish themselves (see BootPhaseBinder's grace
 *    timers), so the shell opens even with a dead socket or a failed fetch;
 *  - {@link CEILING_AFTER_SESSION_MS} force-completes the boot once the session
 *    is known — past that point the app is usable, whatever else is pending;
 *  - a blocking phase that stalls past {@link FAIL_MS} swaps the status line for
 *    an honest error with "try again" / "restart", so the user always has an
 *    action instead of a spinner.
 *
 * ── Startup update ──────────────────────────────────────────────────────────
 * On a cold start the app finishes updating itself here rather than opening a
 * stale build (see components/BootUpdateBinder + lib/boot-update). While that is
 * happening the bar STOPS being the phase counter and becomes main's real
 * `download-progress` percent, and the copy says so. The ceiling above is
 * suspended for exactly that window — the update flow has its own hard
 * deadlines, so cutting a visible download off at ten seconds would defeat the
 * feature without buying any extra safety.
 *
 * ── Visual continuity with the pre-boot skeleton ────────────────────────────
 * apps/web/index.html paints a static logo + empty track before the JS bundle
 * lands. The geometry below (112px mark, 24px gap, 18rem/70vw track) is mirrored
 * there verbatim, and the skeleton is removed only once THIS component's mark
 * has painted — so the handover has no flash and no jump.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@demli/ui";
import demliLogo from "../assets/demli-logo.svg";
import { isBootUpdateActive, type BootUpdateStage } from "../lib/boot-update";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import {
  isBlockingBootPhase,
  selectBootProgress,
  useBootStore,
  type BootPhase,
} from "../stores/boot-store";
import { useBootUpdateStore } from "../stores/boot-update-store";

/** After this long on one phase the copy admits it is taking a while. */
const SLOW_MS = 4_000;
/** After this long on a BLOCKING phase the splash gives the user actions. */
const FAIL_MS = 13_000;
/**
 * Once the session phase is done the app is usable, so anything still pending
 * (server payload, socket) gets this long before the splash lets go regardless.
 * The binder's own grace timers are shorter; this is the backstop.
 */
const CEILING_AFTER_SESSION_MS = 10_000;
/** Fade-out duration; the unmount timer sits just past it. */
const FADE_OUT_MS = 320;

/**
 * Koyu Masa splash: the black page (`--color-rail`) with ONE warm light behind the
 * mark — the landing's "dem" glow, in the coral `--color-accent-glow`. Read from
 * the tokens, never re-typed: the pre-boot skeletons in both index.html files
 * must repeat the literal values (no stylesheet has loaded yet when they paint),
 * and `boot-surface.test.ts` fails if either drifts from globals.css.
 */
export const SPLASH_GLOW =
  "radial-gradient(42% 32% at 50% 44%, var(--color-accent-glow), transparent 72%)";

/**
 * The line under the bar, per phase. A switch over literal keys (rather than a
 * key map) so the strictly-typed `t` still checks every key at compile time.
 */
function phaseLabel(t: AppTFunction, phase: BootPhase | null): string {
  switch (phase) {
    case "shell":
      return t("desktop:boot.phase.shell");
    case "i18n":
      return t("desktop:boot.phase.i18n");
    case "session":
      return t("desktop:boot.phase.session");
    case "data":
      return t("desktop:boot.phase.data");
    case "realtime":
      return t("desktop:boot.phase.realtime");
    case "update":
      return t("desktop:boot.phase.update");
    default:
      return t("desktop:boot.ready");
  }
}

/**
 * Drop the static pre-bundle skeleton (web only) once our own mark has painted.
 * Idempotent, and safe on desktop where the element does not exist.
 */
function removeBootSkeleton(): void {
  document.getElementById("boot-skeleton")?.remove();
}

interface BootSplashProps {
  /**
   * i18n is one of the boot phases, so for the first moments there is no `t()`.
   * Until then the splash shows the mark and the bar with NO copy rather than an
   * untranslated string.
   */
  translationsReady: boolean;
}

export function BootSplash({ translationsReady }: BootSplashProps): JSX.Element | null {
  const done = useBootStore((s) => s.status === "done");
  const phase = useBootStore((s) => s.phase);
  const phaseSince = useBootStore((s) => s.phaseSince);
  const failedPhase = useBootStore((s) => s.failedPhase);
  const sessionSettled = useBootStore((s) => s.completed.includes("session"));
  const progress = useBootStore(selectBootProgress);
  // Primitive selectors, not a derived object: these change a few times per boot
  // and must not re-render the splash on every unchanged store notification.
  const updateStage = useBootUpdateStore((s) => s.state.stage);
  const updatePercent = useBootUpdateStore((s) => s.state.percent);
  const updating = isBootUpdateActive(updateStage);

  const [slow, setSlow] = useState(false);
  const [exit, setExit] = useState<"in" | "out" | "gone">("in");
  const markRef = useRef<HTMLImageElement | null>(null);

  // ── Stall watchdogs ──────────────────────────────────────────────────────
  // Both key on `phaseSince`, so every phase change (and every retry, which
  // resets the clock) gets the full grace period again.
  useEffect(() => {
    if (done) return;
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS);
    // Only a blocking phase earns the error UI; the optional ones complete
    // themselves (BootPhaseBinder) long before this would fire.
    const failTimer = isBlockingBootPhase(phase)
      ? window.setTimeout(() => {
          if (phase) useBootStore.getState().failBootPhase(phase);
        }, FAIL_MS)
      : null;
    return () => {
      window.clearTimeout(slowTimer);
      if (failTimer !== null) window.clearTimeout(failTimer);
    };
  }, [done, phase, phaseSince]);

  // Backstop: the session is known, so the app IS usable — never keep the user
  // here waiting on optional work. Suspended while the app is updating itself:
  // that path is already bounded (lib/boot-update budgets), the user is watching
  // a real percentage, and force-finishing under it would either strand a
  // half-downloaded update or yank the app open a beat before it restarts.
  useEffect(() => {
    if (done || !sessionSettled || updating) return;
    const timer = window.setTimeout(
      () => useBootStore.getState().finishBoot(),
      CEILING_AFTER_SESSION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [done, sessionSettled, updating]);

  // ── Hand-over ────────────────────────────────────────────────────────────
  // Keyed on `done` ALONE. `exit` must stay out of the dependencies: the
  // `setExit("out")` below re-runs the effect, whose cleanup would cancel the
  // unmount timer it had just armed — leaving an invisible full-screen overlay
  // pinned over the app forever. (`done` only ever flips once, so this still
  // runs exactly once.)
  useEffect(() => {
    if (!done) return;
    setExit("out");
    // Unmount just after the fade. A plain timer (not `transitionend`) so a
    // reduced-motion user — whose transition is clamped to 0.01ms — is not left
    // waiting on an event that already fired.
    const timer = window.setTimeout(() => setExit("gone"), FADE_OUT_MS + 40);
    return () => window.clearTimeout(timer);
  }, [done]);

  // The static skeleton stays until our own mark is on screen (or gave up), so
  // the two never both disappear for a frame.
  useEffect(() => {
    if (markRef.current?.complete) removeBootSkeleton();
    const failsafe = window.setTimeout(removeBootSkeleton, 1_500);
    return () => window.clearTimeout(failsafe);
  }, []);

  const retry = useCallback(() => {
    const boot = useBootStore.getState();
    boot.clearBootFailure();
    // The only blocking phase that can realistically stall is the session
    // restore (a network round-trip); re-running it is idempotent.
    if (boot.phase === "session") {
      void useAuthStore.getState().initialize();
    }
  }, []);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  if (exit === "gone") return null;

  const leaving = exit === "out";
  // While the app is updating itself the bar tracks the DOWNLOAD, not the boot
  // phases — it is the one number the user cares about at that moment, and it is
  // main's real `download-progress` percent (CLAUDE.md §35: never a fake one).
  // The changeover is announced by the copy below in the same frame, so the bar
  // rewinding once reads as "new task", not as lost progress.
  const percent = updating
    ? updateStage === "downloading"
      ? updatePercent
      : 100
    : Math.round(progress * 100);

  return (
    <div
      // Above every in-app layer (the highest product overlay is z-[100]).
      className="fixed inset-0 z-[200] flex select-none flex-col items-center justify-center gap-6 bg-rail px-6"
      style={{
        backgroundImage: SPLASH_GLOW,
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_OUT_MS}ms var(--motion-ease-standard)`,
        // Once it is fading it must not swallow a click meant for the app.
        pointerEvents: leaving ? "none" : "auto",
      }}
      role="status"
      aria-live="polite"
      aria-busy={!done}
    >
      {/* 128px on a normal window, 112px on a phone-width web viewport. The mark
          is a 256px raster, so 128 is exactly 1:1 at 2x — the largest it can be
          drawn while staying perfectly sharp. (The rail's mark was previously
          left too small to read; this one is the hero of the screen.) */}
      <img
        ref={markRef}
        src={demliLogo}
        alt="Demli"
        width={128}
        height={128}
        onLoad={removeBootSkeleton}
        onError={removeBootSkeleton}
        className="size-28 wide:size-32"
      />

      <div className="flex w-[min(18rem,70vw)] flex-col items-center gap-3">
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-wash-strong"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{
              width: `${percent}%`,
              transition: "width var(--motion-duration-arrival) var(--motion-ease-arrival)",
            }}
          />
        </div>

        {/* Reserved height so the copy appearing never nudges the bar. */}
        <div className="flex min-h-9 w-full flex-col items-center justify-start gap-2 text-center">
          {translationsReady ? (
            // The update line wins over the failure UI: when the app is about to
            // reinstall and relaunch itself, "try again" is not the truth on
            // screen — the restart is.
            updating ? (
              <BootUpdateLine stage={updateStage} percent={updatePercent} />
            ) : failedPhase !== null ? (
              <BootFailure onRetry={retry} onReload={reload} />
            ) : (
              <BootStatusLine phase={phase} slow={slow} />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BootStatusLine({
  phase,
  slow,
}: {
  phase: BootPhase | null;
  slow: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <p className="animate-fade-in text-xs text-fg-muted">
      {phaseLabel(t, phase)}
      {slow ? <span className="text-fg-faint"> · {t("desktop:boot.slow")}</span> : null}
    </p>
  );
}

/**
 * What the bar area says while the app updates itself at startup. Three honest
 * lines, in the order they happen: downloading (with the real percent) →
 * applying → restarting. The last one exists so the relaunch is announced BEFORE
 * it happens; a window that vanishes unasked is the surprise we are avoiding.
 */
function BootUpdateLine({
  stage,
  percent,
}: {
  stage: BootUpdateStage;
  percent: number;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <p className="animate-fade-in text-xs text-fg-muted">
      {stage === "downloading"
        ? t("desktop:boot.update.downloading", { percent })
        : stage === "installing"
          ? t("desktop:boot.update.installing")
          : t("desktop:boot.update.restarting")}
    </p>
  );
}

/**
 * The honest end of the road: the app could not finish a step it genuinely
 * needs. Two real actions, no fake progress and no silent spinner.
 */
function BootFailure({
  onRetry,
  onReload,
}: {
  onRetry: () => void;
  onReload: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="animate-fade-in flex flex-col items-center gap-3">
      <p className="text-xs text-fg-muted">{t("desktop:boot.errorBody")}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRetry}>
          {t("desktop:boot.retry")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onReload}>
          {t("desktop:boot.reload")}
        </Button>
      </div>
    </div>
  );
}
