import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import type { ChannelId } from "@demli/types";
import { useChatStore } from "../stores/chat-store";
import { colors, space } from "../theme/theme";

/**
 * "X is typing…" line for the active channel. Reads only the typing map + users
 * directory, so message rows never rerender when a typing entry ticks.
 */
export function TypingIndicator({ channelId }: { channelId: ChannelId }) {
  const { t } = useAppTranslation();
  const typing = useChatStore((s) => s.typing[channelId]);
  const users = useChatStore((s) => s.users);

  const names = Object.keys(typing ?? {}).map(
    (userId) => users[userId]?.displayName ?? users[userId]?.username ?? t("mobile:typing.someone"),
  );

  const label =
    names.length === 0
      ? " "
      : names.length === 1
        ? t("mobile:typing.one", { name: names[0] })
        : names.length === 2
          ? t("mobile:typing.two", { name1: names[0], name2: names[1] })
          : t("mobile:typing.many");

  return (
    <View style={{ height: 18, justifyContent: "center", paddingHorizontal: space.lg }}>
      <Text style={{ color: colors.fgMuted, fontSize: 12, fontStyle: "italic" }}>{label}</Text>
    </View>
  );
}
