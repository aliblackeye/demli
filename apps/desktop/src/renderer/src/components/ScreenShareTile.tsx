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
  type RefObject,
} from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Slider, badgeVariants, cn } from "@demli/ui";
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
import { LivePill } from "./CallControls";
import { TileFocusRing } from "./AvatarTile";

export interface ScreenShareTileProps {
  share: RemoteScreenShare;
  /** Display name of the person sharing — shown in the persistent corner label. */
  sharerName: string;
  className?: string;
  /** When provided the tile becomes clickable (promote to / exit the stage). */
  onSelect?: () => void;
  /**
   * Show the per-share FILM-audio volume slider (task #82). On for the large
   * watching stage; off for tiny filmstrip tiles where it would just crowd.
   */
  showVolume?: boolean;
}

/** 5% slider increments up to 100% — matches the per-user volume menu. */
const VOLUME_STEP = 0.05;

/**
 * The resolution the viewer is ACTUALLY receiving, read from the decoded frames
 * (`videoHeight`), never from what the sharer asked for: with adaptiveStream and
 * simulcast the SFU can hand a small tile a lower layer, and the pill must not
 * claim a 1080p the viewer is not getting. Updates on the element's `resize`
 * event (fired when the decoded size changes, e.g. a layer switch) — no timer.
 * Null until the first frame, so nothing is shown before it is known.
 */
export function useReceivedVideoHeight(
  videoRef: RefObject<HTMLVideoElement | null>,
  key: unknown,
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const read = (): void => setHeight(el.videoHeight > 0 ? el.videoHeight : null);
    read();
    el.addEventListener("resize", read);
    el.addEventListener("loadedmetadata", read);
    return () => {
      el.removeEventListener("resize", read);
      el.removeEventListener("loadedmetadata", read);
    };
  }, [videoRef, key]);
  return height;
}

/** The top-left "CANLI · 1080p" pair shared by the remote and local share tiles. */
export function ShareLiveBadges({
  height,
  showQuality,
}: {
  height: number | null;
  showQuality: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <span className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5">
      <LivePill label={t("desktop:stage.live")} />
      {showQuality && height !== null && (
        <span
          data-testid="share-quality"
          className={cn(
            badgeVariants({ variant: "veil" }),
            "bg-scrim px-1.5 py-px text-badge font-semibold leading-4 tabular-nums text-fg-display",
          )}
        >
          {`${height}p`}
        </span>
      )}
    </span>
  );
}

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

  const commit = (next: number): void => {
    setValue(next);
    setScreenShareVolume(userId, next);
  };
  const silent = value <= MIN_PARTICIPANT_VOLUME + 1e-6 || deafened;

  return (
    <div
      // Sit above the tile's own click target so adjusting audio never promotes /
      // exits the stage; and don't fade the control mid-drag.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={() => (draggingRef.current = true)}
      onPointerUp={() => (draggingRef.current = false)}
      onPointerCancel={() => (draggingRef.current = false)}
      data-testid="share-volume"
      className={cn(
        // Koyu Masa floating chip over the film: strong glass, pill, no border.
        "absolute right-3 top-3 z-10 flex w-52 items-center gap-2 rounded-pill surface-glass-strong py-1 pl-3 pr-1.5",
        "transition-opacity motion-fast",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        // Keyboard: focusing the slider of a faded chip shows it.
        "focus-within:pointer-events-auto focus-within:opacity-100",
      )}
    >
      {silent ? (
        <VolumeX className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
      ) : (
        <Volume2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
      )}
      <Slider
        className="flex-1 gap-2"
        min={MIN_PARTICIPANT_VOLUME}
        max={ELEMENT_PLAYBACK_MAX_VOLUME}
        step={VOLUME_STEP}
        value={value}
        disabled={deafened}
        onValueChange={commit}
        formatValue={(v) => `${Math.round(v * 100)}%`}
        showValue
        aria-label={t("desktop:voice.shareVolumeFor", { name })}
      />
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
  showVolume = false,
}: ScreenShareTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  // Auto-hide drives the film-audio volume control only (a slider should not be a
  // permanent fixture on the stream): greet briefly, fade, return on hover. The
  // sharer's NAME is a separate, PERSISTENT corner label (founder #3), matching
  // the camera tiles' identity chip.
  const { visible: controlsVisible, handlers: autoHide } = useAutoHideOverlay();
  const receivedHeight = useReceivedVideoHeight(videoRef, share);

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
      data-testid="screen-share-tile"
      className={cn(
        "group/tile relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-rail",
        // Focus is drawn by <TileFocusRing> (an inset overlay above the video),
        // not by a ring on this box: the <video> would paint over it.
        interactive && "cursor-pointer outline-none",
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
      {interactive && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-wash opacity-0 transition-opacity motion-hover group-hover/tile:opacity-100"
        />
      )}
      <ShareLiveBadges height={receivedHeight} showQuality={showVolume} />
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
      {/* Keyboard focus mark — above the <video>, which would cover a ring on
          the tile box. */}
      {interactive && <TileFocusRing />}
    </div>
  );
});
