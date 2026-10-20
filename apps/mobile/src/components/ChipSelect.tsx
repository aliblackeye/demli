import { View } from "react-native";
import { haptics } from "@/lib/haptics";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
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
 *
 * Koyu Masa: borderless pills on the raised tone (so they read on the page AND
 * inside a surface-toned settings card); the chosen one takes the coral wash
 * with coral ink — the "selected row" recipe, never a solid fill, so a row of
 * chips stays calm with one chosen. Press = tone change on the kit's 120/200ms
 * steps. Announced as a radio group; each chip a radio with its checked state.
 */
export function ChipSelect({
  options,
  selectedKey,
  onSelect,
  accessibilityLabel,
}: {
  options: ChipOption[];
  selectedKey: string;
  onSelect: (key: string) => void;
  /** Names the group for screen readers ("Giriş modu"). */
  accessibilityLabel?: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
    >
      {options.map((opt) => {
        const active = opt.key === selectedKey;
        return (
          <Touchable
            key={opt.key}
            onPress={() => {
              if (active) return;
              haptics.selection();
              onSelect(opt.key);
            }}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityState={{ checked: active, selected: active }}
            tone={active ? colors.accentSurface : colors.surfaceRaised}
            pressedTone={active ? colors.accentSurfaceStrong : colors.raisedHover}
            style={{
              minHeight: 40,
              justifyContent: "center",
              paddingHorizontal: space.md + 2,
              borderRadius: radius.pill,
              borderCurve: "continuous",
            }}
          >
            <Text
              style={{
                color: active ? colors.accent : colors.fgMuted,
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
