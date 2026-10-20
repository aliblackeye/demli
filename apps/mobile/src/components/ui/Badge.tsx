/**
 * Badges — the mobile twins of packages/ui `Badge` and `CountBadge`.
 *
 * Badge: a small status / label pill. Text carries the meaning; the colour only
 * reinforces it. CountBadge: the unread / mention counter, tabular figures so
 * the width does not jitter as the number changes, nothing at all for 0.
 */
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { ZoomIn, ZoomOut, ReduceMotion } from "react-native-reanimated";
import { colors, elevation, motion, radius, space, typography } from "@/theme/theme";
import { formatCount, withAlpha } from "./kit-math";
import { Text } from "./Text";

export type BadgeVariant = "neutral" | "accent" | "success" | "warning" | "danger" | "veil";

const BADGE: Record<BadgeVariant, { bg: string; ink: string }> = {
  neutral: { bg: withAlpha(colors.inverse, 0.12), ink: colors.fg },
  accent: { bg: colors.accentSurface, ink: colors.accentHover },
  success: { bg: withAlpha(colors.success, 0.12), ink: colors.success },
  warning: { bg: withAlpha(colors.warning, 0.12), ink: colors.warning },
  danger: { bg: colors.dangerSurface, ink: colors.danger },
  veil: { bg: colors.veil, ink: colors.fg },
};


export function Badge({
  label,
  variant = "neutral",
  style,
}: {
  label: string;
  variant?: BadgeVariant;
  style?: StyleProp<ViewStyle>;
}) {
  const b = BADGE[variant];
  return (
    <View
      style={[
        {
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: b.bg,
          borderRadius: radius.pill,
          paddingHorizontal: space.sm,
          paddingVertical: 2,
        },
        variant === "veil" ? elevation.pillInset : null,
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        style={{ color: b.ink, fontSize: typography.size.sm, lineHeight: 16, fontWeight: "500" }}
      >
        {label}
      </Text>
    </View>
  );
}

export type CountTone = "accent" | "neutral" | "muted" | "danger";

const COUNT: Record<CountTone, { bg: string; ink: string }> = {
  /** Mentions and every row badge — coral, dark ink (7.5:1). */
  accent: { bg: colors.accent, ink: colors.onAccent },
  /** Plain unread where a mention must still read stronger — white, dark ink. */
  neutral: { bg: colors.inverse, ink: colors.onInverse },
  /** A muted channel's count — present, but asks for nothing. */
  muted: { bg: colors.surfaceRaised, ink: colors.fgMuted },
  /** Missed calls — the pink fill takes dark ink too (white is 2.6:1). */
  danger: { bg: colors.danger, ink: colors.onAccent },
};

/**
 * Pill for a pre-formatted counter string. Presentation only — callers that
 * compute their own text (the "no fake number" rule in `unreadBadgeText`) use
 * this; everyone else uses {@link CountBadge}.
 */
export function CountPill({
  text,
  tone = "accent",
  label,
  style,
}: {
  text: string;
  tone?: CountTone;
  /** Spoken form ("3 okunmamış mesaj"). Without it the pill is decorative. */
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const c = COUNT[tone];
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? "text" : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={[
        {
          minWidth: 20,
          height: 20,
          borderRadius: radius.pill,
          paddingHorizontal: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.bg,
        },
        style,
      ]}
    >
      <Text
        selectable={false}
        style={{
          color: c.ink,
          fontSize: typography.size["2xs"],
          lineHeight: 14,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * Numeric counter that renders nothing for 0 and "{max}+" above `max`. It pops
 * in when a count first appears and out when it is cleared — the one moment a
 * counter's arrival is information.
 */
export function CountBadge({
  count,
  max = 99,
  tone = "accent",
  label,
  style,
}: {
  count: number;
  max?: number;
  tone?: CountTone;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const text = formatCount(count, max);
  if (text === null) return null;
  return (
    <Animated.View
      entering={ZoomIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      exiting={ZoomOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
    >
      <CountPill text={text} tone={tone} label={label} style={style} />
    </Animated.View>
  );
}

/** Small solid status dot (a live marker, an unread dot without a number). */
export function Dot({
  color = colors.accent,
  size = 8,
  ringColor,
}: {
  color?: string;
  size?: number;
  /** Cut-out ring in the surface colour behind, when the dot overlaps media. */
  ringColor?: string;
}) {
  return (
    <View
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: radius.pill,
        backgroundColor: color,
        borderWidth: ringColor ? 2 : 0,
        borderColor: ringColor,
      }}
    />
  );
}
