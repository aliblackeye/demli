import { View } from "react-native";
import { Check } from "lucide-react-native";
import type { Role, RoleId } from "@demli/types";
import { haptics } from "@/lib/haptics";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import { Text } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { colors, radius, space } from "../theme/theme";

/**
 * Multi-select role picker rendered as wrapping pills (each = coloured dot +
 * name). The shared source of truth for every "pick roles" surface —
 * create-channel visibility, channel-settings visibility (ADR 0007).
 * ≥40pt tap targets; one choice per role, toggled independently.
 *
 * Koyu Masa: borderless raised pills; a picked role takes the coral wash with
 * coral ink and a check in place of nothing — never a solid fill, so a wall of
 * selected roles stays calm. Announced as checkboxes with their state.
 */
export function RoleMultiSelect({
  roles,
  selected,
  disabled,
  onToggle,
}: {
  roles: Role[];
  selected: ReadonlySet<RoleId>;
  disabled?: boolean;
  onToggle: (roleId: RoleId) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      {roles.map((role) => {
        const active = selected.has(role.id);
        return (
          <Touchable
            key={role.id}
            onPress={() => {
              haptics.selection();
              onToggle(role.id);
            }}
            disabled={disabled}
            accessibilityRole="checkbox"
            accessibilityLabel={role.name}
            accessibilityState={{ checked: active, disabled: !!disabled }}
            tone={active ? colors.accentSurface : colors.surfaceRaised}
            pressedTone={active ? colors.accentSurfaceStrong : colors.raisedHover}
            style={{
              minHeight: 40,
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs + 2,
              paddingHorizontal: space.md,
              borderRadius: radius.pill,
              borderCurve: "continuous",
            }}
          >
            {active ? (
              <Check size={14} color={colors.accent} strokeWidth={2.5} />
            ) : (
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: role.color ?? ROLE_DOT_FALLBACK }} />
            )}
            <Text style={{ color: active ? colors.accent : colors.fgMuted, fontSize: 14, fontWeight: active ? "600" : "500" }}>
              {role.name}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}
