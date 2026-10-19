/**
 * Chip — a pill you can tap: a filter, a choice in a short set, a removable
 * tag. Selected = the coral wash with coral ink (the Koyu Masa "selected row"
 * recipe), never a solid fill, so a row of chips stays calm with one chosen.
 *
 * `role` decides how it is announced: "radio" inside a single-choice set,
 * "checkbox" in a multi-select, "button" for a plain action chip.
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "./Text";
import { Touchable, type HapticKind } from "./Touchable";

export function Chip({
  label,
  selected = false,
  onPress,
  onRemove,
  leading,
  role = "button",
  disabled = false,
  haptic,
  style,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Shows a trailing remove control (its own 44pt target, its own label). */
  onRemove?: () => void;
  /** A glyph, a colour dot, an emoji. */
  leading?: ReactNode;
  role?: "button" | "radio" | "checkbox";
  disabled?: boolean;
  haptic?: HapticKind;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useAppTranslation();
  const ink = selected ? colors.accent : colors.fgMuted;
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start" }, style]}>
      <Touchable
        onPress={onPress}
        disabled={disabled || !onPress}
        dimmed={disabled}
        haptic={haptic}
        tone={selected ? colors.accentSurface : colors.surface}
        pressedTone={selected ? colors.accentSurfaceStrong : colors.surfaceRaised}
        accessibilityRole={role}
        accessibilityLabel={label}
        accessibilityState={role === "button" ? { selected } : { checked: selected }}
        hitSlop={{ top: 4, bottom: 4 }}
        style={{
          minHeight: 36,
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs + 2,
          paddingLeft: leading ? space.sm + 2 : space.md,
          paddingRight: onRemove ? space.xs + 30 : space.md,
          borderRadius: radius.pill,
        }}
      >
        {leading}
        <Text numberOfLines={1} style={{ color: ink, fontSize: 14, fontWeight: selected ? "600" : "500" }}>
          {label}
        </Text>
      </Touchable>
      {onRemove ? (
        <Touchable
          onPress={onRemove}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${t("common:buttons.remove")}: ${label}`}
          hitSlop={6}
          pressedTone={colors.washStrong}
          style={{
            position: "absolute",
            right: space.xs,
            width: 28,
            height: 28,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <X size={14} color={ink} strokeWidth={2.25} />
        </Touchable>
      ) : null}
    </View>
  );
}
