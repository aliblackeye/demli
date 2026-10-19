import { useState } from "react";
import { Download, Monitor, Smartphone, X } from "lucide-react";
import { cn } from "@demli/ui";
import { floatingPillClass, floatingPillItemClass } from "@demli/app-ui";
import { detectDevicePlatform } from "../lib/device-platform";
import { downloadTarget, openDownloadUrl } from "../lib/download-links";
import { useAppTranslation } from "../lib/i18n";
import { isWebSurface } from "../lib/surface";

/**
 * WEB-ONLY "get the native app" affordance.
 *
 * The web build IS the desktop renderer mounted in a browser (apps/web). On that
 * surface a browser visitor benefits from installing the real app; on the actual
 * Electron desktop app and the native mobile app there is nothing to download, so
 * this renders NOTHING there (no dead space). Two things gate it:
 *
 *   1. Surface: only on the browser build — `isWebSurface()` (lib/surface.ts),
 *      i.e. the bridge's platform is "web". Electron reports "win32"/"darwin"/…
 *      and never matches.
 *   2. OS: the UA decides which real build to offer. Only Windows (desktop
 *      installer) and Android (APK) have a build that can actually run — iOS has
 *      no App Store build and macOS/Linux have no installer yet, so both resolve
 *      to "no render". We never surface a download that cannot run (CLAUDE.md §35).
 *
 * Placement is driven by the `variant`:
 *   - "footer"   — a slim inline line for the sign-in screen (pre-login).
 *   - "floating" — a compact, dismissible corner pill for the app shell
 *                  (post-login). Dismissal persists in localStorage.
 */

/**
 * Link resolution lives in lib/download-links.ts — the SINGLE source shared with
 * the rail's DownloadAppDialog, so the two surfaces can never point at different
 * builds. OS detection lives in lib/device-platform.ts — the SINGLE source shared
 * with the rail's download affordance (lib/download-surface.ts), so this pill and
 * that button can never disagree about what the visitor is holding. This file
 * only decides WHETHER to render and for which OS.
 */

const DISMISS_KEY = "demli.downloadPrompt.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode / storage disabled — a non-persisted dismiss is fine. */
  }
}

interface DownloadPromptProps {
  /** "footer" (sign-in screen) or "floating" (dismissible app-shell pill). */
  variant: "footer" | "floating";
}

/** Platform-aware download entry point — see file header. Renders null off-web,
 *  on iOS, and on unsupported desktops. */
export function DownloadPrompt({ variant }: DownloadPromptProps): JSX.Element | null {
  const { t } = useAppTranslation();
  // Only the floating (post-login) pill is dismissible; the footer line is a
  // static part of the login screen.
  const [dismissed, setDismissed] = useState(
    () => variant === "floating" && readDismissed(),
  );

  if (!isWebSurface()) return null;
  // Only Windows and Android map to a real, runnable build; iOS and any other
  // desktop (macOS/Linux) have nothing to offer, so the pill does not render.
  const target = detectDevicePlatform();
  if (target === "ios" || target === "other") return null;
  if (dismissed) return null;

  const isDesktop = target === "windows";
  // Belt-and-braces against the shared availability matrix: if a platform ever
  // loses its link, this pill disappears instead of becoming a dead control.
  const link = downloadTarget(isDesktop ? "windows" : "android");
  if (link.availability !== "available" || link.url === null) return null;

  const href = link.url;
  const label = isDesktop
    ? t("desktop:download.desktopCta")
    : t("desktop:download.androidCta");
  const Icon = isDesktop ? Monitor : Smartphone;

  if (variant === "footer") {
    return (
      <div className="mt-3 flex items-center justify-center">
        {/* New tab, not `download`: the link is now a redirect (getdemli.com →
            the current artifact), and `download` is ignored cross-origin — a
            same-tab navigation would risk yanking the user out of the app.

            The `target="_blank"` is markup only. Every click is intercepted and
            routed through `openDownloadUrl` → the shared `openExternalUrl` seam,
            because on desktop a real `window.open` is denied outright by
            `setWindowOpenHandler`. The href stays for hover/copy-link and
            keyboard semantics; this component renders on the WEB surface only
            (see the `isWebSurface()` guard above), where the browser's own
            middle-click / ctrl-click paths are correct anyway. */}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            openDownloadUrl(href);
          }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-label font-medium text-fg-muted",
            "transition-colors motion-hover hover:bg-wash hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          <Download aria-hidden className="size-3.5" />
          {label}
        </a>
      </div>
    );
  }

  // Floating, dismissible corner pill (post-login). The fixed bottom-left
  // placement lives on the AppShell stack that mounts it (alongside the age
  // reminder), so the two pills stack instead of covering each other; this
  // component only renders the pill itself.
  const dismiss = (): void => {
    persistDismissed();
    setDismissed(true);
  };

  return (
    <div className={floatingPillClass}>
      {/* Same contract as the footer anchor above: markup href, click routed
          through `openDownloadUrl` → `openExternalUrl`, web-surface only. */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          openDownloadUrl(href);
        }}
        className={floatingPillItemClass}
      >
        <Icon aria-hidden className="size-4 text-accent" />
        {label}
      </a>
      <button
        type="button"
        aria-label={t("desktop:download.dismiss")}
        onClick={dismiss}
        title={t("desktop:download.dismiss")}
        className={cn(floatingPillItemClass, "p-1.5 text-fg-faint hover:text-fg")}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
