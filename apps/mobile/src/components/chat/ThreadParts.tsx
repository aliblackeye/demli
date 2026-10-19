/**
 * The small, non-message pieces of the mobile chat thread: the day separator,
 * the unread line, the typing dots, the jump-to-latest pill, the older-page
 * footer and the "start of the conversation" header.
 *
 * All Koyu Masa, all tokens: hairlines are the one functional `stroke`, the
 * coral is reserved for what concerns YOU (the unread line, the jump pill's
 * count), and motion is enter/exit only — reduced motion drops it.
 */
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { ArrowDown, Hash, MessagesSquare, RotateCcw } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { useReducedMotion } from "@/theme/motion";
import { colors, motion, radius, space } from "@/theme/theme";
import { Skeleton } from "../Skeleton";
import { Glass } from "../ui/Glass";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { withAlpha } from "../ui/kit-math";
import { dayLabel } from "./thread-rows";

/** Calendar-day separator: hairline · day pill · hairline. */
export function DateDivider({ dayStart }: { dayStart: number }) {
  const { t, i18n } = useAppTranslation();
  const label = useMemo(
    () =>
      dayLabel(dayStart, new Date(), i18n.language, {
        today: t("mobile:chat.dateToday"),
        yesterday: t("mobile:chat.dateYesterday"),
      }),
    [dayStart, i18n.language, t],
  );
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
      <View
        style={{
          marginHorizontal: space.md,
          height: 22,
          justifyContent: "center",
          paddingHorizontal: space.md,
          borderRadius: radius.pill,
          backgroundColor: colors.surface,
        }}
      >
        <Text type="caption" tone="muted">
          {label}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
    </View>
  );
}

/**
 * "New messages start here": a coral hairline ending in a solid coral chip.
 * Coral is the thread's "this is for you" light — the same as a mention of you
 * and your own reactions — so it reads as a place to resume, never an error.
 * The chip text is stored upper-case in the catalog (RN's `textTransform`
 * would turn the Turkish "Yeni" into "YENI").
 */
export function UnreadDivider() {
  const { t } = useAppTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("mobile:chat.newMessagesDivider")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: space.lg,
        paddingVertical: space.xs,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: withAlpha(colors.accent, 0.5) }} />
      <View
        style={{
          marginLeft: space.sm,
          height: 18,
          justifyContent: "center",
          paddingHorizontal: 6,
          borderRadius: radius.pill,
          backgroundColor: colors.accent,
        }}
      >
        <Text type="badge" tone="onAccent" style={{ letterSpacing: 0.4 }}>
          {t("mobile:chat.newChip")}
        </Text>
      </View>
    </View>
  );
}

const DOT_STEP_MS = 600;

function Dot({ index, reduced }: { index: number; reduced: boolean }) {
  const o = useSharedValue(reduced ? 0.6 : 0.25);
  useEffect(() => {
    if (reduced) {
      o.value = 0.6;
      return;
    }
    o.value = withDelay(
      index * 200,
      withRepeat(
        withSequence(
          withTiming(1, { duration: DOT_STEP_MS, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.25, { duration: DOT_STEP_MS, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
        undefined,
        ReduceMotion.System,
      ),
    );
    return () => cancelAnimation(o);
  }, [reduced, index, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      style={[{ width: 5, height: 5, borderRadius: radius.pill, backgroundColor: colors.fgMuted }, style]}
    />
  );
}

/** Three breathing dots (1.2s, staggered) — the design system's typing glyph. */
export function TypingDots() {
  const reduced = useReducedMotion();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
    >
      {[0, 1, 2].map((i) => (
        <Dot key={i} index={i} reduced={reduced} />
      ))}
    </View>
  );
}

/**
 * The floating "back to the newest" pill. With `count > 0` it says how many
 * messages arrived while you were reading back — coral, because they are new
 * for you; otherwise it is the plain neutral "Jump to latest".
 */
export function JumpPill({ count, onPress }: { count: number; onPress: () => void }) {
  const { t } = useAppTranslation();
  const label = count > 0 ? t("mobile:chat.jumpNew", { count }) : t("mobile:chat.jumpToLatest");
  const ink = count > 0 ? colors.accent : colors.fg;
  return (
    <Animated.View
      entering={FadeInUp.springify()
        .stiffness(motion.spring.position.stiffness)
        .damping(motion.spring.position.damping)
        .mass(motion.spring.position.mass)
        .reduceMotion(ReduceMotion.System)}
      exiting={FadeOutDown.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
    >
      <Glass strong style={{ borderRadius: radius.pill }}>
        <Touchable
          onPress={onPress}
          haptic="light"
          accessibilityRole="button"
          accessibilityLabel={label}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs + 2,
            minHeight: 40,
            paddingHorizontal: space.lg,
            borderRadius: radius.pill,
          }}
        >
          <ArrowDown size={16} color={ink} strokeWidth={2.25} />
          <Text type="ui" style={{ color: ink, fontWeight: "600" }}>
            {label}
          </Text>
        </Touchable>
      </Glass>
    </Animated.View>
  );
}

/**
 * The older-page footer (it renders at the TOP of the inverted list): two
 * skeleton rows while the page loads, an honest inline error with a retry when
 * it failed, nothing otherwise.
 */
export function OlderPageFooter({
  loading,
  failed,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();
  if (failed && !loading) {
    return (
      <View
        accessibilityRole="alert"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm,
          paddingVertical: space.md,
          paddingHorizontal: space.lg,
        }}
      >
        <Text type="meta" tone="muted" style={{ flexShrink: 1 }}>
          {t("mobile:chat.olderFailed")}
        </Text>
        <Touchable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t("buttons.retry")}
          hitSlop={8}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: space.sm,
            paddingVertical: 4,
            borderRadius: radius.sm,
          }}
        >
          <RotateCcw size={13} color={colors.accent} />
          <Text type="meta" tone="accent" style={{ fontWeight: "600" }}>
            {t("buttons.retry")}
          </Text>
        </Touchable>
      </View>
    );
  }
  if (!loading) return null;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("mobile:ui.loading")}
      style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.lg }}
    >
      {[0, 1].map((i) => (
        <View key={i} style={{ flexDirection: "row", gap: space.md }}>
          <Skeleton width={36} height={36} radius={radius.pill} />
          <View style={{ flex: 1, gap: space.sm, paddingTop: 2 }}>
            <Skeleton width={i === 0 ? "30%" : "24%"} height={11} />
            <Skeleton width={i === 0 ? "72%" : "58%"} height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The top of a fully loaded channel or group chat: what you are reading and
 * that there is nothing further up. A DM shows its own peer card instead.
 */
export function ConversationStart({ name, kind }: { name: string; kind: "channel" | "group" }) {
  const { t } = useAppTranslation();
  const Icon = kind === "channel" ? Hash : MessagesSquare;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.md, gap: space.sm }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: radius.pill,
          backgroundColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: space.xs,
        }}
      >
        <Icon size={26} color={colors.fgMuted} />
      </View>
      <Text type="title" tone="display" accessibilityRole="header" numberOfLines={2}>
        {kind === "channel" ? `#${name}` : name}
      </Text>
      <Text type="ui" tone="muted" style={{ fontWeight: "400" }}>
        {kind === "channel"
          ? t("mobile:chat.channelStart", { name })
          : t("mobile:chat.groupStart")}
      </Text>
    </View>
  );
}
