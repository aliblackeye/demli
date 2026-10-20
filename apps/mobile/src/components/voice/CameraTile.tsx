import { memo } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, View } from "react-native";
import { VideoTrack } from "@livekit/react-native";
import { MicOff, VolumeX } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, space } from "@/theme/theme";
import { Text } from "../ui/Text";
import { MediaPill, SpeakingFrame, TILE_RADIUS, usePressWash } from "./stage-chrome";
import { useVideoTrackRef } from "./track-ref";

/**
 * One participant's live CAMERA video (task #18) — the camera counterpart of
 * `ScreenShareView`. Renders with `@livekit/react-native`'s `<VideoTrack>` (the
 * RN equivalent of desktop's `<video>` + `track.attach(el)`); because the track
 * is a real livekit video track with `adaptiveStream` on, VideoTrack wires the
 * viewport observer so the SFU streams the right layer for the rendered size.
 *
 * The engine hands us a bare track (remote: `RemoteCamera.track`; local: the
 * live `LocalVideoTrack`) with no publication object — that shape targets the
 * web's `attach(HTMLMediaElement)` path — so we build the minimal `TrackReference`
 * VideoTrack actually consumes from the track we DO have (same UI-side adaptation
 * as ScreenShareView; `@demli/media` stays untouched).
 *
 * `objectFit="cover"` fills the tile (a face reads better cropped than
 * letterboxed); the local self-view is mirrored, the natural front-camera look.
 *
 * Koyu Masa: borderless on pure black, the shared tile radius, the coral
 * {@link SpeakingFrame} for "this person is talking", and a press that washes the
 * picture instead of fading it.
 */
export interface CameraTileData {
  /** Stable key + roster join key — the participant identity. */
  identity: string;
  /** The live video track (remote `RemoteTrackLike` or local `LocalVideoTrack`). */
  track: object;
  name: string;
  isLocal: boolean;
  /** Show the muted badge (participant mic is off). */
  muted: boolean;
  speaking: boolean;
}

export const CameraTile = memo(function CameraTile({
  track,
  name,
  isLocal,
  muted,
  speaking,
  mutedForYou,
  showName = false,
  contain = false,
  onPress,
  onLongPress,
  accessibilityLabel,
  style,
}: {
  track: object;
  name: string;
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  /**
   * Kept for API compatibility with the stage: the focused tile is already the
   * big one, so it no longer wears a second ring that would compete with the
   * coral speaking ring.
   */
  focused?: boolean;
  /** Volume set to 0 by this listener → show the "muted for you" glyph. */
  mutedForYou?: boolean;
  /**
   * Show the participant NAME. OFF by default — small grid/filmstrip tiles stay
   * clean; only the focused/stage/fullscreen view labels the person. The mic-off
   * badge is independent and always shown while muted.
   */
  showName?: boolean;
  /**
   * Fit the WHOLE frame (objectFit contain, letterboxed) instead of cropping
   * (cover). The focused/stage view passes this so a landscape camera in a
   * portrait stage is never cropped; small tiles keep cover.
   */
  contain?: boolean;
  /** When set, the tile becomes tappable (grid → focus, filmstrip → switch focus). */
  onPress?: () => void;
  /** Long-press → open the per-user volume sheet (remotes only). */
  onLongPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  const { t } = useAppTranslation();
  const trackRef = useVideoTrackRef(track);
  const wash = usePressWash();

  const label = isLocal ? t("mobile:voice.cameraYou", { name }) : name;
  // The overlay only appears when there's something to show: the mic-off badge
  // (always, while muted), the "muted for you" glyph (volume 0), or the name.
  const showOverlay = muted || mutedForYou || showName;

  const body = (
    <>
      <VideoTrack
        trackRef={trackRef}
        objectFit={contain ? "contain" : "cover"}
        mirror={isLocal}
        // Local self-view stacks above remote tiles (see zOrder docs).
        zOrder={isLocal ? 1 : 0}
        style={{ flex: 1, backgroundColor: colors.rail }}
      />
      {showOverlay ? (
        <MediaPill
          style={{ position: "absolute", left: space.sm, bottom: space.sm, maxWidth: "88%" }}
        >
          {muted ? <MicOff size={12} color={colors.danger} strokeWidth={2.25} /> : null}
          {mutedForYou ? <VolumeX size={12} color={colors.fgMuted} strokeWidth={2.25} /> : null}
          {showName ? (
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, color: colors.fgDisplay, fontSize: 12, fontWeight: "600" }}
            >
              {label}
            </Text>
          ) : null}
        </MediaPill>
      ) : null}
      <SpeakingFrame speaking={speaking} />
    </>
  );

  const frame: ViewStyle = {
    overflow: "hidden",
    borderRadius: TILE_RADIUS,
    borderCurve: "continuous",
    backgroundColor: colors.rail,
    ...style,
  };

  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={350}
        {...wash.handlers}
        accessibilityRole="button"
        // "Speaking" is part of what TalkBack reads — the ring alone is visual.
        accessibilityLabel={
          speaking
            ? t("mobile:voice.speakingA11y", { name: accessibilityLabel ?? label })
            : (accessibilityLabel ?? label)
        }
        style={frame}
      >
        {body}
        {wash.overlay}
      </Pressable>
    );
  }

  return <View style={frame}>{body}</View>;
});
