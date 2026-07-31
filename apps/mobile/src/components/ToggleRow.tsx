import { Check } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { colors, radius, space } from "../theme/theme";

/**
 * A checkbox-style multi-select row used by the role permission list, the member
 * role-assignment screen, and the channel-visibility picker (ADR 0007). Optional
 * colored dot (roles) and description (permissions). ≥44pt tap target.
 */
export function ToggleRow({
  label,
  description,
  checked,
  disabled,
  dotColor,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** A role's color swatch shown left of the label; omit for a plain row. */
  dotColor?: string | null;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.sm,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1.5,
          borderColor: checked ? colors.accent : colors.strokeStrong,
          backgroundColor: checked ? colors.accent : "transparent",
        }}
      >
        {checked ? <Check size={13} color={colors.onAccent} strokeWidth={3} /> : null}
      </View>
      {dotColor !== undefined ? (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: dotColor ?? colors.fgMuted,
          }}
        />
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>{label}</Text>
        {description ? (
          <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16 }}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
