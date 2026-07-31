import type { ReactNode } from "react";
import { ActivityIndicator, Pressable } from "react-native";
import { Text } from "./ui/Text";
import type { ViewStyle } from "react-native";
import { colors, radius, space } from "../theme/theme";

type Variant = "primary" | "ghost" | "danger";

/**
 * Primary action button. `pressed` dims via Pressable's style callback rather
 * than an animation library (E1 keeps the native-module surface minimal).
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  children,
}: {
  label?: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  children?: ReactNode;
}) {
  const isDisabled = disabled || loading;
  const bg =
    variant === "primary"
      ? colors.accent
      : variant === "danger"
        ? colors.dangerSurface
        : "transparent";
  const fg =
    variant === "primary" ? colors.onAccent : variant === "danger" ? colors.danger : colors.fg;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          minHeight: 46,
          borderRadius: radius.md,
          borderCurve: "continuous",
          paddingHorizontal: space.lg,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: space.sm,
          backgroundColor: bg,
          borderWidth: variant === "ghost" ? 1 : 0,
          borderColor: colors.stroke,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading && <ActivityIndicator color={fg} size="small" />}
      {label ? (
        <Text selectable={false} style={{ color: fg, fontSize: 15, fontWeight: "600" }}>
          {label}
        </Text>
      ) : null}
      {children}
    </Pressable>
  );
}
