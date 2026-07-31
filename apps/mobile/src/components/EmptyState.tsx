import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./ui/Text";
import { colors, radius, space } from "../theme/theme";

/**
 * Centered empty/placeholder block for lists with no data yet — the mobile
 * mirror of packages/app-ui's EmptyState: a muted glyph in a soft circle, a
 * title, a supporting line, optionally a call-to-action. One composed pattern
 * so every empty list on the two platforms reads the same (the text-only
 * mobile version was one of the "feels like a different app" gaps).
 */
export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  /** A lucide glyph (size ~22, colors.fgMuted at the call site) shown in the
      icon circle. Optional so dense inline placeholders can stay text-only. */
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.sm }}>
      {icon ? (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: radius.pill,
            backgroundColor: colors.surfaceRaised,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: space.xs,
          }}
        >
          {icon}
        </View>
      ) : null}
      <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700", textAlign: "center" }}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
          {subtitle}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
    </View>
  );
}
