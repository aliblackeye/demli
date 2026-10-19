import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { Button as KitButton, type ButtonVariant } from "./ui/Button";

type LegacyVariant = "primary" | "ghost" | "danger";

/**
 * The legacy name → Koyu Masa variant. Kept so the ~30 existing call sites keep
 * their MEANING while they move to `ui/Button` one screen at a time: the old
 * "primary" was the coral call to action (now `accent`; Koyu Masa's `primary`
 * is the white button), the old "ghost" was the bordered secondary (now
 * `outline`). Same trick the desktop used (`default`/`outline` aliases).
 */
const LEGACY: Record<LegacyVariant, ButtonVariant> = {
  primary: "accent",
  ghost: "outline",
  danger: "danger",
};

/**
 * Legacy action button — a thin adapter over {@link KitButton}. New code
 * imports `@/components/ui/Button` and names a Koyu Masa variant directly.
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
  variant?: LegacyVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  children?: ReactNode;
}) {
  return (
    <KitButton
      label={label}
      onPress={onPress}
      variant={LEGACY[variant]}
      loading={loading}
      disabled={disabled}
      style={style}
    >
      {children}
    </KitButton>
  );
}
