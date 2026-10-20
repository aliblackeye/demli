/**
 * Checkbox and Radio — the mobile twins of packages/ui `Checkbox` / `RadioGroup`.
 *
 *   Checkbox  20px, radius 6; off = raised tone, on/mixed = coral with dark ink.
 *             The mark pops in on the press spring so the change is felt.
 *   Radio     20px circle; on = coral with a 7px dark dot. A RadioRow's selected
 *             state is the coral-wash row (accent-soft), per the design system.
 *
 * The visual box is small; the ROW is the target (≥44pt), and carries the role
 * + state so TalkBack reads "Mesaj bildirimleri, onay kutusu, işaretli".
 */
import { useEffect, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Check, Minus } from "lucide-react-native";
import { haptics } from "@/lib/haptics";
import { motionTo, pressTo, useReducedMotion } from "@/theme/motion";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

const BOX = 20;

export type CheckState = boolean | "mixed";

/** The bare box, for rows that compose their own layout. */
export function CheckboxBox({ checked }: { checked: CheckState }) {
  const reduced = useReducedMotion();
  const on = checked !== false;
  const tone = useSharedValue(on ? 1 : 0);
  const mark = useSharedValue(on ? 1 : 0);

  useEffect(() => {
    tone.value = motionTo(on ? 1 : 0, "tone", { reduced });
    mark.value = on ? pressTo(1, reduced) : motionTo(0, "fast", { reduced });
  }, [on, reduced, tone, mark]);

  const box = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [colors.surfaceRaised, colors.accent]),
  }));
  const markStyle = useAnimatedStyle(() => ({
    opacity: mark.value,
    transform: [{ scale: 0.6 + mark.value * 0.4 }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: BOX,
          height: BOX,
          borderRadius: 6,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
        },
        box,
      ]}
    >
      <Animated.View style={markStyle}>
        {checked === "mixed" ? (
          <Minus size={13} color={colors.onAccent} strokeWidth={3} />
        ) : (
          <Check size={13} color={colors.onAccent} strokeWidth={3} />
        )}
      </Animated.View>
    </Animated.View>
  );
}

/** The bare radio dot. */
export function RadioDot({ selected }: { selected: boolean }) {
  const reduced = useReducedMotion();
  const tone = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    tone.value = motionTo(selected ? 1 : 0, "tone", { reduced });
  }, [selected, reduced, tone]);
  const ring = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [colors.surfaceRaised, colors.accent]),
  }));
  const dot = useAnimatedStyle(() => ({
    opacity: tone.value,
    transform: [{ scale: tone.value }],
  }));
  return (
    <Animated.View
      style={[
        { width: BOX, height: BOX, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
        ring,
      ]}
    >
      <Animated.View
        style={[{ width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.onAccent }, dot]}
      />
    </Animated.View>
  );
}

function ChoiceLabel({ label, description }: { label: string; description?: string }) {
  return (
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
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  leading,
  disabled = false,
  style,
}: {
  checked: CheckState;
  /** Called with the next value; a "mixed" box becomes checked. */
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  /** Between box and label — a role colour dot, an icon. */
  leading?: ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Touchable
      onPress={() => {
        haptics.selection();
        onChange(checked !== true);
      }}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked }}
      style={[
        {
          flexDirection: "row",
          alignItems: description ? "flex-start" : "center",
          gap: space.md,
          minHeight: 44,
          paddingVertical: space.sm + 2,
          paddingHorizontal: space.md,
          borderRadius: radius.lg,
        },
        style,
      ]}
    >
      <View style={description ? { paddingTop: 1 } : null}>
        <CheckboxBox checked={checked} />
      </View>
      {leading}
      <ChoiceLabel label={label} description={description} />
    </Touchable>
  );
}

export type RadioOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

/**
 * A single-choice list. Each option is a row; the chosen one sits on the coral
 * wash. Announced as a radio group whose rows are radios with their state.
 */
export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  options: readonly RadioOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Names the group ("Bildirim düzeyi"). */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[{ gap: 2 }, style]}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Touchable
            key={opt.value}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(opt.value);
            }}
            disabled={opt.disabled}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityHint={opt.description}
            accessibilityState={{ checked: selected }}
            tone={selected ? colors.accentSurface : undefined}
            pressedTone={selected ? colors.accentSurfaceStrong : colors.wash}
            style={{
              flexDirection: "row",
              alignItems: opt.description ? "flex-start" : "center",
              gap: space.md,
              minHeight: 44,
              paddingVertical: space.sm + 2,
              paddingHorizontal: space.md,
              borderRadius: radius.lg,
            }}
          >
            <View style={opt.description ? { paddingTop: 1 } : null}>
              <RadioDot selected={selected} />
            </View>
            <ChoiceLabel label={opt.label} description={opt.description} />
          </Touchable>
        );
      })}
    </View>
  );
}
