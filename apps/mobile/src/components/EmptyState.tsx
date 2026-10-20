import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { colors, motion, radius, space } from "../theme/theme";
import { Text } from "./ui/Text";

/**
 * Centred empty / error block for a list or a screen with nothing to show —
 * the mobile mirror of packages/app-ui's EmptyState and the design-system
 * recipe: a 48px glyph disc, an Onest title, one supporting line, optionally a
 * call to action.
 *
 * `tone="error"` is the same block for a failed load: the disc takes the
 * danger wash so "nothing here" and "could not load" never look alike, and the
 * block is announced as an alert. The copy (what happened → what you can do)
 * stays the caller's, from the i18n catalogs.
 *
 * It settles in on the arrival curve — an empty state replacing a skeleton is
 * new content, and the fade keeps that swap from reading as a flash.
 */
export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  tone = "neutral",
  compact = false,
}: {
  /** A lucide glyph (size ~22, colors.fgMuted — or colors.danger for errors). */
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  tone?: "neutral" | "error";
  /** Inline use inside a sheet or a short list: tighter padding, smaller title. */
  compact?: boolean;
}) {
  const error = tone === "error";
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.arrival).reduceMotion(ReduceMotion.System)}
      accessibilityRole={error ? "alert" : undefined}
      style={{
        alignItems: "center",
        justifyContent: "center",
        padding: compact ? space.lg : space.xl,
        gap: space.sm,
      }}
    >
      {icon ? (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: radius.pill,
            backgroundColor: error ? colors.dangerSurface : colors.surface,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: space.xs,
          }}
        >
          {icon}
        </View>
      ) : null}
      <Text
        variant="display"
        style={{
          color: colors.fgDisplay,
          fontSize: compact ? 16 : 18,
          lineHeight: compact ? 22 : 24,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            color: colors.fgMuted,
            fontSize: 14,
            lineHeight: 20,
            textAlign: "center",
            maxWidth: 320,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
    </Animated.View>
  );
}
