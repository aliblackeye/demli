/**
 * Local camera SELF-PREVIEW tile (task #18).
 *
 * The media core publishes the camera via livekit's `setCameraEnabled` but does
 * NOT expose the local track as React state (CLAUDE.md §27) — same as screen
 * share. So the desktop renders its own preview from the platform's own capture
 * (`getUserMedia`), exactly as the render contract prescribes. The engine stays
 * the single source of truth for what is actually published; this is a mirror
 * for the local user only.
 *
 * The preview is shown WHOLE and UPRIGHT: `object-contain`, and deliberately NOT
 * horizontally flipped. A self-view mirror (`scale-x-1`) was the source of the
 * founder's "mirror effect" — text/screens read backwards and it looked wrong in
 * fullscreen — so it is gone; the local user sees exactly what everyone else
 * sees, never cropped or transformed.
 *
 * Lifecycle: the tile is mounted only while `cameraEnabled` is true, so the
 * preview stream is acquired on mount and every track is stopped on unmount /
 * device change — no leak, and the OS camera light follows the real state. If
 * the preview capture fails (e.g. permission denied, device busy), we fall back
 * to the avatar silently — the engine already surfaces the user-facing error
 * (§26), so we never double-report.
 */

import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { UserAvatar, cn } from "@demli/ui";
import type { VoiceParticipant } from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { startLocalPreviewPlayback } from "../lib/video-playback";
import { VideoTileLabel } from "./VideoTileLabel";
import { SpeakingGlow, TileFocusRing } from "./AvatarTile";

export interface LocalCameraTileProps {
  /** Selected camera device (null = platform default). */
  deviceId: string | null;
  /** Local roster row — drives the speaking ring and muted glyph on the label. */
  participant?: VoiceParticipant;
  className?: string;
  /** When provided the tile becomes clickable (promote to / exit the stage). */
  onSelect?: () => void;
  /** Show the name chip — grid/filmstrip/stage tiles turn it on. */
  showName?: boolean;
}

export const LocalCameraTile = memo(function LocalCameraTile({
  deviceId,
  participant,
  className,
  onSelect,
  showName = false,
}: LocalCameraTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const me = useAuthStore((s) => s.user);
  const name = me?.displayName ?? t("desktop:voice.you");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    setFailed(false);

    media
      .getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      })
      .then((acquired) => {
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        const el = videoRef.current;
        if (el) {
          el.srcObject = acquired;
          // The `autoPlay` attribute does not reliably start a srcObject assigned
          // in an async callback in a browser (esp. Safari 12) — without this the
          // web self-view stayed on the avatar fallback (never showing the camera)
          // while desktop worked. See lib/video-playback.
          startLocalPreviewPlayback(el);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      const el = videoRef.current;
      if (el) el.srcObject = null;
    };
  }, [deviceId]);

  const interactive = Boolean(onSelect);
  const speaking = participant?.speaking ?? false;

  return (
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
      data-testid="local-camera-tile"
      data-speaking={speaking || undefined}
      className={cn(
        "group/tile relative flex items-center justify-center overflow-hidden rounded-xl bg-rail",
        "[--avatar-ring:var(--color-rail)]",
        // Focus is drawn by <TileFocusRing> (an inset overlay above the video),
        // not by a ring on this box: the <video> would paint over it.
        interactive && "cursor-pointer outline-none",
        className,
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <UserAvatar name={name} colorSeed={me?.id ?? name} src={me?.avatarUrl ?? null} size="lg" />
      </div>
      {!failed && (
        // Upright, whole frame — never mirrored, never cropped.
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="relative h-full w-full object-contain"
        />
      )}
      {interactive && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-wash opacity-0 transition-opacity motion-hover group-hover/tile:opacity-100"
        />
      )}
      {showName && (
        <VideoTileLabel
          name={name}
          muted={participant ? !participant.micEnabled : false}
          deafened={participant?.deafened ?? false}
        />
      )}
      <SpeakingGlow on={speaking} />
      {/* Keyboard focus mark — above the <video>, which would cover a ring on
          the tile box. */}
      {interactive && <TileFocusRing />}
    </div>
  );
});
