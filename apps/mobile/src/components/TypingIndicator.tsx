import { View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import type { ChannelId } from "@demli/types";
import { useChatStore } from "../stores/chat-store";
import { colors, motion, space } from "../theme/theme";
import { TypingDots } from "./chat/ThreadParts";

/** The reserved line height — the list above never jumps as typing comes and goes. */
const TYPING_LINE_HEIGHT = 20;

/**
 * "X is typing…" line for the active channel: three breathing dots and the
 * names. Reads only the typing map + users directory, so message rows never
 * rerender when a typing entry ticks (§27). Its height is ALWAYS reserved, so
 * the line appearing or leaving never moves the thread; the content itself
 * fades in and out on the fast step (instant under reduced motion).
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
      ? null
      : names.length === 1
        ? t("mobile:typing.one", { name: names[0] })
        : names.length === 2
          ? t("mobile:typing.two", { name1: names[0], name2: names[1] })
          : t("mobile:typing.many");

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ height: TYPING_LINE_HEIGHT, justifyContent: "center", paddingHorizontal: space.lg }}
    >
      {label ? (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.duration.instant).reduceMotion(ReduceMotion.System)}
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
        >
          <TypingDots />
          <Text numberOfLines={1} type="meta" style={{ flexShrink: 1, color: colors.fgMuted, fontWeight: "400" }}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
