/**
 * The label above every grouped list on the phone — channel sections and
 * categories, the Home "group chats" heading, the friends Incoming/Sent counts,
 * the command palette's sections. The mobile twin of the desktop
 * `SectionHeading` (packages/app-ui), so the two shells label a list the same way.
 *
 * Koyu Masa recipe (the landing's `BolumEtiketi`): 13px, medium weight, the
 * catalog's own sentence case — no forced uppercase, no letter-spacing. A list
 * of names is quiet; an all-caps label was the one loud thing in it.
 * `fgFaint` (#8f8f8f) holds AA on every column tone; `tone="muted"` lifts it a
 * step for a heading that carries a count.
 *
 * Announced as a header so TalkBack's heading navigation jumps section to section.
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { colors, space, typography } from "@/theme/theme";
import { Text } from "./Text";

export function SectionHeading({
  children,
  tone = "faint",
  trailing,
  style,
}: {
  /** Already-localized text. */
  children: string;
  tone?: "faint" | "muted";
  /** A control on the heading's right (a "+" for the section, a manage menu). */
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          minHeight: trailing ? 44 : undefined,
          paddingTop: space.lg,
          paddingBottom: space.xs + 2,
          gap: space.sm,
        },
        style,
      ]}
    >
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          flex: 1,
          color: tone === "muted" ? colors.fgMuted : colors.fgFaint,
          fontSize: typography.size.label,
          lineHeight: 18,
          fontWeight: "500",
          letterSpacing: -0.13,
        }}
      >
        {children}
      </Text>
      {trailing}
    </View>
  );
}
