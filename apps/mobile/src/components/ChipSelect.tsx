import { Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { colors, radius, space } from "../theme/theme";

export interface ChipOption {
  /** Stable identity; callers map their domain value (number/id/null) to/from it. */
  key: string;
  label: string;
}

/**
 * Single-select control rendered as wrapping pills. Segmented ({@link Segmented})
 * fits 2–3 options; this handles longer sets (slow-mode presets, the system-
 * channel list) while keeping ≥40pt tap targets. One choice is always selected.
 */
export function ChipSelect({
  options,
  selectedKey,
  onSelect,
}: {
  options: ChipOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {options.map((opt) => {
        const active = opt.key === selectedKey;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onSelect(opt.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({
              minHeight: 40,
              justifyContent: "center",
              paddingHorizontal: space.md,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: active ? colors.accent : colors.stroke,
              backgroundColor: active ? colors.accent : colors.surface,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              style={{
                color: active ? colors.onAccent : colors.fgMuted,
                fontSize: 14,
                fontWeight: active ? "700" : "600",
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
