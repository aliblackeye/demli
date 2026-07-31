import { useState } from "react";
import { createPortal } from "react-dom";
import { m } from "framer-motion";
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
import { Button, cn } from "@demli/ui";
import { overlayFade, popIn, toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import {
  checkForUpdates,
  downloadOrInstall,
  isCriticalActive,
  useUpdateStatus,
  type UpdateStatus,
} from "../lib/update-status";

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
      className={cn(
        "flex items-center gap-2.5 text-sm",
        tone === "danger"
          ? "text-danger"
          : tone === "accent"
            ? "text-fg"
            : "text-fg-muted",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div
        className="h-full rounded-full bg-accent transition-[width] motion-fast"
        style={{ width: `${clamped}%` }}
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
    <section className="rounded-xl border border-stroke bg-surface p-5">
      <h2 className="text-sm font-semibold text-fg">{t("desktop:updates.title")}</h2>
      <p className="mt-1 text-xs text-fg-faint">
        {t("desktop:updates.installedVersion", { version: currentVersion })}
      </p>

      <div className="mt-4">
        {status.kind === "disabled" && (
          <StatusRow icon={<Check className="size-4" />}>
            {t("desktop:updates.disabled")}
          </StatusRow>
        )}

        {status.kind === "checking" && (
          <StatusRow icon={<Loader2 className="size-4 animate-spin" />}>
            {t("desktop:updates.checking")}
          </StatusRow>
        )}

        {status.kind === "up-to-date" && (
          <StatusRow icon={<Check className="size-4 text-accent" />} tone="accent">
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
            <ProgressBar percent={status.percent} />
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

      <div className="mt-4">
        <UpdateAction status={status} />
      </div>
    </section>
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
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-4 animate-spin" />
          {status.kind === "downloading"
            ? t("desktop:updates.actionDownloading")
            : t("desktop:updates.actionChecking")}
        </Button>
      );
    case "available":
      return (
        <Button size="sm" onClick={downloadOrInstall}>
          <Download className="size-4" />
          {t("desktop:updates.update")}
        </Button>
      );
    case "ready":
      return (
        <Button size="sm" onClick={downloadOrInstall}>
          <RotateCcw className="size-4" />
          {t("desktop:updates.restart")}
        </Button>
      );
    case "up-to-date":
    case "error":
    default:
      return (
        <Button variant="outline" size="sm" onClick={checkForUpdates}>
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-app/95 backdrop-blur-sm"
    >
      <m.div
        variants={popIn}
        className="w-[420px] max-w-[calc(100vw-2rem)] rounded-2xl border border-stroke bg-surface p-8 text-center shadow-2xl"
      >
        <div className="mb-5 flex justify-center">
          <div className="flex size-12 items-center justify-center rounded-[15px] bg-accent/10 text-accent">
            <ShieldAlert className="size-6" />
          </div>
        </div>
        <h1 className="text-lg font-semibold text-fg">{t("desktop:updates.critical.title")}</h1>
        <p className="mx-auto mt-2 max-w-[340px] text-sm leading-relaxed text-fg-muted">
          {t("desktop:updates.critical.body")}
        </p>

        {isReady ? (
          <div className="mt-6 flex items-center justify-center gap-2.5 text-sm text-fg">
            <RotateCcw className="size-4 animate-spin" />
            {t("desktop:updates.critical.restarting")}
          </div>
        ) : (
          <>
            <div className="mt-6 flex items-center justify-center gap-2.5 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" />
              {percent === undefined
                ? t("desktop:updates.critical.preparing")
                : t("desktop:updates.critical.downloading", { percent })}
            </div>
            <ProgressBar percent={percent ?? 0} />
          </>
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
export function GlobalUpdateBanner(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  if (
    status.kind !== "available" &&
    status.kind !== "downloading" &&
    status.kind !== "ready"
  ) {
    return null;
  }
  if (status.critical) {
    return null; // CriticalUpdateOverlay owns mandatory updates.
  }
  if (dismissedVersion === status.version) {
    return null;
  }

  return createPortal(
    <m.div
      role="status"
      variants={toastPop}
      initial="initial"
      animate="animate"
      className="fixed bottom-4 right-4 z-[90] w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-stroke bg-surface p-4 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-accent/10 text-accent">
          <Download className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">
            {status.kind === "ready"
              ? t("desktop:updates.banner.ready", { version: status.version })
              : t("desktop:updates.banner.available", { version: status.version })}
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {status.kind === "downloading"
              ? t("desktop:updates.banner.downloading", { percent: status.percent })
              : status.kind === "ready"
                ? t("desktop:updates.banner.readyHint")
                : t("desktop:updates.banner.availableHint")}
          </p>
          {status.kind === "downloading" && (
            <ProgressBar percent={status.percent} />
          )}
          {status.kind !== "downloading" && (
            <div className="mt-3">
              <Button size="sm" onClick={downloadOrInstall}>
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
        <button
          type="button"
          aria-label={t("desktop:updates.banner.dismiss")}
          onClick={() => setDismissedVersion(status.version)}
          className="shrink-0 cursor-pointer rounded-md p-1 text-fg-faint transition-colors hover:bg-raised hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
    </m.div>,
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
