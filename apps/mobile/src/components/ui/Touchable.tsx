/**
 * The press foundation every tappable primitive is built on.
 *
 * Koyu Masa's interaction grammar on touch, in one place:
 *  - PRESS = TONE. The surface crossfades to its pressed tone in 120ms when the
 *    finger lands and eases back over 200ms on release — the same 200ms tone
 *    step the desktop hover uses. Rows stop there (founder rule: nothing lifts or
 *    bounces); buttons may add a small press scale on the press spring.
 *  - FOCUS-VISIBLE. A hardware keyboard / D-pad focus draws a 2px coral outline
 *    offset from the shape (RN 0.86 `outline*` styles), so the kit is operable
 *    without touch — the RN reading of desktop `focus-visible:ring-2`.
 *  - DISABLED = 40% and inert, announced through `accessibilityState`.
 *
 * Everything animates on the UI thread (Reanimated shared values), so a press
 * never waits on a busy JS thread — and it honours the OS reduce-motion switch
 * through the adapters in theme/motion.ts.
 */
import { useState, type ReactNode } from "react";
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { pressTo, toneTo, useReducedMotion } from "@/theme/motion";
import { colors } from "@/theme/theme";
import { withAlpha } from "./kit-math";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** "No fill", in white — so a tone animating to a white wash never passes through grey-black. */
export const CLEAR = withAlpha(colors.inverse, 0);

export type HapticKind = keyof typeof haptics;

export type TouchableProps = Omit<PressableProps, "style" | "children"> & {
  /** Fill at rest. Default: none. */
  tone?: string;
  /** Fill while pressed. Default: the white wash, which lifts any surface. */
  pressedTone?: string;
  /** Scale while pressed (buttons only — rows leave this unset). */
  pressScale?: number;
  /** Fire a haptic on press, through the user's haptics master switch. */
  haptic?: HapticKind;
  /**
   * Draw the 40% disabled look. Defaults to `disabled`; a busy button passes
   * false — it is inert while it works, but it is not "off".
   */
  dimmed?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
};

export function Touchable({
  tone = CLEAR,
  pressedTone = colors.wash,
  pressScale,
  haptic,
  disabled,
  dimmed,
  onPress,
  onPressIn,
  onPressOut,
  onFocus,
  onBlur,
  style,
  children,
  accessibilityState,
  ...rest
}: TouchableProps) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);
  const scale = useSharedValue(1);
  const [focused, setFocused] = useState(false);
  // Only render-prop children need the pressed flag on the JS side.
  const [pressedJs, setPressedJs] = useState(false);
  const wantsPressedJs = typeof children === "function";

  const animated = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(pressed.value, [0, 1], [tone, pressedTone]),
    transform: pressScale ? [{ scale: scale.value }] : [],
  }));

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      accessibilityState={{ ...accessibilityState, disabled: !!disabled }}
      onPressIn={(e: GestureResponderEvent) => {
        pressed.value = toneTo(true, reduced);
        if (pressScale) scale.value = pressTo(pressScale, reduced);
        if (wantsPressedJs) setPressedJs(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        pressed.value = toneTo(false, reduced);
        if (pressScale) scale.value = pressTo(1, reduced);
        if (wantsPressedJs) setPressedJs(false);
        onPressOut?.(e);
      }}
      onPress={(e: GestureResponderEvent) => {
        if (haptic) haptics[haptic]();
        onPress?.(e);
      }}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[
        style,
        animated,
        (dimmed ?? !!disabled) ? { opacity: 0.4 } : null,
        focused
          ? {
              outlineWidth: 2,
              outlineStyle: "solid",
              outlineColor: colors.accent,
              // The outline follows the shape's own borderRadius.
              outlineOffset: 2,
            }
          : null,
      ]}
    >
      {typeof children === "function" ? children({ pressed: pressedJs }) : children}
    </AnimatedPressable>
  );
}

/**
 * Spread on the root view of a `Modal` that can be mounted INSIDE a pressable
 * (an image viewer opened from a chat row, a sheet opened from a tile).
 *
 * JS touch negotiation bubbles through the React tree, and a Modal's children
 * are still React children of whatever rendered them: a hold on a part of the
 * window nobody claims (the picture, a sheet's title) reaches the row behind
 * it, whose long press then opens its own menu on top. Claiming here, at the
 * window's root, ends the bubble inside the window; anything deeper (buttons,
 * the scrim, a scroll view) still claims first, and native gestures and
 * scrolling may take the touch over at any time.
 */
export const MODAL_RESPONDER_BARRIER = {
  onStartShouldSetResponder: () => true,
  onResponderTerminationRequest: () => true,
} as const;
