/**
 * The bottom-left identity chip shared by every video-stage tile (camera tile,
 * local self-preview, cameraless avatar tile) so a person is labelled the same
 * way everywhere: name + a muted / screen-sharing indicator. Kept tiny and
 * presentational — the tiles own the video/avatar, this only draws the chip.
 */

import { HeadphoneOff, MicOff, MonitorUp } from "lucide-react";
import { cn } from "@demli/ui";
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
      className={cn(
        "pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5",
        // Warm "cam glass" pill (Demli Voice v2): translucent near-black warm base
        // + cream hairline + inset top highlight, so a tile's identity chip reads as
        // frosted glass over both video and the gradient avatar. Text stays white for
        // legibility over arbitrary camera video.
        "rounded-lg border border-stroke bg-[rgba(16,6,3,0.55)] px-2 py-1 text-2xs font-medium text-white backdrop-blur",
        // Shared frosted-rim edge (glass-edge): 1px top highlight + faint inner
        // ring — the single-source "true glassmorphism" treatment (was an inline
        // inset shadow here).
        "glass-edge",
        className,
      )}
    >
      {muted && (
        <MicOff
          aria-label={t("desktop:voice.mutedIndicator")}
          className="size-3 shrink-0 text-danger"
        />
      )}
      {deafened && (
        <HeadphoneOff
          aria-label={t("desktop:voice.deafenedIndicator")}
          className="size-3 shrink-0 text-danger"
        />
      )}
      {screenSharing && (
        <MonitorUp
          aria-label={t("desktop:voice.sharingIndicator")}
          className="size-3 shrink-0 text-online"
        />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
