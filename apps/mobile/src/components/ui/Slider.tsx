/**
 * Slider — the mobile twin of packages/ui `Slider` (per-user volume, stream
 * quality, any range): a 4px raised rail, the coral fill, a white thumb with a
 * dark ring, and an optional value chip in the white-12% pill.
 *
 * Driven entirely on the UI thread (gesture-handler Pan + Tap → Reanimated), so
 * dragging stays at frame rate even while the JS thread renders a busy room;
 * the React value is only told when the STEPPED value actually changes.
 *
 *  - Drag horizontally to scrub; tap anywhere on the rail to jump.
 *  - A vertical swipe is left to the surrounding ScrollView (`failOffsetY`), so
 *    a slider in a settings list never steals the page scroll.
 *  - TalkBack: an adjustable control with min/max/now, swipe up/down steps it.
 */
import { useCallback, useEffect, useRef } from "react";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motionTo, pressTo, useReducedMotion } from "@/theme/motion";
import { colors, radius, space, typography } from "@/theme/theme";
import { fractionOf, snapToStep, valueAt, withAlpha } from "./kit-math";
import { Text } from "./Text";

const RAIL = 4;
const THUMB = 20;
const TOUCH_H = 44;

export function Slider({
  value,
  onValueChange,
  onSlidingComplete,
  min = 0,
  max = 1,
  step = 0,
  disabled = false,
  accessibilityLabel,
  formatValue,
  showValue = false,
  style,
}: {
  value: number;
  /** Fires on every stepped change while dragging. */
  onValueChange: (value: number) => void;
  /** Fires once when the finger lifts — commit expensive work here. */
  onSlidingComplete?: (value: number) => void;
  min?: number;
  max?: number;
  /** 0 = continuous. */
  step?: number;
  disabled?: boolean;
  /** What is being adjusted ("Ses düzeyi: Ali"). */
  accessibilityLabel: string;
  /** Display + spoken form of a value ("%80"). Default: the raw number. */
  formatValue?: (value: number) => string;
  /** Show the value chip at the end of the rail. */
  showValue?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const width = useSharedValue(0);
  const frac = useSharedValue(fractionOf(value, min, max));
  const dragging = useSharedValue(false);
  const thumbScale = useSharedValue(1);
  const last = useSharedValue(value);

  // Follow the controlled value whenever the finger is not on the rail.
  useEffect(() => {
    if (dragging.value) return;
    last.value = value;
    frac.value = motionTo(fractionOf(value, min, max), "position", { reduced });
  }, [value, min, max, reduced, dragging, frac, last]);

  // Stable JS-side callbacks for the worklets to schedule.
  const changeRef = useRef(onValueChange);
  const completeRef = useRef(onSlidingComplete);
  changeRef.current = onValueChange;
  completeRef.current = onSlidingComplete;
  const emitChange = useCallback((v: number) => changeRef.current(v), []);
  const emitComplete = useCallback((v: number) => completeRef.current?.(v), []);

  // Gesture x is measured from the padded touch box; the rail starts THUMB/2 in.
  const seek = (touchX: number) => {
    "worklet";
    const v = valueAt(touchX - THUMB / 2, width.value, min, max, step);
    frac.value = fractionOf(v, min, max);
    if (v !== last.value) {
      last.value = v;
      scheduleOnRN(emitChange, v);
    }
  };

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onStart((e) => {
      "worklet";
      dragging.value = true;
      thumbScale.value = pressTo(1.15, reduced);
      seek(e.x);
    })
    .onUpdate((e) => {
      "worklet";
      seek(e.x);
    })
    .onFinalize(() => {
      "worklet";
      if (!dragging.value) return;
      dragging.value = false;
      thumbScale.value = pressTo(1, reduced);
      scheduleOnRN(emitComplete, last.value);
    });

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onEnd((e, success) => {
      "worklet";
      if (!success) return;
      seek(e.x);
      scheduleOnRN(emitComplete, last.value);
    });

  const gesture = Gesture.Race(pan, tap);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -(1 - frac.value) * width.value }],
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: frac.value * width.value - THUMB / 2 }, { scale: thumbScale.value }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  const format = formatValue ?? ((v: number) => String(v));
  const a11yStep = step > 0 ? step : (max - min) / 10;
  const stepBy = (dir: 1 | -1) => {
    const next = snapToStep(value + dir * a11yStep, min, max, step);
    if (next === value) return;
    onValueChange(next);
    onSlidingComplete?.(next);
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      accessibilityValue={{ min, max, now: value, text: format(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (disabled) return;
        if (e.nativeEvent.actionName === "increment") stepBy(1);
        if (e.nativeEvent.actionName === "decrement") stepBy(-1);
      }}
      style={[{ flexDirection: "row", alignItems: "center", gap: space.md, opacity: disabled ? 0.4 : 1 }, style]}
    >
      <GestureDetector gesture={gesture}>
        {/* Horizontal padding keeps the thumb's half-width inside the touch area. */}
        <View style={{ flex: 1, height: TOUCH_H, justifyContent: "center", paddingHorizontal: THUMB / 2 }}>
          <View onLayout={onLayout} style={{ height: THUMB, justifyContent: "center" }}>
            <View
              style={{
                height: RAIL,
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceRaised,
                overflow: "hidden",
              }}
            >
              <Animated.View
                style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.accent }, fillStyle]}
              />
            </View>
            <Animated.View
              style={[
                {
                  position: "absolute",
                  left: 0,
                  width: THUMB,
                  height: THUMB,
                  borderRadius: radius.pill,
                  backgroundColor: colors.inverse,
                  borderWidth: 2,
                  borderColor: colors.app,
                },
                thumbStyle,
              ]}
            />
          </View>
        </View>
      </GestureDetector>
      {showValue ? (
        <View
          importantForAccessibility="no-hide-descendants"
          style={{
            minWidth: 48,
            borderRadius: radius.pill,
            backgroundColor: withAlpha(colors.inverse, 0.12),
            paddingHorizontal: space.sm,
            paddingVertical: 2,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: colors.fg,
              fontSize: typography.size.sm,
              lineHeight: 16,
              fontWeight: "500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {format(value)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
