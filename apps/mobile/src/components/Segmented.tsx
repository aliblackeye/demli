import { Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { colors, radius, space } from "../theme/theme";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Two-or-more-way segmented control on the raised surface. Used on the home
 * screen to switch between Servers (multi-channel spaces) and Groups (flat
 * chats) — two distinct social shapes that share one list surface (ADR 0005).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.stroke,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.sm,
              borderCurve: "continuous",
              paddingHorizontal: space.sm,
              backgroundColor: active ? colors.surfaceRaised : "transparent",
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: active ? colors.fg : colors.fgMuted,
                fontSize: 14,
                fontWeight: "600",
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
