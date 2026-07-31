import { View } from "react-native";
import { Text } from "./ui/Text";
import { resolveSystemMessage } from "@demli/i18n";
import { useAppTranslation, toTranslateFn } from "@/lib/i18n";
import { colors, space } from "../theme/theme";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A server-generated notice (member joined/left) — `message.kind === "system"`.
 * Rendered as a centered, dimmed single line with no avatar, author, or retry
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
  const { t } = useAppTranslation();
  const text = resolveSystemMessage(content, authorName, toTranslateFn(t));
  const time = formatTime(createdAt);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.xl,
        paddingVertical: space.xs,
      }}
    >
      <Text
        style={{ flexShrink: 1, color: colors.fgFaint, fontSize: 12, textAlign: "center" }}
      >
        {text}
        {time ? <Text style={{ color: colors.fgFaint }}>{`  ·  ${time}`}</Text> : null}
      </Text>
    </View>
  );
}
