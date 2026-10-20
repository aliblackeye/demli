/**
 * The "dem" light — Koyu Masa's one warm light on the black page (design system
 * §6: "saf siyah üzerinde tek sıcak ışık"; §5 "Parıltılar: radyal accent-glow").
 * A radial coral glow that fades to nothing, drawn BEHIND a brand moment (the
 * boot mark, the sign-in card, the profile card's top band).
 *
 * Drawn with RN's native radial gradient (`experimental_backgroundImage`, New
 * Architecture). It is decoration only: a platform that cannot paint it simply
 * shows the black page, which is the design's own resting state — nothing
 * depends on it, nothing is announced, it never takes a touch.
 *
 * Use it sparingly: one glow per screen, or it stops being "the" light.
 */
import { View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "@/theme/theme";
import { withAlpha } from "./kit-math";

/** Glow colour stops, from the tokens (accent-glow at the centre → clear coral). */
export const GLOW_GRADIENT = `radial-gradient(closest-side, ${colors.accentGlow}, ${withAlpha(colors.accent, 0)})`;

export function Glow({
  size,
  style,
}: {
  /** Diameter of the glow in px. Position it with `style` (absolute). */
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        {
          position: "absolute",
          width: size,
          height: size,
          experimental_backgroundImage: GLOW_GRADIENT,
        },
        style,
      ]}
    />
  );
}
