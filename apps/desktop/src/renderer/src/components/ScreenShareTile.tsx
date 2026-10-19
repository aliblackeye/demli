/**
 * Renders one remote screen-share VIDEO track in a <video>. The track is
 * attached via livekit's `track.attach(el)` (NOT a raw srcObject): the room
 * uses adaptiveStream, so livekit needs the bound element to pick a simulcast
 * layer — a manually-set srcObject may never start (see packages/media).
 *
 * Screen-share AUDIO (the film's sound) is a separate track livekit auto-plays
 * through its managed remote-audio path — same as voice — so it is not attached
 * here.
 */

import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Volume2, VolumeX } from "lucide-react";
import { cn } from "@demli/ui";
import {
  DEFAULT_PARTICIPANT_VOLUME,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  MIN_PARTICIPANT_VOLUME,
  type RemoteScreenShare,
} from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { useScreenShareVolumes } from "../stores/screen-share-volume-store";
import { useAutoHideOverlay } from "../hooks/useAutoHideOverlay";
import { VideoTileLabel } from "./VideoTileLabel";

export interface ScreenShareTileProps {
  share: RemoteScreenShare;
  /** Display name of the person sharing — shown in the persistent corner label. */
  sharerName: string;
  className?: string;
  /** When provided the tile becomes clickable (promote to / exit the stage). */
  onSelect?: () => void;
  /** Highlight this tile as the current stage item (accent ring). */
  active?: boolean;
  /**
   * Show the per-share FILM-audio volume slider (task #82). On for the large
   * watching stage; off for tiny filmstrip tiles where it would just crowd.
   */
  showVolume?: boolean;
}

/** 5% slider increments up to 100% — matches the per-user volume menu. */
const VOLUME_STEP = 0.05;

/**
 * Hover control for the WATCHED share's film-audio volume — SEPARATE from the
 * sharer's voice (task #82). Reads the stored level from the persist store (so a
 * saved level shows even while deafened) and writes through the voice store
 * (engine + persistence). stopPropagation keeps a click/drag from promoting or
 * exiting the stage. Disabled while deafened (deafen is a master mute that wins;
 * the level is what undeafen restores) — mirrors the per-user volume menu.
 */
function ScreenShareVolumeControl({
  userId,
  name,
  visible,
}: {
  userId: string;
  name: string;
  visible: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const stored = useScreenShareVolumes((s) => s.volumes[userId] ?? DEFAULT_PARTICIPANT_VOLUME);
  const setScreenShareVolume = useVoiceStore((s) => s.setScreenShareVolume);
  const deafened = useVoiceStore((s) => s.deafened);
  const [value, setValue] = useState(stored);
  const draggingRef = useRef(false);
  // Follow the store unless the user is actively dragging this slider.
  useEffect(() => {
    if (!draggingRef.current) setValue(stored);
  }, [stored]);

  const percent = Math.round(value * 100);
  const commit = (next: number): void => {
    setValue(next);
    setScreenShareVolume(userId, next);
  };

  return (
    <div
      // Sit above the tile's own click target so adjusting audio never promotes /
      // exits the stage; and don't fade the control mid-drag.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute right-3 top-3 flex items-center gap-2 rounded-md px-2 py-1.5",
        // Frosted control chip over the shared screen: warm-neutral glass with a
        // 1px hairline + inner edge highlight (glass-edge) so it reads as lifted
        // glass rather than a flat black box (redesign-skill "true glassmorphism").
        "border border-white/10 bg-black/60 text-white backdrop-blur transition-opacity motion-fast glass-edge",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {value <= MIN_PARTICIPANT_VOLUME + 1e-6 || deafened ? (
        <VolumeX className="size-3.5 shrink-0 text-white/80" aria-hidden />
      ) : (
        <Volume2 className="size-3.5 shrink-0 text-white/80" aria-hidden />
      )}
      <input
        type="range"
        min={MIN_PARTICIPANT_VOLUME}
        max={ELEMENT_PLAYBACK_MAX_VOLUME}
        step={VOLUME_STEP}
        value={value}
        disabled={deafened}
        aria-label={t("desktop:voice.shareVolumeFor", { name })}
        aria-valuetext={`${percent}%`}
        onPointerDown={() => (draggingRef.current = true)}
        onPointerUp={() => (draggingRef.current = false)}
        onChange={(e) => commit(e.currentTarget.valueAsNumber)}
        className="h-1.5 w-24 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span className="w-8 text-right text-badge font-medium tabular-nums text-white/80">
        {percent}%
      </span>
    </div>
  );
}

/**
 * Memoized on the share/label — the parent keeps the `share` object referentially
 * stable while a share is live, so the <video> element is not re-created or
 * re-attached on unrelated voice-state changes (CLAUDE.md §27).
 */
export const ScreenShareTile = memo(function ScreenShareTile({
  share,
  sharerName,
  className,
  onSelect,
  active = false,
  showVolume = false,
}: ScreenShareTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  // Auto-hide drives the film-audio volume control only (a slider should not be a
  // permanent fixture on the stream): greet briefly, fade, return on hover. The
  // sharer's NAME is a separate, PERSISTENT corner label (founder #3), matching
  // the camera tiles' identity chip.
  const { visible: controlsVisible, handlers: autoHide } = useAutoHideOverlay();

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const { track } = share;
    // §26: never let a track attach/detach throw during commit — a malformed or
    // already-disposed remote track must degrade to a blank tile, not white-screen
    // the whole call surface.
    try {
      track.attach(el);
    } catch (err) {
      console.warn("[media] screen-share track attach failed", err);
    }
    return () => {
      try {
        track.detach(el);
      } catch (err) {
        console.warn("[media] screen-share track detach failed", err);
      }
    };
  }, [share]);

  const interactive = Boolean(onSelect);

  return (
    <div
      {...autoHide}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": t("desktop:screenShare.sharersScreen", { name: sharerName }),
            onClick: onSelect,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.();
              }
            },
          }
        : {})}
      className={cn(
        "relative flex w-full items-center justify-center overflow-hidden",
        "rounded-lg border border-stroke bg-black",
        // Inset rings — this tile also renders inside the scrollable camera panel,
        // which clips on all four sides. See AvatarTile for the full reasoning.
        interactive &&
          "cursor-pointer outline-none transition hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        active && "border-accent ring-2 ring-inset ring-accent",
        className,
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
      />
      {/* Persistent identity chip: WHO is sharing, always visible, same component +
          bottom-left placement as the camera tiles' name label (founder #3). The
          screen glyph marks it as a share at a glance. */}
      <VideoTileLabel name={sharerName} screenSharing />
      {showVolume && (
        <ScreenShareVolumeControl
          userId={share.userId}
          name={sharerName}
          visible={controlsVisible}
        />
      )}
    </div>
  );
});
