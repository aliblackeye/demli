import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
} from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { isDesktopSurface } from "../lib/surface";
import {
  checkForUpdates,
  downloadOrInstall,
  useUpdateStatus,
  type UpdateStatus,
} from "../lib/update-status";

/**
 * Top-right app-update badge (founder request, desktop only).
 *
 * A green download glyph that EXISTS ONLY while there is something to do —
 * there is no idle/disabled state and no dead control (CLAUDE.md §35). It sits in
 * the surface header's right-hand action group (channel / DM / group chat /
 * friends / calls), so it is genuinely "top right" without floating over the
 * controls that already live there.
 *
 * State machine (mirrors main's UpdateStatus; see main/auto-update.ts):
 *
 *   nothing        no update, or a MANDATORY one   -> renders null
 *                  (mandatory is owned by the blocking CriticalUpdateOverlay)
 *   available      new version on the feed          -> green download glyph;
 *                                                      click starts the download
 *   downloading    real `download-progress` percent -> pill with live %
 *   ready          package downloaded               -> solid green restart glyph;
 *                                                      panel offers "Yeniden başlat"
 *   error          only after the user engaged      -> danger glyph; click retries
 *
 * The hover panel is NOT hover-only: it also opens on click and on keyboard
 * focus, and the restart button inside it is reachable by Tab. Hover merely
 * previews it.
 *
 * If the user never presses "Yeniden başlat", nothing is lost — main installs the
 * downloaded package on quit (`autoInstallOnAppQuit`) and, if the app never got
 * to quit cleanly, resumes it silently on the next launch (pending-update.ts).
 */

/** The states that put the badge on screen at all. */
type VisibleKind = "available" | "downloading" | "ready" | "error" | "checking";

function visibleKind(status: UpdateStatus, engaged: boolean): VisibleKind | null {
  switch (status.kind) {
    case "available":
    case "downloading":
    case "ready":
      // Mandatory updates are driven by main and shown by the blocking overlay;
      // a second, dismissible-looking control for them would be a lie.
      return status.critical ? null : status.kind;
    case "error":
      // Only after the user actually asked for something. An unattended failed
      // background check must not decorate the header with a red glyph.
      return engaged ? "error" : null;
    case "checking":
      // Same rule, and it also stops the badge blinking out of the header for a
      // second when the user retries after a failure.
      return engaged ? "checking" : null;
    default:
      return null;
  }
}

