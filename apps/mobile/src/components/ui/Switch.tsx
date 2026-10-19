/**
 * Switch — 44×24 track (the design-system size), the thumb travelling on the
 * authored position spring, the track crossfading from raised grey to coral on
 * the tone step. The whole row (when a label is given) is the touch target, so
 * the 24pt-tall track never has to be hit precisely.
 *
 * Announced as a switch with its checked state; TalkBack's double-tap toggles.
 */
import { useEffect } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

const TRACK_W = 44;
const TRACK_H = 24;
const THUMB = 18;
/** Same geometry as the desktop switch: 2px side inset, thumb centred, 22px of travel. */
const SIDE = 2;
const TRAVEL = TRACK_W - THUMB - SIDE * 2;

/** The bare track + thumb, for callers that compose their own row. */
export function SwitchTrack({ value }: { value: boolean }) {
  const reduced = useReducedMotion();
  const pos = useSharedValue(value ? 1 : 0);
  const tone = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    pos.value = motionTo(value ? 1 : 0, "position", { reduced });
    tone.value = motionTo(value ? 1 : 0, "tone", { reduced });
  }, [value, reduced, pos, tone]);

  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [colors.surfaceRaised, colors.accent]),
  }));
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: pos.value * TRAVEL }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: TRACK_W,
          height: TRACK_H,
          borderRadius: radius.pill,
          paddingHorizontal: SIDE,
          justifyContent: "center",
        },
        track,
      ]}
    >
      <Animated.View style={[
          { width: THUMB, height: THUMB, borderRadius: radius.pill, backgroundColor: colors.inverse },
          thumb,
        ]} />
    </Animated.View>
  );
}

export function Switch({
  value,
  onValueChange,
  label,
  description,
  disabled = false,
  style,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** Row label. Without it, pass `accessibilityLabel` via a wrapping row. */
  label?: string;
  description?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Touchable
      onPress={() => {
        haptics.selection();
        onValueChange(!value);
      }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value }}
      pressedTone={colors.wash}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          minHeight: 44,
          paddingVertical: space.sm,
          paddingHorizontal: label ? space.md : 0,
          borderRadius: radius.lg,
        },
        style,
      ]}
    >
      {label ? (
        <View style={{ flex: 1, gap: 2 }}>
          <Text type="body" tone="default" style={{ fontWeight: "500" }}>
            {label}
          </Text>
          {description ? (
            <Text type="meta" tone="faint">
              {description}
            </Text>
          ) : null}
        </View>
      ) : null}
      <SwitchTrack value={value} />
    </Touchable>
  );
}
