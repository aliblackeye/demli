import { Pressable, View } from "react-native";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react-native";
import { Text, TextInput } from "./ui/Text";
import type { TextInputProps } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space, typography } from "../theme/theme";

/**
 * Labelled text input matching the dark surface style. Wraps RN's TextInput and
 * forwards all its props so callers control keyboard/secure/autocapitalize.
 *
 * `secureTextEntry` gets a reveal toggle automatically. It lives here rather than
 * in each screen because the desktop had one for weeks while both mobile password
 * fields (sign-in and add-account) stayed bare — the parity gap survived exactly
 * because two screens each had to remember. One component, both fields, no
 * remembering.
 */
export function TextField({
  label,
  hint,
  error,
  ...inputProps
}: TextInputProps & {
  label?: string;
  hint?: string;
  /**
   * Field-level validation message. When set it REPLACES the hint and reddens
   * the border, so the correction sits on the field that is wrong instead of in
   * a form-wide status line the user has to map back to an input themselves.
   */
  error?: string | null;
}) {
  const { t } = useAppTranslation();
  const [revealed, setRevealed] = useState(false);
  const isSecure = inputProps.secureTextEntry === true;
  // Room for the toggle so a long password never runs under the icon.
  const rightPadding = isSecure ? space.xl + space.md : space.md;

  return (
    <View style={{ gap: space.xs }}>
      {label ? (
        <Text
          style={{
            color: colors.fgFaint,
            fontSize: typography.size["2xs"],
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          {label}
        </Text>
      ) : null}
      <View style={{ justifyContent: "center" }}>
        <TextInput
          placeholderTextColor={colors.fgFaint}
          aria-invalid={error ? true : undefined}
          {...inputProps}
          secureTextEntry={isSecure && !revealed}
          style={[
            {
              backgroundColor: colors.surfaceRaised,
              borderColor: error ? colors.danger : colors.stroke,
              borderWidth: 1,
              borderRadius: radius.md,
              borderCurve: "continuous",
              color: colors.fg,
              fontSize: 15,
              paddingHorizontal: space.md,
              paddingRight: rightPadding,
              paddingVertical: space.md,
            },
            inputProps.style,
          ]}
        />
        {isSecure ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? t("mobile:auth.hidePassword") : t("mobile:auth.showPassword")
            }
            // Generous touch target: the icon is 18px but a thumb is not.
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ position: "absolute", right: space.md, padding: space.xs }}
          >
            {revealed ? (
              <EyeOff size={18} color={colors.fgFaint} />
            ) : (
              <Eye size={18} color={colors.fgFaint} />
            )}
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 12 }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ color: colors.fgFaint, fontSize: 12 }}>{hint}</Text>
      ) : null}
    </View>
  );
}
