import { useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Eye, EyeOff } from "lucide-react-native";
import type { TextInputProps } from "react-native";
import { useAppTranslation } from "@/lib/i18n";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, motion, radius, space, typography } from "../theme/theme";
import { withAlpha } from "./ui/kit-math";
import { Text, TextInput } from "./ui/Text";
import { Touchable } from "./ui/Touchable";

/**
 * Labelled text input — the Koyu Masa field: borderless, the label above in
 * 13px, the field on the surface tone at rest and lifting to the raised tone
 * while focused (a 200ms tone change), with the coral caret and selection.
 *
 * Validation follows the design system to the letter: an error tints the
 * FIELD itself with the danger wash and puts a plain 13px danger line under
 * it — no border, no ring, no icon. The message REPLACES the hint, so the
 * correction sits on the field that is wrong instead of in a form-wide status
 * line the user has to map back to an input themselves.
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
  leading,
  onFocus,
  onBlur,
  ...inputProps
}: TextInputProps & {
  label?: string;
  hint?: string;
  /**
   * Field-level validation message. When set it REPLACES the hint and tints the
   * field with the danger wash.
   */
  error?: string | null;
  /** A glyph inside the field's start edge (search, @, #). */
  leading?: ReactNode;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const focus = useSharedValue(0);
  const isSecure = inputProps.secureTextEntry === true;
  const disabled = inputProps.editable === false;
  const invalid = !!error;

  const rest = invalid ? colors.dangerSurface : colors.surface;
  const focused = invalid ? withAlpha(colors.danger, 0.18) : colors.surfaceRaised;
  const fieldTone = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(focus.value, [0, 1], [rest, focused]),
  }));

  return (
    <View style={{ gap: space.xs + 2, opacity: disabled ? 0.4 : 1 }}>
      {label ? (
        <Text
          style={{
            color: colors.fgMuted,
            fontSize: typography.size.label,
            lineHeight: 18,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
      ) : null}
      <Animated.View
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            borderRadius: radius.lg,
            borderCurve: "continuous",
            minHeight: 44,
          },
          fieldTone,
        ]}
      >
        {leading ? <View style={{ paddingLeft: space.md }}>{leading}</View> : null}
        <TextInput
          placeholderTextColor={colors.fgFaint}
          aria-invalid={invalid ? true : undefined}
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          accessibilityHint={error ?? inputProps.accessibilityHint ?? hint}
          {...inputProps}
          onFocus={(e) => {
            focus.value = motionTo(1, "tone", { reduced });
            onFocus?.(e);
          }}
          onBlur={(e) => {
            focus.value = motionTo(0, "tone", { reduced });
            onBlur?.(e);
          }}
          secureTextEntry={isSecure && !revealed}
          style={[
            {
              flex: 1,
              color: colors.fg,
              fontSize: 15,
              lineHeight: 20,
              paddingLeft: leading ? space.sm : space.md + 2,
              paddingRight: isSecure ? space.xs : space.md + 2,
              paddingVertical: space.md,
            },
            inputProps.style,
          ]}
        />
        {isSecure ? (
          <Touchable
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? t("mobile:auth.hidePassword") : t("mobile:auth.showPassword")
            }
            pressedTone={colors.washStrong}
            // Visual 36px, ≥44pt with the slop.
            hitSlop={6}
            style={{
              width: 36,
              height: 36,
              marginRight: space.xs,
              borderRadius: radius.md,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {revealed ? (
              <EyeOff size={18} color={colors.fgFaint} />
            ) : (
              <Eye size={18} color={colors.fgFaint} />
            )}
          </Touchable>
        ) : null}
      </Animated.View>
      {error ? (
        <Animated.View
          key={error}
          entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
        >
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{ color: colors.danger, fontSize: typography.size.label, lineHeight: 18 }}
          >
            {error}
          </Text>
        </Animated.View>
      ) : hint ? (
        <Text style={{ color: colors.fgFaint, fontSize: typography.size.label, lineHeight: 18 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
