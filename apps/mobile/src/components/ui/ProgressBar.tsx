/**
 * Determinate progress bar — a 4px coral fill on the white-wash track. Used
 * where the app has a REAL fraction to show (boot phases, an APK download), never
 * as a decorative spinner: the value only moves when the caller's number moves
 * (CLAUDE.md §35 — no fake percentages).
 *
 * The fill glides to each new value on the `standard` step (240ms, decelerating)
 * and is drawn as a `scaleX` from the left edge on the UI thread, so a busy JS
 * thread during boot never stutters it. Reduced motion jumps straight to the
 * value. Needs no provider of any kind — the boot splash renders it before the
 * app's provider tree exists.
 */
import { useEffect } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, radius } from "@/theme/theme";

export function ProgressBar({
  value,
  height = 4,
  accessibilityLabel,
  style,
}: {
  /** 0…1. Out-of-range input is clamped. */
  value: number;
  height?: number;
  /** Spoken name ("İndiriliyor"); the percentage is announced with it. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const fill = useSharedValue(clamped);

  useEffect(() => {
    fill.value = motionTo(clamped, "standard", { reduced });
  }, [clamped, reduced, fill]);

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        {
          height,
          alignSelf: "stretch",
          borderRadius: radius.pill,
          overflow: "hidden",
          backgroundColor: colors.washStrong,
        },
        style,
      ]}
    >
      <Animated.View
        style={[
          {
            height: "100%",
            width: "100%",
            borderRadius: radius.pill,
            backgroundColor: colors.accent,
            transformOrigin: "left",
          },
          fillStyle,
        ]}
      />
    </View>
  );
}
