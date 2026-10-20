/**
 * Koyu Masa product button for React Native — the mobile twin of
 * packages/ui `Button`: same five variants, same meaning, borderless, tone on
 * press plus a gentle press scale, 40% when disabled.
 *
 *   primary      white fill, dark ink — the one main action of a screen
 *   secondary    raised tone (#262626)
 *   accent       coral fill, dark ink — the warm call to action (join, invite)
 *   danger       pink wash + pink ink — destructive; never a solid fill, so the
 *                label keeps ≥4.5:1
 *   dangerSolid  pink fill + dark ink — ONLY for the call controls the design
 *                system names (decline, hang up, leave the room)
 *   ghost        no fill until pressed; a translucent white wash
 *   outline      hairline ring, for the legacy bordered button
 *
 * Sizes are touch-first: md is the 44pt minimum, lg the 52pt CTA (radius 18),
 * sm stays compact visually and gets the rest of the 44pt from `hitSlop`.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { PRESS } from "@/theme/motion-presets";
import { colors, radius, space } from "@/theme/theme";
import { withAlpha } from "./kit-math";
import { Text } from "./Text";
import { CLEAR, Touchable, type HapticKind } from "./Touchable";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "accent"
  | "danger"
  | "dangerSolid"
  | "ghost"
  | "outline";

export type ButtonSize = "sm" | "md" | "lg";

/** Rest fill, pressed fill and ink per variant — all from tokens. */
export const BUTTON_TONES: Record<ButtonVariant, { tone: string; pressed: string; ink: string }> = {
  primary: { tone: colors.inverse, pressed: colors.inversePressed, ink: colors.onInverse },
  secondary: { tone: colors.surfaceRaised, pressed: colors.raisedHover, ink: colors.fg },
  accent: { tone: colors.accent, pressed: colors.accentDeep, ink: colors.onAccent },
  danger: { tone: colors.dangerSurface, pressed: withAlpha(colors.danger, 0.28), ink: colors.danger },
  dangerSolid: { tone: colors.danger, pressed: withAlpha(colors.danger, 0.8), ink: colors.onAccent },
  ghost: { tone: CLEAR, pressed: colors.washStrong, ink: colors.fg },
  outline: { tone: CLEAR, pressed: colors.washStrong, ink: colors.fg },
};

const SIZES: Record<
  ButtonSize,
  { height: number; radius: number; padX: number; font: number; icon: number; slop: number }
> = {
  sm: { height: 34, radius: radius.md, padX: space.md, font: 13, icon: 16, slop: 5 },
  md: { height: 44, radius: radius.lg, padX: space.lg, font: 15, icon: 18, slop: 0 },
  lg: { height: 52, radius: radius.cta, padX: space.xl, font: 16, icon: 20, slop: 0 },
};

export type ButtonProps = {
  label?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph, drawn in the variant's ink at the size's icon step. */
  icon?: LucideIcon;
  /** Trailing glyph (a chevron, an external-link mark). */
  trailingIcon?: LucideIcon;
  /** Busy: spinner over the label, width kept, presses blocked, announced as busy. */
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to the container's width. */
  block?: boolean;
  haptic?: HapticKind;
  /** Needed when the button has no visible `label` (children-only content). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Extra content after the label (legacy call sites pass custom rows here). */
  children?: ReactNode;
};

export function Button({
  label,
  onPress,
  onLongPress,
  variant = "accent",
  size = "md",
  icon: Icon,
  trailingIcon: TrailingIcon,
  loading = false,
  disabled = false,
  block = false,
  haptic,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
  children,
}: ButtonProps) {
  const t = BUTTON_TONES[variant];
  const s = SIZES[size];
  const inert = disabled || loading;
  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={inert}
      dimmed={disabled}
      haptic={haptic}
      tone={t.tone}
      pressedTone={t.pressed}
      pressScale={PRESS.scale.button}
      hitSlop={s.slop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: loading }}
      testID={testID}
      style={[
        {
          minHeight: s.height,
          borderRadius: s.radius,
          borderCurve: "continuous",
          paddingHorizontal: s.padX,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          alignSelf: block ? "stretch" : undefined,
        },
        variant === "outline" ? { borderWidth: 1, borderColor: colors.strokeStrong } : null,
        style,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          opacity: loading ? 0 : 1,
        }}
      >
        {Icon ? <Icon size={s.icon} color={t.ink} strokeWidth={2} /> : null}
        {label ? (
          <Text
            selectable={false}
            numberOfLines={1}
            style={{ color: t.ink, fontSize: s.font, fontWeight: "600" }}
          >
            {label}
          </Text>
        ) : null}
        {children}
        {TrailingIcon ? <TrailingIcon size={s.icon} color={t.ink} strokeWidth={2} /> : null}
      </View>
      {loading ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" }}
        >
          <ActivityIndicator color={t.ink} size="small" />
        </View>
      ) : null}
    </Touchable>
  );
}
