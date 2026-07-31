/**
 * React Native bindings for the shared motion ramp.
 *
 * `theme.ts` holds the raw numbers (durations + cubic-bezier control points) so
 * it stays importable from the node-environment unit tests. This module is the
 * RN half: it turns those control points into real `Easing` functions and
 * exposes the reduced-motion gate every animation in the app must pass through.
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { motion } from "./theme";

/** The shared decelerating curve — panels, state changes, presses. */
export const easeStandard = Easing.bezier(...motion.easing.standard);
/** Flatter tail, used only for content arriving on screen. */
export const easeArrival = Easing.bezier(...motion.easing.arrival);

/**
 * True when the OS "reduce motion" switch is on. Mirrors the desktop's global
 * `@media (prefers-reduced-motion: reduce)` guard: every animation in the app
 * checks this and renders its end state immediately instead.
 *
 * Subscribes once per mounting component; the listener is a cheap native event
 * that fires only when the user flips the system setting.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduced(enabled);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduced;
}

/**
 * Drives the "arrival" motion for a row that has just appeared: fade up while
 * settling out of a hair of scale.
 *
 * `enabled` is read ONCE, on mount, and frozen — the caller derives it from the
 * message's own freshness, and letting it flip mid-life would restart (or
 * abort) the animation on an unrelated re-render. When it is false, or reduced
 * motion is on, the returned style is the resting state and no animation runs
 * at all.
 */
export function useArrivalStyle(enabled: boolean): {
  opacity: Animated.AnimatedInterpolation<number> | number;
  transform: { scale: Animated.AnimatedInterpolation<number> | number }[];
} {
  const reduced = useReducedMotion();
  // Frozen at mount: the row either arrived or it did not.
  const shouldAnimate = useRef(enabled).current;
  const progress = useRef(new Animated.Value(shouldAnimate ? 0 : 1)).current;

  useEffect(() => {
    if (!shouldAnimate) return;
    if (reduced) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.duration.arrival,
      easing: easeArrival,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [shouldAnimate, reduced, progress]);

  if (!shouldAnimate) return { opacity: 1, transform: [{ scale: 1 }] };

  return {
    opacity: progress,
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [motion.arrival.scaleFrom, 1],
        }),
      },
    ],
  };
}
