/**
 * Raised translucent surface — Koyu Masa's `glass` (rgba(23,23,23,.72) over a
 * 10px blur) for floating chrome: toasts, the mini call bar, pills over media.
 *
 * Platform truth, so nobody is surprised on a device:
 *  - iOS: a real backdrop blur (expo-blur, dark tint) under the glass tone.
 *  - Android: expo-blur can only blur a view it is explicitly pointed at
 *    (`blurTarget`, a BlurTargetView wrapping the content behind) — and never
 *    across windows, so not behind a Modal. Without a target the surface uses
 *    the opaque `glass-strong` tone instead (the design system's own fallback,
 *    "opaque `overlay` without one"), which reads the same at a glance and
 *    costs nothing.
 */
import type { ReactNode, RefObject } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { colors } from "@/theme/theme";

export function Glass({
  children,
  style,
  strong = false,
  blurTarget,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The denser 0.92 glass — menus, tooltips, anything with text over busy media. */
  strong?: boolean;
  /** Android only: the BlurTargetView behind this surface, for a real blur. */
  blurTarget?: RefObject<View | null>;
}) {
  const tone = strong ? colors.glassStrong : colors.glass;
  const canBlur = Platform.OS === "ios" || (Platform.OS === "android" && blurTarget !== undefined);

  if (!canBlur) {
    return <View style={[{ backgroundColor: colors.glassStrong, overflow: "hidden" }, style]}>{children}</View>;
  }

  return (
    <View style={[{ overflow: "hidden" }, style]}>
      <BlurView
        tint="dark"
        intensity={40}
        blurMethod={Platform.OS === "android" ? "dimezisBlurViewSdk31Plus" : undefined}
        blurTarget={blurTarget}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tone }}
      />
      {children}
    </View>
  );
}
