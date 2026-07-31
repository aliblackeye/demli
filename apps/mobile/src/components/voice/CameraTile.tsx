import { memo } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { VideoTrack } from "@livekit/react-native";
import { MicOff, VolumeX } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "@/theme/theme";
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
  focused,
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
  /** Draw the accent ring even when not speaking — marks the focused/stage tile. */
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

  const label = isLocal ? t("mobile:voice.cameraYou", { name }) : name;
  const borderColor = speaking ? colors.online : focused ? colors.accent : colors.stroke;
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
        style={{ flex: 1, backgroundColor: "#000" }}
      />
      {/* Mic-off badge (always while muted) + name (only when showName), bottom-left. */}
      {showOverlay ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
            backgroundColor: "rgba(0,0,0,0.45)",
          }}
        >
          {muted ? <MicOff size={13} color={colors.danger} /> : null}
          {mutedForYou ? <VolumeX size={13} color={colors.fgMuted} /> : null}
          {showName ? (
            <Text
              numberOfLines={1}
              style={{ flex: 1, color: "#fff", fontSize: 12, fontWeight: "600" }}
            >
              {label}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );

  const frame: ViewStyle = {
    overflow: "hidden",
    borderRadius: radius.md,
    borderCurve: "continuous",
    backgroundColor: "#000",
    borderWidth: 2,
    borderColor,
    ...style,
  };

  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={({ pressed }) => ({ ...frame, opacity: pressed ? 0.85 : 1 })}
      >
        {body}
      </Pressable>
    );
  }

  return <View style={frame}>{body}</View>;
});
