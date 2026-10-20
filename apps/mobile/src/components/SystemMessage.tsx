import { View } from "react-native";
import { Text } from "./ui/Text";
import { resolveSystemMessage } from "@demli/i18n";
import { useAppTranslation, toTranslateFn } from "@/lib/i18n";
import { formatClock } from "./chat/thread-rows";
import { colors, space, typography } from "../theme/theme";

/**
 * A server-generated notice (member joined/left) — `message.kind === "system"`.
 * Rendered as a centered, quiet single line with no avatar, author, or retry
 * affordance, matching the desktop treatment.
 *
 * The API persists a language-neutral token (`@sys:member_joined`) — never human
 * language and never a baked name (ADR 0009 §5). `resolveSystemMessage` turns it
 * into the viewer's language with the CURRENT author name (passed in), and falls
 * back to rendering plain text verbatim (legacy Turkish rows keep working).
 */
export function SystemMessage({
  content,
  authorName,
  createdAt,
}: {
  content: string;
  authorName: string;
  createdAt: string;
}) {
  const { t, i18n } = useAppTranslation();
  const text = resolveSystemMessage(content, authorName, toTranslateFn(t));
  const time = formatClock(createdAt, i18n.language);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: space.xl,
        paddingVertical: space.sm,
      }}
    >
      <Text
        style={{
          flexShrink: 1,
          color: colors.fgMuted,
          fontSize: typography.size.sm,
          lineHeight: 16,
          textAlign: "center",
        }}
      >
        {text}
        {time ? (
          <Text style={{ color: colors.fgFaint, fontVariant: ["tabular-nums"] }}>{`  ·  ${time}`}</Text>
        ) : null}
      </Text>
    </View>
  );
}
