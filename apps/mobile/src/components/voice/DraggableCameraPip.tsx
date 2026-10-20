import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Animated,
  PanResponder,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { VideoTrack } from "@livekit/react-native";
import { VideoOff, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { avatarTileGlow } from "@/theme/avatar-color";
import { useReducedMotion } from "@/theme/motion";
import { MOTION_PRESETS } from "@/theme/motion-presets";
import { colors, radius, space, typography } from "@/theme/theme";
import { withAlpha } from "../ui/kit-math";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { IdentityGlow, SpeakingFrame } from "./stage-chrome";
import { useVideoTrackRef } from "./track-ref";

/** PiP frame size — small enough to never block the stream, portrait self-view shape. */
const PIP_W = 104;
const PIP_H = 148;
/** Movement (px) under which a gesture counts as a tap (absorbed), not a drag. */
const TAP_SLOP = 6;
/** The PiP's corner radius — a small window, one step under the stage tiles. */
const PIP_RADIUS = radius.lg;
/** The functional 1px edge (see the frame style below). */
const PIP_EDGE = 1;
/** The content box inside that edge — what the identity glow is sized to. */
const PIP_INNER_W = PIP_W - 2 * PIP_EDGE;
const PIP_INNER_H = PIP_H - 2 * PIP_EDGE;

export type CornerKey = "tl" | "tr" | "bl" | "br";

/** Top-left offsets for each corner, inset by the safe area + a margin. */
function cornerPositions(
  width: number,
  height: number,
  insets: EdgeInsets,
): Record<CornerKey, { x: number; y: number }> {
  const m = space.lg;
  const left = m + insets.left;
  const right = width - PIP_W - m - insets.right;
  const top = insets.top + m;
  const bottom = height - PIP_H - m - insets.bottom;
  return {
    tl: { x: left, y: top },
    tr: { x: right, y: top },
    bl: { x: left, y: bottom },
    br: { x: right, y: bottom },
  };
}

/** The subject's live camera (own subcomponent so the hook never runs on a null track). */
function PipVideo({ track, mirror }: { track: object; mirror: boolean }) {
  const trackRef = useVideoTrackRef(track);
  return (
    <VideoTrack
      trackRef={trackRef}
      objectFit="cover"
      mirror={mirror}
      // 1 = SurfaceView.setZOrderMediaOverlay(true): above the main fullscreen
      // VideoTrack's surface (zOrder 0) but still BELOW this window, so the RN
      // views drawn over the PiP — the coral SpeakingFrame, the name strip, the
      // self-view's close button — stay visible. 2 would be setZOrderOnTop(true)
      // (react-native-webrtc WebRTCView.setZOrder), which composites the video
      // above the whole window and silently covers all three. Same layering as
      // the grid's local CameraTile.
      zOrder={1}
      style={{ flex: 1, backgroundColor: colors.rail }}
    />
  );
}

/**
 * The SELF-VIEW with the camera OFF (K4). It deliberately does not disappear: the
 * founder's requirement is literally "kameram açık değilse de kamera gözükmediği
 * haliyle bir dikdörtgen belirsin ki kameramın açık olmadığını anlayayım", and it
 * is the honest design too — a missing overlay is indistinguishable from a broken
 * one, so the state is shown rather than implied by absence (§35). Identity-first
 * (avatar) with the crossed-camera glyph + caption carrying the state.
 */
function PipCameraOff({
  userId,
  name,
  avatarUrl,
}: {
  userId: string;
  name: string;
  avatarUrl: string | null;
}) {
  const { t } = useAppTranslation();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        // Neutral surface + the identity glow, like the stage tile: the caption
        // below sits on `surface`, so it keeps its contrast for every hue.
        backgroundColor: colors.surface,
      }}
    >
      <IdentityGlow color={avatarTileGlow(userId)} width={PIP_INNER_W} height={PIP_INNER_H} />
      <Avatar name={name} size={42} uri={avatarUrl} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: space.xs }}>
        <VideoOff size={11} color={colors.fgMuted} />
        <Text
          numberOfLines={1}
          style={{ color: colors.fgMuted, fontSize: typography.size["2xs"], fontWeight: "600", flexShrink: 1 }}
        >
          {t("mobile:voice.selfView.cameraOff")}
        </Text>
      </View>
    </View>
  );
}

/** Cameraless subject → the neutral surface with their identity glow and avatar. */
function PipAvatar({
  userId,
  name,
  avatarUrl,
}: {
  userId: string;
  name: string;
  avatarUrl: string | null;
}) {
  return (
    <View
      style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }}
    >
      <IdentityGlow color={avatarTileGlow(userId)} width={PIP_INNER_W} height={PIP_INNER_H} />
      <Avatar name={name} size={52} uri={avatarUrl} />
    </View>
  );
}

