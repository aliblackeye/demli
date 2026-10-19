/**
 * Small, shared pieces of chrome for every call surface on the phone — the voice
 * room stage, the DM call, the share filmstrip, the PiP, the mini bars. They exist
 * so the Koyu Masa call language is written ONCE:
 *
 *  - {@link SpeakingFrame}: who is talking. A 2px coral ring plus a faint coral
 *    glow inside the tile edge (design system §5 "konuşan +2px accent halka",
 *    `accent-glow`), fading on the tone step so a voice that comes in bursts
 *    does not strobe the grid.
 *  - {@link usePressWash}: a tile's press feedback. Tiles are rows in the
 *    founder's sense — nothing lifts or scales — so a press is a white wash over
 *    the picture, 120ms in / 200ms out, the same grammar as `ui/Touchable`. A
 *    background tone change would be invisible under video, hence an overlay.
 *  - {@link MediaPill}: the translucent label pill that sits on top of video
 *    (name chips, "Ali paylaşıyor", volume bars), with the landing's inset pill
 *    line. The darker `scrim` tone, not `veil`: there is no blur behind it on
 *    Android, and `veil` (24%) is unreadable over a bright frame.
 *  - {@link LiveDot}: a status dot that breathes while the state is in motion
 *    (ringing, reconnecting) and sits still once it settles.
 *
 * Every animation runs on the UI thread (Reanimated) and honours the OS
 * reduce-motion switch twice: the presets carry `ReduceMotion.System`, and the
 * loops are not even started when `useReducedMotion()` says so.
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { motionTo, toneTo, useReducedMotion } from "@/theme/motion";
import { colors, elevation, radius, space } from "@/theme/theme";
import { withAlpha } from "../ui/kit-math";

/** Corner radius of every stage tile (grid, focus, filmstrip, share frame). */
export const TILE_RADIUS = radius.xl;

/** One full breath of a live dot / ringing glow, in and out (design system: 1.4s). */
export const BREATH_MS = 1400;

/** Inner glow + ring, as one inset shadow so it follows the tile's own corners. */
const SPEAKING_SHADOW = `inset 0 0 0 2px ${colors.accent}, inset 0 0 18px ${colors.accentGlow}`;

/**
 * The speaking ring over a tile. Mount it as the LAST child of a tile whose
 * frame has `overflow: "hidden"` and the same `borderRadius`. Only this view
 * animates; the tile underneath (and its video) never re-renders for it.
 */
export function SpeakingFrame({
  speaking,
  borderRadius = TILE_RADIUS,
}: {
  speaking: boolean;
  borderRadius?: number;
}) {
  const reduced = useReducedMotion();
  const on = useSharedValue(speaking ? 1 : 0);
  useEffect(() => {
    on.value = motionTo(speaking ? 1 : 0, "tone", { reduced });
  }, [speaking, reduced, on]);
  const style = useAnimatedStyle(() => ({ opacity: on.value }));
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius,
          borderCurve: "continuous",
          boxShadow: SPEAKING_SHADOW,
        },
        style,
      ]}
    />
  );
}

/**
 * Press feedback for a surface whose own background is covered by content (a
 * video tile, an avatar tile). Spread `handlers` onto the Pressable and render
 * `overlay` as its last child.
 */
export function usePressWash(borderRadius: number = TILE_RADIUS): {
  handlers: { onPressIn: () => void; onPressOut: () => void };
  overlay: ReactNode;
} {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: pressed.value }));
  return useMemo(
    () => ({
      handlers: {
        onPressIn: () => {
          pressed.value = toneTo(true, reduced);
        },
        onPressOut: () => {
          pressed.value = toneTo(false, reduced);
        },
      },
      overlay: (
        <Animated.View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius,
              backgroundColor: colors.washStrong,
            },
            style,
          ]}
        />
      ),
    }),
    [reduced, pressed, style, borderRadius],
  );
}

/** The translucent pill for text and glyphs drawn ON video. */
export function MediaPill({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingHorizontal: space.sm,
          paddingVertical: 3,
          borderRadius: radius.pill,
          backgroundColor: colors.scrim,
        },
        elevation.pillInset,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const BREATH_EASE = Easing.bezier(0.44, 0, 0.56, 1);

/**
 * A breathing 0→1→0 shared value while `active`, at rest (1) otherwise and under
 * reduced motion. One loop per mounted user; cancelled on unmount.
 */
export function useBreath(active: boolean): SharedValue<number> {
  const reduced = useReducedMotion();
  const t = useSharedValue(active && !reduced ? 0 : 1);
  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(t);
      t.value = 1;
      return;
    }
    t.value = 0;
    t.value = withRepeat(
      withTiming(1, { duration: BREATH_MS / 2, easing: BREATH_EASE, reduceMotion: ReduceMotion.System }),
      -1,
      true,
    );
    return () => cancelAnimation(t);
  }, [active, reduced, t]);
  return t;
}

/** Status dot (`color` must be a #rrggbb token); `pulsing` = the state is still moving. */
export function LiveDot({
  color,
  pulsing = false,
  size = 8,
}: {
  color: string;
  pulsing?: boolean;
  size?: number;
}) {
  const breath = useBreath(pulsing);
  const halo = useAnimatedStyle(() => ({
    opacity: pulsing ? 0.15 + 0.45 * breath.value : 0,
    transform: [{ scale: 1 + 0.9 * breath.value }],
  }));
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            width: size,
            height: size,
            borderRadius: radius.pill,
            backgroundColor: withAlpha(color, 0.6),
          },
          halo,
        ]}
      />
      <View style={{ width: size, height: size, borderRadius: radius.pill, backgroundColor: color }} />
    </View>
  );
}

/** Voice status → dot colour, shared by the room strip and the mini bar. */
export function voiceStatusColor(status: string): string {
  if (status === "connected") return colors.success;
  if (status === "error") return colors.danger;
  if (status === "reconnecting" || status === "joining") return colors.warning;
  return colors.fgSubtle;
}
