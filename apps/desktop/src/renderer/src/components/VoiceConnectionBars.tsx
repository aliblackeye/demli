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
 * excellent → 3 bars green · good → 2 bars amber · poor → 1 bar pink. Green
 * is a STATUS colour in Koyu Masa (never the brand), which is exactly what this
 * is. A level change slides the colour across the bars in the hover step, so a
 * degrading link is noticed as a change rather than a blink. Rendered only while
 * connected — the engine reports `unknown` otherwise.
 */
const LEVEL_META = {
  excellent: { bars: 3, barClass: "bg-online", labelKey: "desktop:voice.qualityExcellent" },
  good: { bars: 2, barClass: "bg-warning", labelKey: "desktop:voice.qualityGood" },
  poor: { bars: 1, barClass: "bg-danger", labelKey: "desktop:voice.qualityPoor" },
  unknown: { bars: 0, barClass: "bg-fg-subtle", labelKey: "desktop:voice.qualityMeasuring" },
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
          data-testid="voice-quality"
          data-level={quality.level}
          aria-label={`${t("desktop:voice.connectionQuality")}: ${label}`}
          className={cn(
            "flex h-8 items-end gap-[3px] rounded-md px-1.5 pb-[9px]",
            "transition-colors motion-hover hover:bg-wash active:bg-wash-strong",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          )}
        >
          {BAR_HEIGHTS.map((h, i) => (
            <span
              key={h}
              aria-hidden
              className={cn(
                "w-[3px] rounded-full transition-colors motion-hover",
                h,
                i < meta.bars ? meta.barClass : "bg-fg-subtle/40",
              )}
              // Stagger the colour change bar-by-bar so a level change reads as
              // a sweep, not a flash.
              style={{ transitionDelay: `${i * 40}ms` }}
            />
          ))}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