/**
 * The ACTIVE SPEAKER pinned as a small floating overlay above a fullscreen
 * screen-share (founder requirement #68). Shows their camera when they have one
 * on, else their avatar — so the film-night watcher always sees WHO is talking.
 * Free-drag anywhere, then snap to the nearest corner on release so it never
 * strays off-screen or drifts over the stream's center. Built on RN's built-in
 * `PanResponder` + `Animated` only — no gesture-handler / reanimated — so the
 * whole feature stays OTA-safe. The corner snap rides the authored position
 * spring (motion presets, ζ≈1.34 — it lands without bouncing), and jumps under
 * reduced motion.
 *
 * The parent swaps `track`/`name`/`userId` in place as the speaker changes (the
 * component is NOT re-keyed), so the PiP follows the conversation while keeping
 * its dragged position — no jump back to a corner on every speaker flip.
 *
 * Drag mechanics: on grant we lift the current position into the Animated offset
 * and zero the value, so `Animated.event` can write raw `dx/dy` during the move
 * (the classic offset/flatten pattern); the transform updates on the native side
 * with no React re-render, so the video never re-attaches. A listener mirrors the
 * live translate into a ref so release can measure the PiP's center and pick the
 * nearest corner. A gesture that moved less than {@link TAP_SLOP} is treated as a
 * tap and absorbed (so it never dismisses the stream behind the PiP).
 *
 * Reuses the engine's single live track via {@link useVideoTrackRef} (same track
 * object the grid/stage already render) — no extra subscription.
 */
