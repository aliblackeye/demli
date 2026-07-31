import { Check, X } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { ROLE_COLORS } from "@/lib/roles";
import { colors, space } from "../theme/theme";

const SWATCH = 34;

/**
 * Role color picker rendered as a wrapping grid of swatches plus a "no color"
 * option (ADR 0007). OTA-safe — no native picker; the palette mirrors the
 * desktop RolesTab so both platforms offer the same choices.
 */
export function RoleColorPicker({
  value,
  disabled,
  onChange,
  noColorLabel,
}: {
  /** `"#rrggbb"` or null for the default text color. */
  value: string | null;
  disabled?: boolean;
  onChange: (color: string | null) => void;
  /** Accessibility label for the "no color" swatch. */
  noColorLabel: string;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <Pressable
        onPress={() => onChange(null)}
        disabled={disabled}
        accessibilityRole="radio"
        accessibilityState={{ selected: value === null, disabled }}
        accessibilityLabel={noColorLabel}
        style={{
          width: SWATCH,
          height: SWATCH,
          borderRadius: SWATCH / 2,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: value === null ? 2 : 1,
          borderColor: value === null ? colors.accent : colors.strokeStrong,
          backgroundColor: colors.surface,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <X size={16} color={colors.fgFaint} />
      </Pressable>
      {ROLE_COLORS.map((swatch) => {
        const active = value === swatch;
        return (
          <Pressable
            key={swatch}
            onPress={() => onChange(swatch)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled }}
            accessibilityLabel={swatch}
            style={{
              width: SWATCH,
              height: SWATCH,
              borderRadius: SWATCH / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: swatch,
              borderWidth: active ? 2 : 0,
              borderColor: colors.fg,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {active ? <Check size={16} color={colors.onAccent} strokeWidth={3} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
