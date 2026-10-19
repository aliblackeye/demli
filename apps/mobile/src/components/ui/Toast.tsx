/**
 * <Toaster/> — renders the toast queue (toast-store.ts). Mount ONCE, at the app
 * root inside GestureHandlerRootView; call `toast({...})` from anywhere.
 *
 * Koyu Masa toast: the glass surface, radius 16, a variant dot, title + one
 * line, an optional coral text action and a close control. It rises 12px out
 * of a hair of scale on the position spring and sinks 8px on the fast step —
 * the framer `toastPop`, step for step.
 *
 *  - Swipe sideways to dismiss (the Android idiom); a short swipe springs back.
 *  - The timer pauses while a finger is on the toast, so it never vanishes
 *    under someone reading it.
 *  - TalkBack hears it: each new toast is announced (it appears without focus),
 *    and the close control has its own label.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { MOTION_PRESETS, OVERLAY_MOTION, springConfigOf } from "@/theme/motion-presets";
import { colors, motion, radius, space } from "@/theme/theme";
import { Glass } from "./Glass";
import { Text } from "./Text";
import { Touchable } from "./Touchable";
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastRecord,
  type ToastVariant,
} from "./toast-store";

export { toast, dismissToast, type ToastOptions } from "./toast-store";

const DOT: Record<ToastVariant, string> = {
  neutral: colors.fgSubtle,
  success: colors.success,
  accent: colors.accent,
  danger: colors.danger,
};

/** Past this sideways travel (px) or speed (px/s) a release dismisses. */
const SWIPE_DISTANCE = 72;
const SWIPE_VELOCITY = 700;

function ToastItem({ record }: { record: ToastRecord }) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const enter = useSharedValue(0);
  const dx = useSharedValue(0);
  const leaving = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remove = () => dismissToast(record.id);

  const close = () => {
    leaving.value = withTiming(
      1,
      { duration: motion.duration.fast, reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System },
      (done) => {
        if (done) scheduleOnRN(remove);
      },
    );
  };

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    if (Number.isFinite(record.duration)) timer.current = setTimeout(close, record.duration);
  };
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    enter.value = motionTo(1, "position", { reduced });
    AccessibilityInfo.announceForAccessibility(
      record.description ? `${record.title}. ${record.description}` : record.title,
    );
    arm();
    return pause;
    // Mount-only: one toast record, one entrance, one timer.
  }, []);

  const swipe = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onBegin(() => {
      "worklet";
      scheduleOnRN(pause);
    })
    .onUpdate((e) => {
      "worklet";
      dx.value = e.translationX;
    })
    .onEnd((e) => {
      "worklet";
      if (Math.abs(e.translationX) > SWIPE_DISTANCE || Math.abs(e.velocityX) > SWIPE_VELOCITY) {
        const dir = (e.translationX || e.velocityX) > 0 ? 1 : -1;
        dx.value = withSpring(dir * 480, springConfigOf(MOTION_PRESETS.position, e.velocityX), (done) => {
          if (done) scheduleOnRN(remove);
        });
      } else {
        dx.value = motionTo(0, "position", { velocity: e.velocityX });
      }
    })
    .onFinalize(() => {
      "worklet";
      scheduleOnRN(arm);
    });

  const from = OVERLAY_MOTION.toast.from;
  const to = OVERLAY_MOTION.toast.exitTo;
  const style = useAnimatedStyle(() => {
    const e = enter.value;
    const l = leaving.value;
    return {
      opacity: e * (1 - l) * (1 - Math.min(1, Math.abs(dx.value) / 360)),
      transform: [
        { translateX: dx.value },
        { translateY: (1 - e) * from.translateY + l * to.translateY },
        { scale: from.scale + (1 - from.scale) * e },
      ],
    };
  });

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View style={style}>
        <Glass
          strong
          style={{
            borderRadius: radius.xl,
            borderCurve: "continuous",
            flexDirection: "row",
            alignItems: "flex-start",
            gap: space.md,
            paddingVertical: space.md,
            paddingLeft: space.lg,
            paddingRight: space.xs,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              marginTop: 6,
              borderRadius: radius.pill,
              backgroundColor: DOT[record.variant],
            }}
          />
          <View
            accessible
            accessibilityLiveRegion="polite"
            style={{ flex: 1, gap: 2, paddingVertical: 1 }}
          >
            <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>
              {record.title}
            </Text>
            {record.description ? (
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
                {record.description}
              </Text>
            ) : null}
            {record.action ? (
              <Touchable
                onPress={() => {
                  record.action?.onPress();
                  close();
                }}
                accessibilityRole="button"
                accessibilityLabel={record.action.label}
                pressedTone={colors.wash}
                hitSlop={8}
                style={{ alignSelf: "flex-start", marginTop: space.xs, borderRadius: radius.sm, paddingVertical: 2 }}
              >
                <Text style={{ color: colors.accent, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
                  {record.action.label}
                </Text>
              </Touchable>
            ) : null}
          </View>
          <Touchable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel={t("common:buttons.close")}
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
        </Glass>
      </Animated.View>
    </GestureDetector>
  );
}

export function Toaster({ bottomOffset = 72 }: { bottomOffset?: number }) {
  const records = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const insets = useSafeAreaInsets();
  if (records.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: space.md,
        right: space.md,
        bottom: insets.bottom + bottomOffset,
        gap: space.sm,
      }}
    >
      {records.map((r) => (
        <ToastItem key={r.id} record={r} />
      ))}
    </View>
  );
}
