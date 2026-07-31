import { View } from "react-native";
import { Text } from "../ui/Text";
import { colors, typography } from "../../theme/theme";

/**
 * The small numeric unread badge (#110) shared by every Home surface — DM/channel
 * rows, the server rail avatar, the group list. A pill that hugs its text: a
 * ~20px circle for one digit, widening for "12" / "99+" / "1+". The text is
 * produced upstream by `unreadBadgeText` (the "no fake number" rule lives there);
 * this component is presentation only.
 *
 * Two tones: `accent` (blurple, the default — mentions and every row badge) and
 * `neutral` (a light chip with dark text, used for the rail's plain-unread badge
 * so a mention still reads as stronger, mirroring the old dot's fg-vs-accent).
 */
export function UnreadCountBadge({
  text,
  tone = "accent",
  a11yLabel,
}: {
  text: string;
  tone?: "accent" | "neutral";
  a11yLabel?: string;
}) {
  const accent = tone === "accent";
  return (
    <View
      accessibilityLabel={a11yLabel}
      style={{
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: accent ? colors.accent : colors.fg,
      }}
    >
      <Text
        style={{
          // Both branches are LIGHT fills, so both take dark ink. The Demli
          // accent is a light orange — white here reads at ~1.9:1.
          color: accent ? colors.onAccent : colors.app,
          fontSize: typography.size["2xs"],
          fontWeight: "800",
          fontVariant: ["tabular-nums"],
        }}
      >
        {text}
      </Text>
    </View>
  );
}
