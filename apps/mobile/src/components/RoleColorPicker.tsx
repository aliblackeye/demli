import { Check, X } from "lucide-react-native";
import { View } from "react-native";
import { ROLE_COLORS } from "@/lib/roles";
import { haptics } from "@/lib/haptics";
import { Touchable } from "./ui/Touchable";
import { PRESS } from "@/theme/motion-presets";
import { colors, radius, space } from "../theme/theme";

const SWATCH = 36;

/**
 * Role color picker rendered as a wrapping grid of swatches plus a "no color"
 * option (ADR 0007). OTA-safe — no native picker; the palette mirrors the
 * desktop RolesTab so both platforms offer the same choices.
 *
 * Koyu Masa: borderless discs; the chosen one wears a 2px page-coloured gap and
 * a 2px white ring outside it (so it reads on every hue, light or dark) plus a
 * dark check. Each swatch is a radio with its state, ≥44pt with the slop, and a
 * press gives the icon-step press scale.
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
  const pick = (next: string | null) => {
    if (next === value) return;
    haptics.selection();
    onChange(next);
  };
  const ring = (active: boolean) =>
    active
      ? { borderWidth: 2, borderColor: colors.fgDisplay, padding: 2 }
      : { borderWidth: 2, borderColor: "transparent", padding: 2 };

  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <View style={[{ borderRadius: radius.pill }, ring(value === null)]}>
        <Touchable
          onPress={() => pick(null)}
          disabled={disabled}
          pressScale={PRESS.scale.icon}
          hitSlop={4}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === null, disabled: !!disabled }}
          accessibilityLabel={noColorLabel}
          tone={colors.surfaceRaised}
          pressedTone={colors.raisedHover}
          style={{ width: SWATCH, height: SWATCH, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" }}
        >
          <X size={16} color={colors.fgMuted} strokeWidth={2} />
        </Touchable>
      </View>
      {ROLE_COLORS.map((swatch) => {
        const active = value === swatch;
        return (
          <View key={swatch} style={[{ borderRadius: radius.pill }, ring(active)]}>
            <Touchable
              onPress={() => pick(swatch)}
              disabled={disabled}
              pressScale={PRESS.scale.icon}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityState={{ checked: active, disabled: !!disabled }}
              accessibilityLabel={swatch}
              tone={swatch}
              pressedTone={swatch}
              style={{ width: SWATCH, height: SWATCH, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" }}
            >
              {active ? <Check size={16} color={colors.onAccent} strokeWidth={3} /> : null}
            </Touchable>
          </View>
        );
      })}
    </View>
  );
}
