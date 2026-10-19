import { memo, useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VideoTrack } from "@livekit/react-native";
import { Maximize2, Minimize2, PictureInPicture2, Volume2, VolumeX, X } from "lucide-react-native";
import { DEFAULT_PARTICIPANT_VOLUME, MAX_PARTICIPANT_VOLUME } from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "@/theme/theme";
import { useVoiceStore } from "@/stores/voice-store";
import { useScreenShareVolumes } from "@/stores/screen-share-volume-store";
import { IconButton } from "../ui/IconButton";
import { Slider } from "../ui/Slider";
import { Text } from "../ui/Text";
import { DraggableCameraPip } from "./DraggableCameraPip";
import { ParticipantTile, type ParticipantTileData } from "./ParticipantTile";
import { SelfViewPip } from "./SelfViewPip";
import { MediaPill } from "./stage-chrome";
import { useAutoHideControls } from "./useAutoHideControls";
import type { VideoTrackRef } from "./track-ref";
import { useIsInPipWindow } from "./use-pip-window";

/**
 * The floating PiP subject over a fullscreen screen share (founder requirement
 * #68): the person currently SPEAKING (LiveKit active-speaker via
 * `participant.speaking`), or — when the room is quiet — the person sharing.
 * NEVER the local user. Carries a camera `track` when they have a camera on, else
 * `null` so the PiP shows their avatar instead of a black hole. The parent
 * recomputes this as the active speaker changes; the PiP follows.
 */
export interface PipSubject {
  identity: string;
  userId: string;
  /** Live camera track if the subject has a camera on, else null → avatar. */
  track: object | null;
  name: string;
  /** Their photo for the cameraless case, or null when they have none. */
  avatarUrl: string | null;
  speaking: boolean;
}

/**
 * The fullscreen stream video, ISOLATED behind {@link memo} so the parent modal's
 * frequent re-renders never touch this RTCView. The modal re-renders on every
 * active-speaker tick (pipSubject/cameraSubjects carry `speaking`, which flips
 * constantly during a movie night), and `@livekit/react-native`'s `<VideoTrack>` is
 * NOT memoized — each render re-invokes `mediaStream.toURL()` (a native bridge hop)
 * and reconciles the RTCView. Left inline, the wide screen-share sink churned several
 * times a second, saturating the JS/UI thread → the UI froze and Android ANR-killed
 * the app the moment the watcher tapped in fullscreen (founder P0, §27). Its props are
 * stable (one memoized `trackRef`; `objectFit` only flips on the enlarge toggle), so
 * with `memo` it mounts once and re-renders only when the picture genuinely changes —
 * never on a speaking tick.
 */
const FullscreenStreamVideo = memo(function FullscreenStreamVideo({
  trackRef,
  objectFit,
  mirror,
}: {
  trackRef: VideoTrackRef;
  objectFit: "cover" | "contain";
  mirror: boolean;
}) {
  return (
    <VideoTrack trackRef={trackRef} objectFit={objectFit} mirror={mirror} style={{ flex: 1 }} />
  );
});

/**
 * Fullscreen viewer for ONE live video track — a peer's screen share (film
 * night) or a focused camera. Renders the SAME `trackRef` the tile already uses:
 * we never build a second reference or open a second subscription; the caller
 * passes its memoized ref straight through, so both `<VideoTrack>`s attach to the
 * one live track.
 *
 * Fullscreen fill (founder #67): a wide desktop share must fill the phone, not
 * sit letterboxed in the middle. The REAL fix is orientation — the voice screen
 * forces LANDSCAPE while a screen share is fullscreen (see VoiceRoomScreen), so
 * the phone's long axis carries the wide frame naturally. No CSS rotation hack
 * (the old 90°-transform "fill" inverted on an already-rotated window and made
 * the enlarge button SHRINK the picture — the founder's bug). Here the video just
 * fills with `objectFit`:
 *   - `contain` (default): the whole frame, letterboxed — never crops/stretches.
 *   - `cover` (enlarge toggle): fills every pixel, trimming the edges.
 * The enlarge button now genuinely ENLARGES (contain → cover), no inversion.
 *
 * Chrome (founder #1): the caption + the top-right buttons are video-player
 * chrome — they greet you, then FADE (see {@link useAutoHideControls}); a tap on
 * the stream TOGGLES them back. Closing is the explicit ✕ (or Android back), not a
 * stray tap, so the label never has to sit permanently on the stream to stay
 * reachable.
 *
 * Camera overlay (#68 + #2): a toggle reveals the other participants' cameras.
 *  - MULTIPLE cameras → a RIGHT STRIP (a scrollable panel), never a
 *    pile of floating windows (founder #2).
 *  - a single camera / cameraless active speaker → the ACTIVE SPEAKER as a small
 *    draggable {@link DraggableCameraPip}, auto-following whoever is talking (#68).
 *
 * Robustness: the modal is a child of the stage view, which the room unmounts the
 * instant the source drops (activeShare → null / focused camera off). Unmounting
 * dismisses the modal — no crash, no frame frozen fullscreen. Audio is untouched:
 * LiveKit keeps auto-playing any film audio through the AudioSession the whole
 * time.
 */