export function DraggableCameraPip({
  track,
  userId,
  name,
  avatarUrl,
  speaking,
  width,
  height,
  insets,
  cameraOff = false,
  mirror = false,
  corner,
  onCornerChange,
  onClose,
  closeLabel,
}: {
  /** The subject's live camera track, or null → show their avatar/placeholder. */
  track: object | null;
  /** Drives the deterministic identity-glow hue when cameraless. */
  userId: string;
  name: string;
  /** The subject's avatar image for the cameraless PiP, or null when they have none. */
  avatarUrl: string | null;
  /** Ring the frame coral while this person is the active speaker. */
  speaking: boolean;
  /** Fullscreen container width (window width). */
  width: number;
  /** Fullscreen container height (window height). */
  height: number;
  insets: EdgeInsets;
  /**
   * SELF-VIEW with the camera off (K4): render the explicit "camera off"
   * rectangle instead of a plain avatar, so the box states the camera's state
   * rather than merely occupying space.
   */
  cameraOff?: boolean;
  /** Mirror the video — true for your own camera, false for anyone else's. */
  mirror?: boolean;
  /**
   * Resting corner to honour (persisted preference). Omit to keep the local
   * bottom-right default. Changing it from outside MOVES the box; our own
   * drag-snaps report back through {@link onCornerChange} instead.
   */
  corner?: CornerKey;
  /** Called with the new corner after a drag settles, so it can be remembered. */
  onCornerChange?: (corner: CornerKey) => void;
  /** Show a small dismiss button (the self-view's "hide me" affordance). */
  onClose?: () => void;
  /** Localized accessibility label for the dismiss button. */
  closeLabel?: string;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const corners = useMemo(
    () => cornerPositions(width, height, insets),
    [width, height, insets],
  );

  // Start at the remembered corner, else bottom-right — clear of the top controls
  // (top-right) and the sharer label (top-left), the FaceTime-style resting spot.
  const initialCorner = useRef<CornerKey>(corner ?? "br").current;
  const pan = useRef(new Animated.ValueXY(corners[initialCorner])).current;
  // Live translate mirror (offset + value) so release can measure without
  // touching Animated internals.
  const posRef = useRef({ x: corners[initialCorner].x, y: corners[initialCorner].y });
  // Latest corner map, read by the (once-created) PanResponder.
  const cornersRef = useRef(corners);
  cornersRef.current = corners;
  // The corner WE last settled on. Lets the effect below distinguish an external
  // change (a late store hydration, another surface) — which should move the box
  // — from the echo of our own snap, which must not restart the animation.
  const settledCorner = useRef<CornerKey>(initialCorner);

  useEffect(() => {
    const id = pan.addListener((v) => {
      posRef.current = v;
    });
    return () => pan.removeListener(id);
  }, [pan]);

  const onCornerChangeRef = useRef(onCornerChange);
  onCornerChangeRef.current = onCornerChange;

  /** Animate to a specific corner and record it as the settled one. */
  const moveToCorner = useCallback(
    (key: CornerKey) => {
      settledCorner.current = key;
      const toValue = cornersRef.current[key];
      // useNativeDriver stays false: the drag writes `pan` through
      // Animated.event on the JS side, and one value cannot be driven by both.
      if (reducedRef.current) {
        Animated.timing(pan, { toValue, duration: 0, useNativeDriver: false }).start();
        return;
      }
      const spring = MOTION_PRESETS.position;
      Animated.spring(pan, {
        toValue,
        stiffness: spring.stiffness,
        damping: spring.damping,
        mass: spring.mass,
        useNativeDriver: false,
      }).start();
    },
    [pan],
  );

  const snapToNearestCorner = useCallback(() => {
    const { x, y } = posRef.current;
    const cx = x + PIP_W / 2;
    const cy = y + PIP_H / 2;
    const key = (`${cy < height / 2 ? "t" : "b"}${cx < width / 2 ? "l" : "r"}`) as CornerKey;
    moveToCorner(key);
    // Report the drag's outcome so the preference can be remembered.
    onCornerChangeRef.current?.(key);
  }, [moveToCorner, width, height]);
  const snapRef = useRef(snapToNearestCorner);
  snapRef.current = snapToNearestCorner;

  // Keep the PiP on-screen when the window resizes (rotation): re-snap to the
  // nearest corner of the new geometry.
  useEffect(() => {
    snapRef.current();
  }, [width, height, insets]);

  // Honour an EXTERNAL corner change — most often the persisted preference
  // arriving after an async SecureStore hydration, which lands a frame or two
  // after mount. Skipped when it merely echoes our own snap.
  useEffect(() => {
    if (!corner || corner === settledCorner.current) return;
    moveToCorner(corner);
  }, [corner, moveToCorner]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e: GestureResponderEvent, g: PanResponderGestureState) =>
          Math.abs(g.dx) > TAP_SLOP || Math.abs(g.dy) > TAP_SLOP,
        onPanResponderGrant: () => {
          pan.setOffset({ x: posRef.current.x, y: posRef.current.y });
          pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_e: GestureResponderEvent, g: PanResponderGestureState) => {
          pan.flattenOffset();
          // A tap just absorbs the touch (keeps it off the tap-to-close backdrop);
          // a real drag snaps to the nearest corner.
          if (Math.abs(g.dx) < TAP_SLOP && Math.abs(g.dy) < TAP_SLOP) return;
          snapRef.current();
        },
        onPanResponderTerminate: () => {
          pan.flattenOffset();
          snapRef.current();
        },
      }),
    [pan],
  );

  return (
    <Animated.View
      {...responder.panHandlers}
      accessibilityRole="image"
      accessibilityLabel={t("mobile:voice.pip.a11y", { name })}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: PIP_W,
        height: PIP_H,
        transform: pan.getTranslateTransform(),
        borderRadius: PIP_RADIUS,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.rail,
        // A small window over arbitrary video needs ONE functional edge to read
        // as a separate thing (Koyu Masa: lines only where they do a job). No
        // outer shadow — depth is the tone change, not a lift.
        borderWidth: PIP_EDGE,
        borderColor: colors.strokeStrong,
      }}
    >
      {track ? (
        <PipVideo track={track} mirror={mirror} />
      ) : cameraOff ? (
        <PipCameraOff userId={userId} name={name} avatarUrl={avatarUrl} />
      ) : (
        <PipAvatar userId={userId} name={name} avatarUrl={avatarUrl} />
      )}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
          backgroundColor: colors.scrim,
        }}
      >
        <Text
          numberOfLines={1}
          style={{ color: colors.fgDisplay, fontSize: typography.size["2xs"], fontWeight: "600" }}
        >
          {name}
        </Text>
      </View>
      <SpeakingFrame speaking={speaking} borderRadius={PIP_RADIUS} />
      {/* Dismiss — the self-view's "hide me". Rendered last so it wins its own
          touch; the PanResponder above still owns the rest of the box. */}
      {onClose ? (
        <Touchable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={closeLabel ?? t("mobile:voice.selfView.hide")}
          tone={colors.scrim}
          pressedTone={withAlpha(colors.rail, 0.8)}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 24,
            height: 24,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <X size={13} color={colors.fgDisplay} strokeWidth={2.25} />
        </Touchable>
      ) : null}
    </Animated.View>
  );
}
