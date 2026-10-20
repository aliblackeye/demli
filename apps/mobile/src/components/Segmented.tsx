import { useEffect, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, radius, space } from "../theme/theme";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

const PAD = 3;
const GAP = 3;

/**
 * Two-or-more-way segmented control. Used on the home screen to switch between
 * Servers (multi-channel spaces) and Groups (flat chats) — two distinct social
 * shapes that share one list surface (ADR 0005).
 *
 * Koyu Masa: a borderless surface well with ONE raised pill that travels to the
 * chosen segment on the authored position spring — the selection moves, the
 * labels stay put. Announced as a tab list; each segment is a tab with its
 * selected state.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the control for screen readers ("Liste türü"). */
  accessibilityLabel?: string;
}) {
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const count = Math.max(1, options.length);
  const segment = width > 0 ? (width - PAD * 2 - GAP * (count - 1)) / count : 0;
  const x = useSharedValue(0);
  const placed = useSharedValue(false);

  useEffect(() => {
    if (segment <= 0) return;
    const target = index * (segment + GAP);
    // First measurement: jump into place — the pill must not fly in from 0.
    x.value = placed.value ? motionTo(target, "position", { reduced }) : target;
    placed.value = true;
  }, [index, segment, reduced, x, placed]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={{
        flexDirection: "row",
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        padding: PAD,
        gap: GAP,
      }}
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: PAD,
              bottom: PAD,
              left: PAD,
              width: segment,
              borderRadius: radius.md,
              borderCurve: "continuous",
              backgroundColor: colors.surfaceRaised,
            },
            pill,
          ]}
        />
      ) : null}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Touchable
            key={opt.value}
            onPress={() => {
              if (active) return;
              haptics.selection();
              onChange(opt.value);
            }}
            accessibilityRole="tab"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: active }}
            pressedTone={colors.wash}
            style={{
              flex: 1,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.md,
              borderCurve: "continuous",
              paddingHorizontal: space.sm,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: active ? colors.fg : colors.fgMuted,
                fontSize: 14,
                fontWeight: active ? "600" : "500",
              }}
            >
              {opt.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
