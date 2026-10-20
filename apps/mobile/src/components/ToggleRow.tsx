import { View } from "react-native";
import { haptics } from "@/lib/haptics";
import { CheckboxBox } from "./ui/Checkbox";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { colors, radius, space } from "../theme/theme";

/**
 * A checkbox-style multi-select row used by the role permission list, the member
 * role-assignment screen, and the channel-visibility picker (ADR 0007). Optional
 * colored dot (roles) and description (permissions). ≥44pt tap target.
 *
 * Koyu Masa: the kit checkbox (raised box → coral with dark check, popping in on
 * the press spring), the press a wash tone change only — the row never lifts.
 * Disabled = 40% and announced as disabled.
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
    <Touchable
      onPress={() => {
        haptics.selection();
        onToggle();
      }}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
      accessibilityHint={description}
      pressedTone={colors.wash}
      style={{
        flexDirection: "row",
        alignItems: description ? "flex-start" : "center",
        gap: space.md,
        minHeight: 48,
        paddingVertical: space.sm + 2,
        paddingHorizontal: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
      }}
    >
      <View style={description ? { paddingTop: 1 } : null}>
        <CheckboxBox checked={checked} />
      </View>
      {dotColor !== undefined ? (
        <View
          style={{
            width: 10,
            height: 10,
            marginTop: description ? 5 : 0,
            borderRadius: 5,
            backgroundColor: dotColor ?? colors.fgMuted,
          }}
        />
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 20, fontWeight: "500" }}>{label}</Text>
        {description ? (
          <Text style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16 }}>{description}</Text>
        ) : null}
      </View>
    </Touchable>
  );
}
