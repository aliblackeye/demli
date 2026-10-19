/**
 * The bottom-left identity chip shared by every video-stage tile (camera tile,
 * local self-preview, cameraless avatar tile) so a person is labelled the same
 * way everywhere: name + a muted / screen-sharing indicator. Kept tiny and
 * presentational — the tiles own the video/avatar, this only draws the chip.
 *
 * Koyu Masa media pill: the design system's `veil` badge (pill radius, backdrop
 * blur, the inset signature line) — darkened to the scrim tone, because this
 * chip sits on ARBITRARY camera video and the name has to stay readable over a
 * bright frame, where the plain 24% veil would let a white wall wash it out.
 */

import { HeadphoneOff, MicOff, MonitorUp } from "lucide-react";
import { badgeVariants, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

export interface VideoTileLabelProps {
  name: string;
  /** Show the muted mic glyph (participant.micEnabled === false). */
  muted?: boolean;
  /**
   * Show the deafened (headphone-off) glyph, next to the mic-mute one, so a
   * peer's deafen is visible on the video stage / DM-call tiles too,
   * not only in the VoiceParticipant list (founder: "başkalarının deafen'i
   * görünmüyor"). A deafened user is always mic-muted, so both glyphs show.
   */
  deafened?: boolean;
  /** Show the screen-sharing glyph. */
  screenSharing?: boolean;
  className?: string;
}

export function VideoTileLabel({
  name,
  muted = false,
  deafened = false,
  screenSharing = false,
  className,
}: VideoTileLabelProps): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <span
      data-testid="tile-label"
      className={cn(
        badgeVariants({ variant: "veil" }),
        "pointer-events-none absolute bottom-2 left-2 z-10 max-w-[calc(100%-1rem)] gap-1.5",
        "bg-scrim px-2.5 py-1 text-2xs text-fg-display",
        className,
      )}
    >
      {muted && (
        <MicOff
          role="img"
          aria-label={t("desktop:voice.mutedIndicator")}
          className="size-3 shrink-0 text-danger"
        />
      )}
      {deafened && (
        <HeadphoneOff
          role="img"
          aria-label={t("desktop:voice.deafenedIndicator")}
          className="size-3 shrink-0 text-danger"
        />
      )}
      {screenSharing && (
        <MonitorUp
          role="img"
          aria-label={t("desktop:voice.sharingIndicator")}
          className="size-3 shrink-0 text-accent"
        />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
