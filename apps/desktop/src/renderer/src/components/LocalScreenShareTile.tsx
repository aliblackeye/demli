/**
 * Renders the LOCAL screen-share self-preview (task #72) — the sharer watching
 * their OWN broadcast on the video stage, opt-in.
 *
 * Unlike ScreenShareTile (a remote LiveKit track attached via `track.attach`),
 * this receives a RAW capture `MediaStreamTrack` (the same one handed to the
 * engine to publish), so it mounts it the plain-DOM way: `srcObject` wrapping the
 * track in a one-off MediaStream. The element is always `muted` — the preview is
 * video-only (we only ever tee the video track), and the sharer already hears the
 * film's sound natively, so nothing here could echo.
 *
 * Memoized on the track ref: the parent keeps that ref stable for the life of the
 * share, so an unrelated voice-state change never re-creates or re-binds the
 * <video> (CLAUDE.md §27).
 */

import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@demli/ui";
import { startLocalPreviewPlayback } from "../lib/video-playback";
import { VideoTileLabel } from "./VideoTileLabel";

export interface LocalScreenShareTileProps {
  /** The raw local screen-capture video track (same one published to LiveKit). */
  track: MediaStreamTrack;
  label: string;
  className?: string;
  /** When provided the tile becomes clickable (promote to / exit the stage). */
  onSelect?: () => void;
  /** Highlight this tile as the current stage item (accent ring). */
  active?: boolean;
}

export const LocalScreenShareTile = memo(function LocalScreenShareTile({
  track,
  label,
  className,
  onSelect,
  active = false,
}: LocalScreenShareTileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const stream = new MediaStream([track]);
    el.srcObject = stream;
    // Explicitly START playback: the `autoPlay` attribute alone does not reliably
    // start a srcObject assigned after mount in a browser (esp. Safari 12), so the
    // sharer saw a BLACK self-preview on web while desktop worked (Electron
    // autoplays unconditionally). See lib/video-playback.
    startLocalPreviewPlayback(el);
    return () => {
      // Detach only — the engine owns stopping the track (unpublish/leave).
      el.srcObject = null;
    };
  }, [track]);

  const interactive = Boolean(onSelect);

  return (
    <div
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": label,
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
        interactive &&
          "cursor-pointer outline-none transition hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent",
        active && "border-accent ring-2 ring-accent",
        className,
      )}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      {/* Persistent identity chip — same component + bottom-left placement as the
          camera tiles and the remote screen tile (founder #3): "Your broadcast",
          always visible so you can tell your own preview at a glance. */}
      <VideoTileLabel name={label} screenSharing />
    </div>
  );
});
