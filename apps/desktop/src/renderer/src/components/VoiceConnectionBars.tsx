import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import type { ConnectionQualityLevel } from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";

/**
 * Ping / connection-quality indicator (task #55) — three signal bars in the
 * connected voice panel. The bar COUNT + colour come from the coarse quality
 * level (livekit's server-computed `ConnectionQuality`, folding loss/jitter/RTT);
 * the exact round-trip time shows in the tooltip on hover/focus/click.
 *
 * excellent → 3 bars green · good → 2 bars amber · poor → 1 bar red.
 * Colours are theme tokens (online/idle/danger). Rendered only while connected —
 * the engine reports `unknown` otherwise, so quality is meaningless off-call.
 */
const LEVEL_META = {
  excellent: { bars: 3, barClass: "bg-online", labelKey: "desktop:voice.qualityExcellent" },
  good: { bars: 2, barClass: "bg-idle", labelKey: "desktop:voice.qualityGood" },
  poor: { bars: 1, barClass: "bg-danger", labelKey: "desktop:voice.qualityPoor" },
  unknown: { bars: 0, barClass: "bg-fg-faint", labelKey: "desktop:voice.qualityMeasuring" },
} as const satisfies Record<
  ConnectionQualityLevel,
  { bars: number; barClass: string; labelKey: string }
>;

/** Ascending bar heights (short → tall), left to right. */
const BAR_HEIGHTS = ["h-1.5", "h-2.5", "h-3.5"] as const;

export function VoiceConnectionBars(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useVoiceStore((s) => s.status);
  const quality = useVoiceStore((s) => s.connectionQuality);

  // Quality is only meaningful in a live room; the engine reports unknown for
  // every other status, and the panel hides the indicator entirely off-call.
  if (status !== "connected") return null;

  const meta = LEVEL_META[quality.level];
  // Tooltip: the precise ping when we have it, otherwise the level name
  // (e.g. before the first RTT sample, or "Measuring…" while unknown).
  const label =
    quality.rttMs !== null ? t("desktop:voice.pingMs", { ms: quality.rttMs }) : t(meta.labelKey);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${t("desktop:voice.connectionQuality")}: ${label}`}
          className="flex items-end gap-0.5 rounded p-1 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {BAR_HEIGHTS.map((h, i) => (
            <span
              key={h}
              className={cn(
                "w-1 rounded-sm transition-colors",
                h,
                i < meta.bars ? meta.barClass : "bg-fg-faint/30",
              )}
            />
          ))}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