export function UpdateBadge(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useUpdateStatus();
  // Set once the user acts on the badge, so a failure that follows their click
  // is reported instead of silently vanishing.
  const [engaged, setEngaged] = useState(false);
  const [open, setOpen] = useState(false);
  /** True while the panel is held open by a click (hover-out must not close it). */
  const pinned = useRef(false);
  /** True when the panel was opened by hover, so it must not steal focus. */
  const byHover = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => cancelClose, [cancelClose]);

  /**
   * Move focus into the panel. Needed when a click/Enter lands while the panel
   * is ALREADY open as a hover/focus preview: Radix only runs its own focus
   * management on an open transition, and without this a keyboard user could
   * never reach the "Yeniden başlat" button (the panel is portaled to the end of
   * the body, so Tab from the badge goes to the next header control instead).
   */
  const focusPanel = useCallback(() => {
    requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>("button");
      (target ?? contentRef.current)?.focus();
    });
  }, []);

  const openByHover = useCallback(() => {
    cancelClose();
    if (!open) {
      byHover.current = true;
    }
    setOpen(true);
  }, [cancelClose, open]);

  // Small grace period so the pointer can travel from the badge to the panel
  // (they are separate elements — the panel is portaled) without it closing.
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!pinned.current) {
        setOpen(false);
      }
    }, 140);
  }, [cancelClose]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Radix closes on Escape / outside interaction; drop the pin with it.
      if (!next) {
        pinned.current = false;
        cancelClose();
      }
      setOpen(next);
    },
    [cancelClose],
  );

  const kind = visibleKind(status, engaged);
  if (!isDesktopSurface() || kind === null) {
    return null;
  }

  const version =
    status.kind === "available" || status.kind === "downloading" || status.kind === "ready"
      ? status.version
      : "";
  const percent = status.kind === "downloading" ? status.percent : 0;

  const label =
    kind === "available"
      ? t("desktop:updates.badge.availableAction", { version })
      : kind === "downloading"
        ? t("desktop:updates.badge.downloading", { percent })
        : kind === "ready"
          ? t("desktop:updates.badge.downloaded")
          : kind === "checking"
            ? t("desktop:updates.checking")
            : t("desktop:updates.badge.failed");

  function onBadgeClick(): void {
    if (kind === "available") {
      // "basınca otomatik indirsin" — one click starts the real download; the
      // percent below comes from main's download-progress events, never a guess.
      setEngaged(true);
      cancelClose();
      // Show the progress panel without pinning it: the pointer is on the badge
      // anyway, and moving away should dismiss it rather than leave a sticky card.
      pinned.current = false;
      byHover.current = true;
      setOpen(true);
      downloadOrInstall();
      return;
    }
    if (kind === "error") {
      setEngaged(true);
      checkForUpdates();
      return;
    }
    if (kind === "checking") {
      return; // in flight — nothing to do but wait
    }
    // downloading / ready: the badge only toggles the panel. Restarting is a
    // deliberate second action inside it, never a stray click on the header.
    if (open && !pinned.current) {
      // The panel is up as a hover/focus PREVIEW. A click (or Enter from the
      // keyboard, which is preceded by focus and therefore by a preview) must
      // commit it — closing here would make the badge unusable by keyboard.
      cancelClose();
      pinned.current = true;
      byHover.current = false;
      focusPanel();
      return;
    }
    const next = !open;
    pinned.current = next;
    byHover.current = false;
    setOpen(next);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={onBadgeClick}
          onMouseEnter={openByHover}
          onMouseLeave={scheduleClose}
          onFocus={openByHover}
          onBlur={scheduleClose}
          className={cn(
            "flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full",
            "transition-colors motion-instant",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            kind === "downloading" ? "gap-1.5 px-2.5" : "w-8",
            kind === "error"
              ? "bg-danger-surface text-danger hover:bg-danger/25"
              : kind === "checking"
                ? "bg-raised text-fg-muted"
                : kind === "ready"
                  ? "bg-online text-app hover:bg-online/90"
                  : "bg-online/15 text-online ring-1 ring-inset ring-online/30 hover:bg-online/25",
          )}
        >
          {kind === "available" && <Download className="size-4" />}
          {kind === "checking" && <Loader2 className="size-4 animate-spin" />}
          {kind === "downloading" && (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-2xs font-semibold tabular-nums">{percent}%</span>
            </>
          )}
          {kind === "ready" && <RotateCcw className="size-4" />}
          {kind === "error" && <TriangleAlert className="size-4" />}
        </button>
      </PopoverAnchor>

      <PopoverContent
        ref={contentRef}
        align="end"
        sideOffset={10}
        tabIndex={-1}
        // Hover-opened panels must not yank focus away from whatever the user is
        // doing; click/keyboard-opened ones should land on the action inside.
        onOpenAutoFocus={(event) => {
          if (byHover.current) event.preventDefault();
        }}
        onMouseEnter={openByHover}
        onMouseLeave={scheduleClose}
        className="w-64 p-3"
      >
        {kind === "available" && (
          <>
            <p className="text-sm font-semibold text-fg">
              {t("desktop:updates.badge.available", { version })}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {t("desktop:updates.badge.availableHint")}
            </p>
          </>
        )}

        {kind === "checking" && (
          <p className="text-sm font-semibold text-fg">{t("desktop:updates.checking")}</p>
        )}

        {kind === "downloading" && (
          <>
            <p className="text-sm font-semibold text-fg">
              {t("desktop:updates.badge.downloading", { percent })}
            </p>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-online transition-[width] motion-fast"
                style={{ width: `${percent}%` }}
              />
            </div>
          </>
        )}

        {kind === "ready" && (
          <>
            <p className="text-sm font-semibold text-fg">
              {t("desktop:updates.badge.downloaded")}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {t("desktop:updates.badge.downloadedHint", { version })}
            </p>
            <Button
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                setEngaged(true);
                downloadOrInstall();
              }}
            >
              <RotateCcw className="size-4" />
              {t("desktop:updates.restart")}
            </Button>
          </>
        )}

        {kind === "error" && (
          <>
            <p className="text-sm font-semibold text-fg">
              {t("desktop:updates.badge.failed")}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {t("desktop:updates.errors.download")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                setEngaged(true);
                checkForUpdates();
              }}
            >
              {t("desktop:updates.badge.retry")}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
