import { Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import type { Role, RoleId } from "@demli/types";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import { colors, radius, space } from "../theme/theme";

/**
 * Multi-select role picker rendered as wrapping pills (each = colored dot + name,
 * active = accent fill). The shared source of truth for every "pick roles"
 * surface — create-channel visibility, channel-settings visibility (ADR 0007).
 * ≥40pt tap targets; one choice per role, toggled independently.
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
          <Pressable
            key={role.id}
            onPress={() => onToggle(role.id)}
            disabled={disabled}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: active, disabled }}
            style={({ pressed }) => ({
              minHeight: 40,
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              paddingHorizontal: space.md,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: active ? colors.accent : colors.stroke,
              backgroundColor: active ? colors.accent : colors.surface,
              opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
            })}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: role.color ?? ROLE_DOT_FALLBACK,
              }}
            />
            <Text
              style={{
                color: active ? colors.onAccent : colors.fgMuted,
                fontSize: 14,
                fontWeight: active ? "700" : "600",
              }}
            >
              {role.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
