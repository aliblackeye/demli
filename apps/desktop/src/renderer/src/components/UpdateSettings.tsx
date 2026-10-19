import { useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import {
  Check,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button, IconButton, cn } from "@demli/ui";
import { overlayFade, popIn, toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import {
  checkForUpdates,
  downloadOrInstall,
  isCriticalActive,
  useUpdateStatus,
  type UpdateStatus,
} from "../lib/update-status";
import { SettingsBlock, SettingsGroup } from "./settings-kit";

/**
 * App-update UI (renderer). The lifecycle itself lives in lib/update-status.ts —
 * one subscription to the validated `window.demli.updates` bridge, shared with
 * the top-right {@link ../components/UpdateBadge UpdateBadge}. This file paints:
 *
 *   - {@link UpdateSettings}: the "Uygulama güncellemeleri" settings panel —
 *     check / download / restart with live status + progress.
 *   - {@link CriticalUpdateOverlay}: a full-screen blocking overlay shown while a
 *     MANDATORY update downloads + installs (the user cannot skip). The real
 *     enforcement is in main (auto-download + quitAndInstall); this is the UX.
 *   - {@link GlobalUpdateBanner}: a floating, dismissible card for OPTIONAL
 *     updates. Mounted at the App root for the SIGNED-OUT screens only — once the
 *     shell is up, the top-right UpdateBadge owns optional updates, and showing
 *     both would be two controls for one job.
 *   - {@link AuthUpdateFooter}: version + "check for updates" line for the
 *     login screen (updates must be reachable without signing in).
 */

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function StatusRow({
  icon,
  tone = "muted",
  children,
}: {
  icon: JSX.Element;
  tone?: "muted" | "accent" | "danger";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2.5 text-sm",
        tone === "danger" ? "text-danger" : tone === "accent" ? "text-fg" : "text-fg-muted",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * Download progress. The fill is a `scaleX` transform (GPU, no layout per tick)
 * rather than a width, because progress events arrive many times a second.
 */
function ProgressBar({ percent, label }: { percent: number; label?: string }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
      className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-raised"
    >
      <div
        className="h-full w-full origin-left rounded-full bg-accent transition-transform motion-standard"
        style={{ transform: `scaleX(${clamped / 100})` }}
      />
    </div>
  );
}

/**
 * "Uygulama güncellemeleri" settings section. Presents the current update state
 * and the single contextual action (check / download / restart).
 */
export function UpdateSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  const currentVersion = window.demli?.appInfo.version ?? "0.0.0";

  return (
    <SettingsGroup title={t("desktop:updates.title")}>
      <SettingsBlock className="py-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-px flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised/60 text-fg-muted"
          >
            <Download className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium text-fg">
              {t("desktop:updates.installedVersion", { version: currentVersion })}
            </p>
            {status.kind === "disabled" && (
              <StatusRow icon={<Check className="size-4" />}>{t("desktop:updates.disabled")}</StatusRow>
            )}
            {status.kind === "checking" && (
              <StatusRow icon={<Loader2 className="size-4 animate-spin" />}>
                {t("desktop:updates.checking")}
              </StatusRow>
            )}
            {status.kind === "up-to-date" && (
              <StatusRow icon={<Check className="size-4 text-success" />} tone="accent">
                {t("desktop:updates.upToDate")}
              </StatusRow>
            )}
            {status.kind === "available" && (
              <StatusRow icon={<Download className="size-4 text-accent" />} tone="accent">
                {t("desktop:updates.available", { version: status.version })}
              </StatusRow>
            )}
            {status.kind === "downloading" && (
              <>
                <StatusRow icon={<Loader2 className="size-4 animate-spin" />}>
                  {t("desktop:updates.downloading", { percent: status.percent })}
                </StatusRow>
                <ProgressBar percent={status.percent} label={t("desktop:updates.actionDownloading")} />
              </>
            )}
            {status.kind === "ready" && (
              <StatusRow icon={<Check className="size-4 text-accent" />} tone="accent">
                {t("desktop:updates.ready", { version: status.version })}
              </StatusRow>
            )}
            {status.kind === "error" && (
              <StatusRow icon={<TriangleAlert className="size-4" />} tone="danger">
                {t(`desktop:updates.errors.${status.scope}`)}
              </StatusRow>
            )}
          </div>
          <div className="shrink-0 self-center">
            <UpdateAction status={status} />
          </div>
        </div>
      </SettingsBlock>
    </SettingsGroup>
  );
}

function UpdateAction({ status }: { status: UpdateStatus }): JSX.Element | null {
  const { t } = useAppTranslation();
  switch (status.kind) {
    case "disabled":
      return null;
    case "checking":
    case "downloading":
      return (
        <Button variant="secondary" size="sm" disabled>
          <Loader2 className="size-4 animate-spin" />
          {status.kind === "downloading"
            ? t("desktop:updates.actionDownloading")
            : t("desktop:updates.actionChecking")}
        </Button>
      );
    case "available":
      return (
        <Button variant="accent" size="sm" onClick={downloadOrInstall}>
          <Download className="size-4" />
          {t("desktop:updates.update")}
        </Button>
      );
    case "ready":
      return (
        <Button variant="accent" size="sm" onClick={downloadOrInstall}>
          <RotateCcw className="size-4" />
          {t("desktop:updates.restart")}
        </Button>
      );
    case "up-to-date":
    case "error":
    default:
      return (
        <Button variant="secondary" size="sm" onClick={checkForUpdates}>
          <RefreshCw className="size-4" />
          {t("desktop:updates.checkForUpdates")}
        </Button>
      );
  }
}

// ---------------------------------------------------------------------------
// Critical (forced) update overlay
// ---------------------------------------------------------------------------

/**
 * Full-screen, non-dismissible overlay shown while a MANDATORY update installs.
 * Mounted app-wide (always, so it can appear regardless of what view is open);
 * renders nothing unless the current status is a critical update in progress.
 * Portaled to `document.body` so it sits above every other surface.
 */
export function CriticalUpdateOverlay(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  if (!isCriticalActive(status)) {
    return null;
  }

  const percent = status.kind === "downloading" ? status.percent : undefined;
  const isReady = status.kind === "ready";

  return createPortal(
    <m.div
      variants={overlayFade}
      initial="initial"
      animate="animate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="critical-update-title"
      aria-describedby="critical-update-body"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-rail/90 backdrop-blur-[10px]"
    >
      <m.div
        variants={popIn}
        className="relative w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-card bg-app p-8 text-center"
      >
        {/* The one warm light on the black table, held still. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 mx-auto size-48 rounded-full bg-accent-glow blur-3xl"
        />
        <div className="relative mb-5 flex justify-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-accent-surface text-accent">
            <ShieldAlert className="size-6" />
          </div>
        </div>
        <h1 id="critical-update-title" className="relative font-display text-xl font-medium text-fg-display">
          {t("desktop:updates.critical.title")}
        </h1>
        <p
          id="critical-update-body"
          className="relative mx-auto mt-2 max-w-[340px] text-sm leading-relaxed text-fg-muted"
        >
          {t("desktop:updates.critical.body")}
        </p>

        {isReady ? (
          <div role="status" className="relative mt-6 flex items-center justify-center gap-2.5 text-sm text-fg">
            <RotateCcw className="size-4 animate-spin" />
            {t("desktop:updates.critical.restarting")}
          </div>
        ) : (
          <div className="relative">
            <div role="status" className="mt-6 flex items-center justify-center gap-2.5 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" />
              {percent === undefined
                ? t("desktop:updates.critical.preparing")
                : t("desktop:updates.critical.downloading", { percent })}
            </div>
            <ProgressBar percent={percent ?? 0} label={t("desktop:updates.critical.title")} />
          </div>
        )}
      </m.div>
    </m.div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Global (optional) update banner
// ---------------------------------------------------------------------------

/**
 * Floating card for OPTIONAL updates, mounted app-wide (App root) so a new
 * version is visible and installable from ANY screen — the login screen
 * included. Critical updates are excluded (the blocking overlay owns those).
 * Dismiss hides the banner for that version only; the next release shows again.
 */
export function GlobalUpdateBanner(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const visible =
    (status.kind === "available" || status.kind === "downloading" || status.kind === "ready") &&
    // CriticalUpdateOverlay owns mandatory updates.
    !status.critical &&
    dismissedVersion !== status.version;

  // Always mounted behind AnimatePresence so dismissing PLAYS the exit (sinks
  // away) instead of vanishing in one frame.
  return createPortal(
    <AnimatePresence>
      {visible && (
        <m.div
          key="update-banner"
          role="status"
          variants={toastPop}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed bottom-4 right-4 z-[90] w-[340px] max-w-[calc(100vw-2rem)] rounded-card p-4 surface-glass-strong shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-surface text-accent">
              <Download className="size-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg">
                {status.kind === "ready"
                  ? t("desktop:updates.banner.ready", { version: status.version })
                  : t("desktop:updates.banner.available", { version: status.kind === "available" || status.kind === "downloading" ? status.version : "" })}
              </p>
              <p className="mt-0.5 text-label text-fg-muted">
                {status.kind === "downloading"
                  ? t("desktop:updates.banner.downloading", { percent: status.percent })
                  : status.kind === "ready"
                    ? t("desktop:updates.banner.readyHint")
                    : t("desktop:updates.banner.availableHint")}
              </p>
              {status.kind === "downloading" && (
                <ProgressBar percent={status.percent} label={t("desktop:updates.actionDownloading")} />
              )}
              {(status.kind === "available" || status.kind === "ready") && (
                <div className="mt-3">
                  <Button variant="accent" size="sm" onClick={downloadOrInstall}>
                    {status.kind === "ready" ? (
                      <>
                        <RotateCcw className="size-4" />
                        {t("desktop:updates.restart")}
                      </>
                    ) : (
                      <>
                        <Download className="size-4" />
                        {t("desktop:updates.update")}
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              label={t("desktop:updates.banner.dismiss")}
              tooltipSide="left"
              onClick={() => {
                if (status.kind === "available" || status.kind === "downloading" || status.kind === "ready") {
                  setDismissedVersion(status.version);
                }
              }}
            >
              <X />
            </IconButton>
          </div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Login-screen footer (version + manual check)
// ---------------------------------------------------------------------------

/**
 * Slim version/update line for the login screen. Updates must be reachable
 * BEFORE signing in: this gives the current version, a manual "check" action
 * and inline feedback; an actually-available update is then surfaced by
 * {@link GlobalUpdateBanner} (mounted at the App root).
 */
export function AuthUpdateFooter(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  const currentVersion = window.demli?.appInfo.version ?? "0.0.0";

  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-xs text-fg-faint">
      <span>{t("desktop:updates.footer.version", { version: currentVersion })}</span>
      <span aria-hidden>·</span>
      {status.kind === "checking" ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" />
          {t("desktop:updates.footer.checking")}
        </span>
      ) : (
        <button
          type="button"
          onClick={checkForUpdates}
          title={t("desktop:updates.footer.recheck")}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 font-medium transition-colors hover:underline",
            "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            status.kind === "error"
              ? "text-danger hover:text-danger"
              : "text-fg-muted hover:text-fg",
          )}
        >
          {status.kind === "up-to-date" ? (
            <>
              <Check className="size-3" />
              {t("desktop:updates.footer.upToDate")}
            </>
          ) : status.kind === "error" ? (
            <>
              <TriangleAlert className="size-3" />
              {t("desktop:updates.footer.failed")}
            </>
          ) : (
            t("desktop:updates.footer.check")
          )}
        </button>
      )}
    </div>
  );
}
