/**
 * Renders one REMOTE participant camera VIDEO track in a <video> (task #18).
 * The track is attached via livekit's `track.attach(el)` (NOT a raw srcObject):
 * the room uses adaptiveStream, so livekit needs the bound element to pick a
 * simulcast layer — a manually-set srcObject may never start. This mirrors
 * ScreenShareTile exactly, just a different source (camera vs screen).
 *
 * The video is ALWAYS `object-contain` and never transformed — a camera is shown
 * whole (letterboxed inside its tile), never cropped, stretched, or mirrored
 * (the founder's "squished mirror" bug was object-cover crop + a scale-x flip).
 *
 * Camera video is a separate track from screen share, so a remote can appear in
 * BOTH a camera tile and the screen-share stage at once.
 */

import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { UserAvatar, cn } from "@demli/ui";
import type { RemoteCamera, VoiceParticipant } from "@demli/media";
import { useChatStore } from "../stores/chat-store";
import { VideoTileLabel } from "./VideoTileLabel";
import { ParticipantVolumeMenu } from "./ParticipantVolumeMenu";

export interface CameraTileProps {
  camera: RemoteCamera;
  /**
   * The roster row for this camera's owner, when available. Drives the speaking
   * ring and the muted/screen-sharing glyphs on the label. Passing it (a stable
   * store ref) keeps the memo tight: only the tile whose participant changed
   * re-renders on a speaking tick (CLAUDE.md §27).
   */
  participant?: VoiceParticipant;
  className?: string;
  /**
   * When provided the tile becomes clickable (promote to / exit the stage). The
   * <video> attach is untouched, so click-to-focus never re-subscribes a track.
   */
  onSelect?: () => void;
  /** Highlight this tile as the current stage item (accent ring). */
  active?: boolean;
  /**
   * Show the participant NAME chip. OFF by default (e.g. the PiP overlay stays
   * clean); grid/filmstrip/stage tiles turn it on.
   */
  showName?: boolean;
}

/**
 * Memoized on all props — the engine keeps each RemoteCamera ref and each
 * participant row stable while unchanged, so the <video> is neither re-created
 * nor re-attached on unrelated voice-state / presence ticks (CLAUDE.md §27). The
 * internal name lookup still re-renders cheaply if the owner renames.
 */
export const CameraTile = memo(function CameraTile({
  camera,
  participant,
  className,
  onSelect,
  active = false,
  showName = false,
}: CameraTileProps): JSX.Element {
  const user = useChatStore((s) => s.users[camera.userId]);
  const name = user?.displayName ?? camera.identity;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const { track } = camera;
    // §26: never let a track attach/detach throw during commit — a malformed or
    // already-disposed remote track must degrade to the avatar fallback, not
    // white-screen the whole call surface.
    try {
      track.attach(el);
    } catch (err) {
      console.warn("[media] camera track attach failed", err);
    }
    return () => {
      try {
        track.detach(el);
      } catch (err) {
        console.warn("[media] camera track detach failed", err);
      }
    };
  }, [camera]);

  const interactive = Boolean(onSelect);
  const speaking = participant?.speaking ?? false;

  const tile: ReactElement = (
    <div
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": name,
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
        "group/tile relative flex items-center justify-center overflow-hidden",
        "rounded-lg border border-stroke bg-black",
        // Rings are INSET: these tiles sit in scroll containers (the grid and the
        // camera panel), and a scroll container clips on all four sides, so an
        // outset ring is sheared off the edge tiles. Drawing inside the border box
        // leaves nothing to clip. See AvatarTile for the full reasoning.
        interactive &&
          "cursor-pointer outline-none transition hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        speaking && "border-online ring-2 ring-inset ring-online",
        active && "border-accent ring-2 ring-inset ring-accent",
        className,
      )}
    >
      {/* Avatar sits under the video as a graceful fallback until frames flow. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <UserAvatar
          name={name}
          colorSeed={camera.userId}
          src={user?.avatarUrl ?? null}
          size="lg"
        />
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="relative h-full w-full object-contain"
      />
      {showName && (
        <VideoTileLabel
          name={name}
          muted={participant ? !participant.micEnabled : false}
          deafened={participant?.deafened ?? false}
          screenSharing={participant?.screenSharing ?? false}
        />
      )}
    </div>
  );

  // Right-click the tile for the per-user volume control (a camera is always a
  // remote; the menu no-ops for a local participant defensively). Without a
  // participant row there is nothing to attenuate, so render the bare tile.
  return participant ? (
    <ParticipantVolumeMenu participant={participant}>{tile}</ParticipantVolumeMenu>
  ) : (
    tile
  );
});
