import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { colors, radius } from "../../theme/theme";

type Variant = "neutral" | "accent" | "danger";

/**
 * Compact round icon action used inside person rows and headers (accept /
 * decline / message / cancel). Dims on press via Pressable's style callback —
 * no animation library, keeping the native-module surface minimal (E1 / OTA).
 */
export function IconButton({
  onPress,
  children,
  variant = "neutral",
  disabled = false,
  accessibilityLabel,
}: {
  onPress?: () => void;
  children: ReactNode;
  variant?: Variant;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const bg =
    variant === "accent"
      ? colors.accent
      : variant === "danger"
        ? colors.dangerSurface
        : colors.surfaceRaised;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 38,
        height: 38,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        borderWidth: variant === "neutral" ? 1 : 0,
        borderColor: colors.stroke,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}
