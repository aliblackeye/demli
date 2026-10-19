import type { LucideIcon } from "lucide-react";
import { Apple, ArrowUpRight, Monitor, Smartphone, Terminal } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@demli/ui";
import {
  openDownloadUrl,
  visibleDownloadTargets,
  type DownloadPlatformId,
  type DownloadTarget,
} from "../lib/download-links";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { useUiStore } from "../stores/ui-store";

/**
 * "Get Demli on your devices" — opened from the rail's download button.
 *
 * Two sections: desktop first, then "or on the go". Every row is backed by a
 * real artifact or is visibly, non-clickably "soon". Platforms we have no build
 * and no plan for (Linux, iOS) are not listed at all — a "soon" badge is a promise, and we only make the ones we
 * have started. The availability matrix + URLs live in lib/download-links.ts
 * (single source, env-overridable); this file only paints them.
 *
 * Responsive on purpose: the web build shares this component and is opened from
 * phones, so the platform cards are a one-column stack that becomes two columns
 * from the `sm` breakpoint up.
 */

const PLATFORM_ICON: Record<DownloadPlatformId, LucideIcon> = {
  windows: Monitor,
  macos: Apple,
  linux: Terminal,
  android: Smartphone,
  ios: Apple,
};

/**
 * Platform name + the one-line "what you actually get" note under it.
 * Spelled out per platform rather than built from a template string so every
 * key is statically checked against the catalog (no cast, no silent miss).
 */
function platformCopy(id: DownloadPlatformId, t: AppTFunction): { name: string; hint: string } {
  switch (id) {
    case "windows":
      return {
        name: t("desktop:downloadApp.platform.windows"),
        hint: t("desktop:downloadApp.hint.windows"),
      };
    case "macos":
      return {
        name: t("desktop:downloadApp.platform.macos"),
        hint: t("desktop:downloadApp.hint.macos"),
      };
    case "linux":
      return {
        name: t("desktop:downloadApp.platform.linux"),
        hint: t("desktop:downloadApp.hint.linux"),
      };
    case "android":
      return {
        name: t("desktop:downloadApp.platform.android"),
        hint: t("desktop:downloadApp.hint.android"),
      };
    case "ios":
      return {
        name: t("desktop:downloadApp.platform.ios"),
        hint: t("desktop:downloadApp.hint.ios"),
      };
  }
}

function PlatformCard({ target }: { target: DownloadTarget }): JSX.Element {
  const { t } = useAppTranslation();
  const Icon = PLATFORM_ICON[target.id];
  const available = target.availability === "available";
  const { name, hint } = platformCopy(target.id, t);

  return (
    <div
      className={cn(
        // `min-w-0` is load-bearing, not decoration: this card is a GRID item,
        // and a grid item's automatic minimum size is its min-content width —
        // which the nowrap platform hint inflates to ~383px. Without it the row
        // refuses to shrink and punches ~30px out of the dialog on a 375px
        // phone (the inner `truncate` never gets a chance to run).
        "flex min-w-0 items-center gap-3 rounded-xl bg-surface p-3",
        "transition-colors motion-hover",
        available ? "hover:bg-raised" : "opacity-70",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          available ? "bg-accent-surface text-accent" : "bg-wash text-fg-faint",
        )}
      >
        <Icon className="size-5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-fg">{name}</span>
          {!available && (
            <span className="shrink-0 rounded-pill bg-wash-strong px-2 py-0.5 text-badge font-semibold text-fg-muted">
              {t("desktop:downloadApp.soon")}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-2xs text-fg-muted">{hint}</p>
      </div>

      {available ? (
        <Button
          size="sm"
          variant="accent"
          className="shrink-0"
          aria-label={t("desktop:downloadApp.downloadFor", { platform: name })}
          onClick={() => openDownloadUrl(target.url as string)}
        >
          {t("desktop:downloadApp.download")}
          <ArrowUpRight className="size-3.5" />
        </Button>
      ) : (
        <Button size="sm" variant="secondary" disabled className="shrink-0">
          {t("desktop:downloadApp.soon")}
        </Button>
      )}
    </div>
  );
}

function Section({
  title,
  targets,
}: {
  title: string;
  targets: DownloadTarget[];
}): JSX.Element | null {
  if (targets.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-label font-medium text-fg-faint">{title}</h3>
      {/* One column on a phone-width viewport, two from `sm` up (§7 responsive).
          A lone row stays full width rather than sitting in a half-empty grid. */}
      <div className={cn("grid gap-2", targets.length > 1 && "sm:grid-cols-2")}>
        {targets.map((target) => (
          <PlatformCard key={target.id} target={target} />
        ))}
      </div>
    </section>
  );
}

/** Platform download dialog (rail → download button). */
export function DownloadAppDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.downloadDialogOpen);
  const setOpen = useUiStore((s) => s.setDownloadDialogOpen);

  const desktopTargets = visibleDownloadTargets("desktop");
  const mobileTargets = visibleDownloadTargets("mobile");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("desktop:downloadApp.title")}</DialogTitle>
          <DialogDescription>{t("desktop:downloadApp.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <Section title={t("desktop:downloadApp.desktopSection")} targets={desktopTargets} />
          <Section title={t("desktop:downloadApp.mobileSection")} targets={mobileTargets} />

          {/* Says out loud what the list omits, so a Linux/iOS user gets an
              answer instead of wondering whether we forgot them (§35). */}
          <p className="text-2xs leading-relaxed text-fg-faint">
            {t("desktop:downloadApp.footnote")}
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
