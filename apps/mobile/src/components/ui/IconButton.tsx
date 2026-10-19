/**
 * Icon-only button — the mobile twin of packages/ui `IconButton` + Tooltip.
 *
 * The label is REQUIRED: it is the accessible name (an icon alone says nothing
 * to TalkBack) and it is the tooltip a long press shows, Android's own idiom
 * for "what does this glyph do?". A caller with a real long-press action passes
 * `onLongPress` and the tooltip steps aside.
 *
 * `active` turns it into a toggle (mute, camera, deafen): announced as
 * selected, drawn in the variant's active tone.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import type { LucideIcon } from "lucide-react-native";
import { PRESS } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { withAlpha } from "./kit-math";
import { Text } from "./Text";
import { CLEAR, Touchable, type HapticKind } from "./Touchable";

export type IconButtonVariant =
  | "ghost"
  | "secondary"
  | "accent"
  | "danger"
  | "dangerSolid"
  | "veil";

export type IconButtonSize = "sm" | "md" | "lg" | "xl";

const TONES: Record<
  IconButtonVariant,
  { tone: string; pressed: string; ink: string; activeTone: string; activeInk: string }
> = {
  ghost: {
    tone: CLEAR,
    pressed: colors.washStrong,
    ink: colors.fgMuted,
    activeTone: colors.accentSurface,
    activeInk: colors.accent,
  },
  secondary: {
    tone: colors.surfaceRaised,
    pressed: colors.raisedHover,
    ink: colors.fg,
    activeTone: colors.inverse,
    activeInk: colors.onInverse,
  },
  accent: {
    tone: colors.accent,
    pressed: colors.accentDeep,
    ink: colors.onAccent,
    activeTone: colors.accentDeep,
    activeInk: colors.onAccent,
  },
  danger: {
    tone: colors.dangerSurface,
    pressed: withAlpha(colors.danger, 0.28),
    ink: colors.danger,
    activeTone: colors.danger,
    activeInk: colors.onAccent,
  },
  dangerSolid: {
    tone: colors.danger,
    pressed: withAlpha(colors.danger, 0.8),
    ink: colors.onAccent,
    activeTone: colors.danger,
    activeInk: colors.onAccent,
  },
  /** Over video / images: the translucent veil pill. */
  veil: {
    tone: colors.veil,
    pressed: withAlpha(colors.rail, 0.4),
    ink: colors.fgDisplay,
    activeTone: colors.inverse,
    activeInk: colors.onInverse,
  },
};

/** Box size, glyph size, and the slop that brings every size to ≥44pt. */
const SIZES: Record<IconButtonSize, { box: number; icon: number; slop: number }> = {
  sm: { box: 32, icon: 16, slop: 6 },
  md: { box: 40, icon: 20, slop: 2 },
  lg: { box: 48, icon: 22, slop: 0 },
  xl: { box: 56, icon: 24, slop: 0 },
};

const TOOLTIP_MS = 1500;

export type IconButtonProps = {
  icon: LucideIcon;
  /** Accessible name + long-press tooltip. */
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Round (call controls, media) or rounded-square (toolbars). */
  shape?: "circle" | "square";
  /** Drawn in the variant's active tone (a selected tool, a live control). */
  active?: boolean;
  /**
   * The button flips a setting (mute, camera): announced as a toggle with its
   * on/off state instead of as a plain button.
   */
  toggle?: boolean;
  disabled?: boolean;
  haptic?: HapticKind;
  /** A small counter / dot in the corner (a pending count, a live marker). */
  badge?: ReactNode;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({
  icon: Icon,
  label,
  onPress,
  onLongPress,
  variant = "ghost",
  size = "md",
  shape = "circle",
  active = false,
  toggle = false,
  disabled = false,
  haptic,
  badge,
  accessibilityHint,
  testID,
  style,
}: IconButtonProps) {
  const t = TONES[variant];
  const s = SIZES[size];
  const [tip, setTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const showTip = () => {
    setTip(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip(false), TOOLTIP_MS);
  };

  return (
    <View style={[{ alignItems: "center" }, style]}>
      <Touchable
        onPress={onPress}
        onLongPress={onLongPress ?? showTip}
        disabled={disabled}
        haptic={haptic}
        tone={active ? t.activeTone : t.tone}
        pressedTone={t.pressed}
        pressScale={PRESS.scale.icon}
        hitSlop={s.slop}
        accessibilityRole={toggle ? "togglebutton" : "button"}
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={toggle ? { checked: active } : { selected: active }}
        testID={testID}
        style={{
          width: s.box,
          height: s.box,
          borderRadius: shape === "circle" ? radius.pill : radius.lg,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={s.icon} color={active ? t.activeInk : t.ink} strokeWidth={2} />
      </Touchable>
      {badge ? (
        <View pointerEvents="none" style={{ position: "absolute", top: -2, right: -2 }}>
          {badge}
        </View>
      ) : null}
      {tip ? (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            bottom: s.box + space.sm,
            backgroundColor: colors.glassStrong,
            borderRadius: radius.sm,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
            maxWidth: 200,
          }}
        >
          <Text type="meta" tone="default" numberOfLines={2} style={{ textAlign: "center" }}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
