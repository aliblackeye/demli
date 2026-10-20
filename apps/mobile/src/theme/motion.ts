/**
 * React Native bindings for the shared motion ramp.
 *
 * `theme.ts` holds the raw numbers (durations, cubic-bezier control points,
 * springs) so it stays importable from the node-environment unit tests. This
 * module is the RN half: it turns them into real `Easing` functions and
 * `Animated` animations, and exposes the reduced-motion gate every animation in
 * the app must pass through.
 *
 * Engine-neutral presets: `MOTION_PRESETS` (in motion-presets.ts) describes
 * each named motion as plain data, and two adapters run it:
 *
 *  - `animate()` — RN core `Animated`, for the screens not yet moved over.
 *  - `motionTo()` — Reanimated 4 (`withSpring` / `withTiming`), worklet-safe, for
 *    the primitive kit in components/ui. Same presets, same numbers, so a sheet
 *    driven by either engine lands on the same curve.
 *
 * Call sites name a preset ("position", "tone"), never an engine or a number.
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import {
  Easing as ReanimatedEasing,
  ReduceMotion,
  withSpring,
  withTiming,
  type AnimationCallback,
} from "react-native-reanimated";
import { MOTION_PRESETS, PRESS, springConfigOf, type MotionPresetName } from "./motion-presets";
import { motion } from "./theme";

/** The shared decelerating curve — panels, state changes, presses. */
export const easeStandard = Easing.bezier(...motion.easing.standard);
/** Flatter tail, used only for content arriving on screen. */
export const easeArrival = Easing.bezier(...motion.easing.arrival);

const EASINGS = { standard: easeStandard, arrival: easeArrival } as const;

/**
 * Run a named motion preset on an `Animated.Value`.
 *
 * Reduced motion collapses every preset to an instant jump to `toValue` (a
 * zero-duration timing, so `.start(callback)` still fires and chained logic
 * keeps working). `useNativeDriver` defaults to true — presets are meant for
 * transform/opacity; pass false only for a colour or layout value.
 */
export function animate(
  value: Animated.Value,
  toValue: number,
  preset: MotionPresetName,
  { reduced, useNativeDriver = true }: { reduced: boolean; useNativeDriver?: boolean },
): Animated.CompositeAnimation {
  if (reduced) {
    return Animated.timing(value, { toValue, duration: 0, useNativeDriver });
  }
  const spec = MOTION_PRESETS[preset];
  if (spec.type === "spring") {
    return Animated.spring(value, {
      toValue,
      stiffness: spec.stiffness,
      damping: spec.damping,
      mass: spec.mass,
      useNativeDriver,
    });
  }
  return Animated.timing(value, {
    toValue,
    duration: spec.duration,
    easing: EASINGS[spec.easing],
    useNativeDriver,
  });
}

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

// ── Reanimated adapter ────────────────────────────────────────────────────────

/** The two curves as Reanimated easing factories (UI-thread safe). */
const REANIMATED_EASINGS = {
  standard: ReanimatedEasing.bezier(...motion.easing.standard),
  arrival: ReanimatedEasing.bezier(...motion.easing.arrival),
} as const;

/**
 * Animate a shared value to `toValue` on a named preset — the Reanimated twin of
 * {@link animate}. Callable from a worklet (gesture `onEnd`, `useAnimatedReaction`)
 * and from JS.
 *
 * Reduced motion is honoured twice over: every config carries
 * `ReduceMotion.System`, so the OS switch makes Reanimated jump straight to the
 * end value even if a caller forgot to check; and `reduced: true` (from
 * {@link useReducedMotion}) forces the jump explicitly for logic that must not
 * wait on a frame. `velocity` hands a released gesture's speed to the spring so
 * a flicked sheet keeps its momentum instead of restarting from rest.
 */
export function motionTo(
  toValue: number,
  preset: MotionPresetName,
  options: { reduced?: boolean; velocity?: number; onDone?: AnimationCallback } = {},
): number {
  "worklet";
  const reduceMotion = options.reduced ? ReduceMotion.Always : ReduceMotion.System;
  const spec = MOTION_PRESETS[preset];
  if (spec.type === "spring") {
    return withSpring(
      toValue,
      { ...springConfigOf(spec, options.velocity ?? 0), reduceMotion },
      options.onDone,
    );
  }
  return withTiming(
    toValue,
    { duration: spec.duration, easing: REANIMATED_EASINGS[spec.easing], reduceMotion },
    options.onDone,
  );
}

/**
 * The tactile press spring (scale down while held, release back). Separate from
 * the named presets because it is a desktop `pressable` mirror, not a token.
 */
export function pressTo(toValue: number, reduced = false): number {
  "worklet";
  return withSpring(toValue, {
    ...springConfigOf(PRESS.spring),
    reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System,
  });
}

/**
 * Press feedback timing for a tone change. Pressing in is the `instant` step
 * (120ms — feedback must not lag the finger); letting go fades back on the
 * `tone` step (200ms), the same 200ms the desktop hover takes.
 */
export function toneTo(pressed: boolean, reduced = false): number {
  "worklet";
  return withTiming(pressed ? 1 : 0, {
    duration: pressed ? motion.duration.instant : motion.duration.hover,
    easing: REANIMATED_EASINGS.standard,
    reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System,
  });
}