export function VideoFullscreenModal({
  visible,
  trackRef,
  label,
  mirror = false,
  allowFill = true,
  pipSubject,
  cameraSubjects,
  shareUserId,
  selfViewTile,
  onClose,
}: {
  visible: boolean;
  trackRef: VideoTrackRef;
  /** Fully-localized caption (e.g. "Ali is sharing", or a focused person's name). */
  label: string | null;
  /**
   * The sharer's userId when this fullscreen is a SCREEN SHARE (film) — enables the
   * per-share audio volume bar (task #82). Omitted for a camera (no audio track).
   */
  shareUserId?: string;
  /** Mirror the main video (a focused local self-view). */
  mirror?: boolean;
  /**
   * Offer the contain⇄cover ENLARGE toggle. TRUE for a wide desktop SCREEN share
   * (zoom-to-fill is the point). FALSE for a CAMERA — a camera stays aspect-correct
   * contain, never cover, so it can never crop a face.
   */
  allowFill?: boolean;
  /** The active-speaker (or sharer) to pin as a floating PiP over the stream. */
  pipSubject?: PipSubject | null;
  /**
   * Camera-on participants for the multi-camera case (founder #2): with 2+ the
   * camera overlay is a RIGHT STRIP instead of a single floating PiP.
   * With 0–1 the single draggable {@link pipSubject} PiP is used.
   */
  cameraSubjects?: PipSubject[];
  /**
   * YOUR own tile, to carry the K4 self-view overlay into fullscreen. Passed only
   * by the CAMERA fullscreen path: a screen-share fullscreen already spends its
   * one floating box on the active speaker, and two draggable boxes over one
   * stream is precisely what the founder ruled out.
   */
  selfViewTile?: ParticipantTileData | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Enlarge toggle: contain (whole frame, letterboxed — default) ⇄ cover (fills,
  // trims edges). Only a screen share opts in; a camera is always contain.
  const [fill, setFill] = useState(false);
  const [pipOn, setPipOn] = useState(false);
  // Video-player chrome: the label + buttons greet you, then FADE; a tap toggles
  // them (founder #1). The stream itself never carries a permanent banner.
  const controls = useAutoHideControls();
  const objectFit = allowFill && fill ? "cover" : "contain";
  // Multiple cameras → a right strip (panel) instead of a floating PiP (founder #2).
  const cameras = cameraSubjects ?? [];
  const multiCamera = cameras.length >= 2;
  const canPip = multiCamera || !!pipSubject;

  // Backgrounding into the Android OS PiP window must TEAR THIS WINDOW DOWN
  // (call-ux-plan K5), and the reason is measured, not theoretical: an RN `<Modal>`
  // is a separate native Dialog window, and Android does NOT reconfigure a Dialog
  // to the pinned PiP bounds. Left up, it stays laid out at full screen (1080×2400)
  // while the PiP window is ~336×597, so the window composites the top-left CORNER
  // of the fullscreen video — a magnified fragment. Verified on the AVD: enter
  // fullscreen, press home, and the PiP window showed a white sliver of the frame
  // instead of the camera. That is exactly the founder's "yarım bi şey".
  //
  // So the dismissal is LOCAL (`!inPipWindow` on `visible`) rather than only a
  // request to the parent: it drops the Dialog in the same commit as the PiP
  // transition instead of waiting for the owner's state to come back around. We
  // still notify the owner via `onClose` so its state agrees (and the viewer does
  // not silently reappear on resume over a session that moved on — the share may
  // have stopped, the camera may be off). The `PipController` overlay, which lives
  // in the ACTIVITY window, then owns what the small window shows.
  const inPipWindow = useIsInPipWindow();
  useEffect(() => {
    if (visible && inPipWindow) onClose();
  }, [visible, inPipWindow, onClose]);

  return (
    // `onRequestClose` fires on the Android hardware back button, dismissing the
    // fullscreen modal first before any screen navigation.
    <Modal
      visible={visible && !inPipWindow}
      animationType="fade"
      presentationStyle="fullScreen"
      // Landscape is permitted ONLY for a screen share (allowFill). A CAMERA
      // fullscreen stays PORTRAIT — founder #70: never auto-rotate while a camera
      // is on. (The Android activity lock via the voice screen's Stack.Screen
      // orientation already enforces this; this also pins it on iOS, where a
      // Modal can otherwise rotate free of the activity's lock.)
      supportedOrientations={allowFill ? ["portrait", "landscape"] : ["portrait"]}
      onRequestClose={onClose}
    >
      {/* A Modal is its own Android window: gesture-handler (the film-volume
          slider) needs a root inside it, exactly as ui/Sheet brings its own. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.rail }}>
        {/* Tap anywhere on the video to TOGGLE the chrome (video-player gesture);
            close is the explicit ✕ (or the Android back button). Fills the screen;
            in the forced landscape a wide desktop frame uses the phone's long axis. */}
        <Pressable
          onPress={controls.toggle}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:voice.fullscreen.toggleControls")}
          style={StyleSheet.absoluteFill}
        >
          <FullscreenStreamVideo trackRef={trackRef} objectFit={objectFit} mirror={mirror} />
        </Pressable>

        {/* Caption — top-left, inside the safe area, non-interactive; auto-hides. */}
        {label ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: insets.top + space.sm + 6,
              left: space.lg,
              maxWidth: width - space.lg * 2 - 144,
              opacity: controls.opacity,
            }}
          >
            <MediaPill style={{ paddingHorizontal: space.md, paddingVertical: space.xs }}>
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, color: colors.fgDisplay, fontSize: 13, fontWeight: "600" }}
              >
                {label}
              </Text>
            </MediaPill>
          </Animated.View>
        ) : null}

        {/* PiP toggle + enlarge (contain/cover) toggle + close — top-right, inside
            the safe area; auto-hides with the chrome. `pointerEvents` is off while
            hidden so a hidden button never swallows the tap meant to reveal it. */}
        <Animated.View
          pointerEvents={controls.visible ? "box-none" : "none"}
          style={{
            position: "absolute",
            top: insets.top + space.sm,
            right: space.lg,
            flexDirection: "row",
            gap: space.xs,
            opacity: controls.opacity,
          }}
        >
          {canPip ? (
            <IconButton
              icon={PictureInPicture2}
              variant="veil"
              active={pipOn}
              toggle
              onPress={() => {
                setPipOn((v) => !v);
                controls.reveal();
              }}
              label={
                multiCamera
                  ? pipOn
                    ? t("mobile:voice.pip.hideCameras")
                    : t("mobile:voice.pip.showCameras")
                  : pipOn
                    ? t("mobile:voice.pip.hide")
                    : t("mobile:voice.pip.show")
              }
            />
          ) : null}
          {allowFill ? (
            <IconButton
              icon={fill ? Minimize2 : Maximize2}
              variant="veil"
              onPress={() => {
                setFill((v) => !v);
                controls.reveal();
              }}
              label={fill ? t("mobile:voice.fullscreen.fit") : t("mobile:voice.fullscreen.fill")}
            />
          ) : null}
          <IconButton
            icon={X}
            variant="veil"
            onPress={onClose}
            label={t("mobile:voice.fullscreen.close")}
          />
        </Animated.View>

        {/* Camera overlay (founder #2):
            - MULTIPLE cameras → a right vertical STRIP (panel), never floating.
            - a single camera / cameraless active speaker → the draggable PiP.
            Rendered last so it floats above the stream; its tiles / PanResponder
            win their own touches (so they never toggle the chrome behind them). */}
        {pipOn && multiCamera ? (
          <View
            style={{
              position: "absolute",
              top: insets.top + 60,
              right: insets.right + space.md,
              bottom: insets.bottom + space.md,
              width: 128,
            }}
          >
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              {cameras.map((cam) => (
                <ParticipantTile
                  key={cam.identity}
                  identity={cam.identity}
                  userId={cam.userId}
                  track={cam.track}
                  name={cam.name}
                  avatarUrl={cam.avatarUrl}
                  isLocal={false}
                  muted={false}
                  speaking={cam.speaking}
                  showName
                  style={{ width: 128, aspectRatio: 4 / 3 }}
                />
              ))}
            </ScrollView>
          </View>
        ) : pipOn && pipSubject ? (
          <DraggableCameraPip
            track={pipSubject.track}
            userId={pipSubject.userId}
            name={pipSubject.name}
            avatarUrl={pipSubject.avatarUrl}
            speaking={pipSubject.speaking}
            width={width}
            height={height}
            insets={insets}
          />
        ) : null}

        {/* K4 self-view — the camera-fullscreen path only (see the prop's note),
            so this is never a SECOND floating box over the same stream. */}
        {selfViewTile ? (
          <SelfViewPip self={selfViewTile} width={width} height={height} insets={insets} />
        ) : null}

        {/* Film-audio volume (task #82) — only for a SCREEN share, bottom-center,
            auto-hiding with the chrome. Lets the watcher turn the movie up/down
            without changing the sharer's voice. */}
        {shareUserId ? (
          <Animated.View
            pointerEvents={controls.visible ? "box-none" : "none"}
            style={{
              position: "absolute",
              left: space.lg,
              right: space.lg,
              bottom: insets.bottom + space.md,
              opacity: controls.opacity,
            }}
          >
            <ScreenShareVolumeBar
              userId={shareUserId}
              onAdjustStart={controls.hold}
              onAdjustEnd={controls.reveal}
            />
          </Animated.View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * The per-share (film) audio volume bar for the fullscreen viewer (task #82).
 * Reads the stored level from the persist store (so it shows the saved level even
 * while deafened) and writes through the voice store (engine + persistence). While
 * deafened the film is at 0 (master mute wins); the bar is disabled and shows the
 * mute icon. The kit Slider drives it on the UI thread, so dragging stays smooth
 * while the stream decodes on the same phone.
 *
 * The chrome is HELD (no idle timer) from the first change until the finger
 * lifts, then re-armed — only at the drag boundaries, never per pan sample (a
 * timer restart + setState per pixel was a needless flood on the JS thread the
 * fullscreen viewer is already contending for, §27). Holding also means the bar
 * can never fade out — and stop taking touches — under a finger mid-drag.
 */
function ScreenShareVolumeBar({
  userId,
  onAdjustStart,
  onAdjustEnd,
}: {
  userId: string;
  onAdjustStart: () => void;
  onAdjustEnd: () => void;
}) {
  const { t } = useAppTranslation();
  const stored = useScreenShareVolumes((s) => s.volumes[userId] ?? DEFAULT_PARTICIPANT_VOLUME);
  const deafened = useVoiceStore((s) => s.deafened);
  const setScreenShareVolume = useVoiceStore((s) => s.setScreenShareVolume);
  const level = Math.min(stored, MAX_PARTICIPANT_VOLUME);
  const muted = deafened || Math.round(level * 100) === 0;
  const adjusting = useRef(false);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingLeft: space.md,
        paddingRight: space.sm,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        backgroundColor: colors.glassStrong,
      }}
    >
      {muted ? (
        <VolumeX size={18} color={colors.fgMuted} strokeWidth={2} />
      ) : (
        <Volume2 size={18} color={colors.fg} strokeWidth={2} />
      )}
      <Slider
        value={level}
        min={0}
        max={MAX_PARTICIPANT_VOLUME}
        step={0.05}
        disabled={deafened}
        accessibilityLabel={t("mobile:voice.shareVolume")}
        formatValue={(v) => `${Math.round(v * 100)}%`}
        showValue
        marks={[DEFAULT_PARTICIPANT_VOLUME]}
        style={{ flex: 1 }}
        onValueChange={(next) => {
          if (!adjusting.current) {
            adjusting.current = true;
            onAdjustStart();
          }
          setScreenShareVolume(userId, next);
        }}
        onSlidingComplete={() => {
          adjusting.current = false;
          onAdjustEnd();
        }}
      />
    </View>
  );
}
