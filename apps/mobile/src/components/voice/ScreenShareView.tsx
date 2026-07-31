import { Animated, Pressable, View, type ViewStyle } from "react-native";
import { Text } from "../ui/Text";
import { MonitorUp } from "lucide-react-native";
import { VideoTrack } from "@livekit/react-native";
import type { RemoteScreenShare } from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "@/theme/theme";
import { useVideoTrackRef } from "./track-ref";
import { useAutoHideControls } from "./useAutoHideControls";
import { VideoFullscreenModal, type PipSubject } from "./VideoFullscreenModal";

/**
 * Renders one remote screen share (the host's film) with
 * `@livekit/react-native`'s `<VideoTrack>` — the RN counterpart of desktop's
 * `<video>` + `track.attach(el)`. VideoTrack reads only `publication.track`
 * (the live `RemoteVideoTrack`) and `publication.trackSid`, and — because the
 * track is a real `RemoteVideoTrack` with `adaptiveStream` on — wires the
 * ViewPort observer so LiveKit streams the right layer for the rendered size.
 *
 * The engine exposes the share as a bare `RemoteTrackLike` (no publication
 * object). We adapt it to the `TrackReference` RN's VideoTrack wants via the
 * shared {@link useVideoTrackRef} helper — a UI-side adaptation, not an engine
 * change (`@demli/media` stays untouched).
 *
 * Tap the tile to open the {@link VideoFullscreenModal} — the same `trackRef` is
 * reused for the fullscreen viewer (one reference, one subscription), so watching
 * a movie/desktop share isn't stuck on a small tile. `pipSubject` (if any) is
 * forwarded so the fullscreen viewer can pin the active speaker as a movable PiP.
 *
 * Fullscreen is CONTROLLED by the parent (VoiceRoomScreen), not local state: the
 * voice screen must know when a share is fullscreen to force LANDSCAPE orientation
 * for it (founder #70 — landscape only while a share is fullscreen), so the single
 * source of truth lives up there and flows down as `fullscreen`/`onFullscreenChange`.
 *
 * SCREEN_SHARE_AUDIO (the film's sound) needs no component: LiveKit auto-plays
 * every subscribed remote audio track through the native AudioSession, exactly
 * like voice. `objectFit="contain"` letterboxes so the whole frame is visible.
 */
export function ScreenShareView({
  share,
  sharerName,
  pipSubject,
  cameraSubjects,
  fullscreen,
  onFullscreenChange,
  style,
}: {
  share: RemoteScreenShare;
  sharerName?: string | null;
  /** The active speaker the fullscreen viewer can pin as a floating PiP. */
  pipSubject?: PipSubject | null;
  /** Camera-on participants for the fullscreen viewer's multi-camera strip. */
  cameraSubjects?: PipSubject[];
  /** Whether the fullscreen viewer is open (owned by VoiceRoomScreen). */
  fullscreen: boolean;
  /** Open/close the fullscreen viewer (drives the screen's landscape lock). */
  onFullscreenChange: (open: boolean) => void;
  style?: ViewStyle;
}) {
  const { t } = useAppTranslation();

  // Built ONCE from the live track and shared with the fullscreen viewer below —
  // one reference, one subscription. The modal renders this exact object; it
  // never re-derives or re-subscribes the track.
  const trackRef = useVideoTrackRef(share.track);
  const label = sharerName ? t("mobile:voice.sharing", { name: sharerName }) : null;
  // Video-player label on the small tile: greet for a couple of seconds, then fade
  // (founder #1) — no permanent "{name} is sharing" banner sitting on the stage.
  const caption = useAutoHideControls();

  const tileStyle: ViewStyle = {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: radius.md,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.stroke,
    ...style,
  };

  return (
    <>
      <Pressable
        onPress={() => onFullscreenChange(true)}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:voice.fullscreen.open")}
        style={{ flex: 1 }}
      >
        {/* While the fullscreen viewer is open it renders the SAME track and fully
            occludes this tile, so decoding + re-rendering a SECOND sink here is pure
            waste (and doubled the movie-night decode load the prior wave flagged). Show
            a cheap black placeholder behind the modal instead; the real sink remounts
            the instant fullscreen closes (the memoized trackRef keeps one subscription). */}
        {fullscreen ? (
          <View style={tileStyle} />
        ) : (
          <VideoTrack trackRef={trackRef} objectFit="contain" style={tileStyle} />
        )}
        {label ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: space.sm,
              left: space.sm,
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              maxWidth: "80%",
              paddingHorizontal: space.sm,
              paddingVertical: space.xs,
              borderRadius: radius.pill,
              backgroundColor: "rgba(0,0,0,0.55)",
              opacity: caption.opacity,
            }}
          >
            <MonitorUp size={13} color={colors.online} />
            <Text numberOfLines={1} style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>
              {label}
            </Text>
          </Animated.View>
        ) : null}
      </Pressable>

      {/* Lives here so it unmounts (and dismisses) automatically the moment the
          room drops this share — no crash, no frame frozen fullscreen. */}
      <VideoFullscreenModal
        visible={fullscreen}
        trackRef={trackRef}
        label={label}
        pipSubject={pipSubject}
        cameraSubjects={cameraSubjects}
        shareUserId={share.userId}
        onClose={() => onFullscreenChange(false)}
      />
    </>
  );
}
