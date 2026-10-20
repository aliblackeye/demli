import { useEffect, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Text } from "./ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, MessageCircle, UserPlus, X } from "lucide-react-native";
import { toTranslateFn, useAppTranslation } from "@/lib/i18n";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { OVERLAY_MOTION } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { bannerRelease } from "./in-app-banner-gesture";
import { Glass } from "./ui/Glass";
import { rubberBand } from "./ui/kit-math";
import { Touchable } from "./ui/Touchable";
import {
  useInAppNotificationStore,
  type InAppNotificationKind,
} from "@/stores/in-app-notification-store";

/** How long a banner stays before it slides away (paused while a finger is on it). */
const VISIBLE_MS = 4500;

/** Per-kind glyph. */
function kindIcon(kind: InAppNotificationKind) {
  if (kind === "friend-accepted") return Check;
  if (kind === "message") return MessageCircle;
  return UserPlus;
}

/**
 * The single foreground in-app banner (founder: friend requests had NO visible
 * feedback while the app was open). Mounted once, globally, in the authed layout
 * — next to the VoiceMiniBar — so it floats over every authed screen, and routes
 * to the relevant surface on tap.
 *
 * Koyu Masa: a raised glass card (no border, no lift shadow) that drops in from
 * just above on the authored position spring (`bannerDrop` — it arrives, it does
 * not bounce) and leaves on the fast step. A flick UP dismisses it (the way a
 * notification is put away on a phone); a downward pull rubber-bands. The timer
 * pauses while a finger is on it. A newer banner replaces the current one and
 * replays the arrival. Reduced motion: it appears and leaves without travel.
 *
 * The store holds i18n keys; this component resolves them (it has the
 * translator the realtime layer lacks).
 */
export function InAppNotificationBanner() {
  const { t } = useAppTranslation();
  // The notification's keys are dynamic (chosen by the realtime layer), so the
  // strictly-typed `t` can't accept them directly — resolve them through the
  // codebase's sanctioned loose translator (same escape hatch as system messages).
  const translate = toTranslateFn(t);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const current = useInAppNotificationStore((s) => s.current);
  const dismiss = useInAppNotificationStore((s) => s.dismiss);

  const enter = useSharedValue(0);
  const dy = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const id = current?.id;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Slide away, then clear THIS banner (a newer one that replaced it is left alone). */
  const leave = (leavingId: string) => {
    clearTimer();
    enter.value = withTiming(
      0,
      { duration: motion.duration.fast, reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System },
      (done) => {
        if (done) scheduleOnRN(dismiss, leavingId);
      },
    );
  };

  const arm = () => {
    clearTimer();
    // Only for the banner still on screen: a gesture that finalizes after a tap
    // already dismissed it (or a newer one replaced it) must not start a timer
    // that would slide the NEXT banner away early.
    if (id && useInAppNotificationStore.getState().current?.id === id) {
      timer.current = setTimeout(() => leave(id), VISIBLE_MS);
    }
  };

  useEffect(() => {
    if (!id) return;
    // A replacement resets to the hidden state, then arrives.
    dy.value = 0;
    enter.value = 0;
    enter.value = motionTo(1, "position", { reduced });
    arm();
    return clearTimer;
    // Keyed on the banner id: each new banner gets one arrival and one timer.
  }, [id]);

  useEffect(() => {
    if (!current) return;
    const title = current.titleText ?? (current.titleKey ? translate(current.titleKey) : "");
    const body =
      current.bodyText ?? (current.bodyKey ? translate(current.bodyKey, current.bodyParams) : "");
    AccessibilityInfo.announceForAccessibility(body ? `${title}. ${body}` : title);
    // Announce once per banner id.
  }, [id]);

  const swipe = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-16, 16])
    .onBegin(() => {
      "worklet";
      scheduleOnRN(clearTimer);
    })
    .onUpdate((e) => {
      "worklet";
      dy.value = e.translationY < 0 ? e.translationY : rubberBand(e.translationY, 80);
    })
    // onFinalize, not onEnd: it runs for EVERY ending (an activated pan, a failed
    // one — a sideways swipe — and an OS cancel), so the timer paused in onBegin
    // is always either restarted or replaced by the dismissal.
    .onFinalize((e, success) => {
      "worklet";
      if (id && bannerRelease(success, e.translationY, e.velocityY) === "dismiss") {
        dy.value = motionTo(-160, "position", { velocity: e.velocityY, reduced });
        scheduleOnRN(leave, id);
      } else {
        dy.value = motionTo(0, "position", { velocity: e.velocityY, reduced });
        scheduleOnRN(arm);
      }
    });

  const from = OVERLAY_MOTION.banner.from;
  const style = useAnimatedStyle(() => ({
    opacity: enter.value * (1 - Math.min(1, Math.max(0, -dy.value) / 140)),
    transform: [{ translateY: (1 - enter.value) * from.translateY + dy.value }],
  }));

  if (!current) return null;

  const Icon = kindIcon(current.kind);
  const accepted = current.kind === "friend-accepted";
  // Title/body come from a raw string (message banners) or an i18n key (social).
  const title = current.titleText ?? (current.titleKey ? translate(current.titleKey) : "");
  const body = current.bodyText ?? (current.bodyKey ? translate(current.bodyKey, current.bodyParams) : "");

  const onPress = () => {
    clearTimer();
    dismiss(current.id);
    if (current.href) router.push(current.href as never);
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + space.xs,
        left: space.md,
        right: space.md,
        // Above the native header + the voice mini bar.
        zIndex: 1000,
        elevation: 24,
      }}
    >
      <GestureDetector gesture={swipe}>
        <Animated.View style={style}>
          <Glass strong style={{ borderRadius: radius.xl, borderCurve: "continuous" }}>
            <Touchable
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel={body ? `${title}. ${body}` : title}
              accessibilityHint={t("mobile:home.bannerSwipeHintA11y")}
              pressedTone={colors.wash}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                paddingVertical: space.md,
                paddingLeft: space.md,
                paddingRight: space.xs,
              }}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: accepted ? colors.online : colors.accent,
                }}
              >
                {/* Both plate colours (green / coral) are light, so the glyph is
                    the dark on-accent ink rather than white. */}
                <Icon size={18} color={colors.onAccent} strokeWidth={2.2} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>
                  {title}
                </Text>
                {body ? (
                  <Text numberOfLines={2} style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
                    {body}
                  </Text>
                ) : null}
              </View>
              <Touchable
                onPress={() => leave(current.id)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:friends.notif.dismiss")}
                pressedTone={colors.washStrong}
                hitSlop={6}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <X size={16} color={colors.fgMuted} strokeWidth={2} />
              </Touchable>
            </Touchable>
          </Glass>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
