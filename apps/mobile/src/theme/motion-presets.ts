/**
 * Named motion presets as engine-neutral data — the mobile mirror of the
 * framer presets in packages/app-ui/src/motion/presets.ts.
 *
 * Plain data on purpose: node unit tests import it, and both adapters in
 * motion.ts run the same entries — `animate()` on RN `Animated`, `motionTo()`
 * on Reanimated `withSpring` / `withTiming` (same stiffness/damping/mass
 * triple) — so no screen has to change when it moves engines.
 */
import { motion } from "./theme";

export type SpringPreset = {
  type: "spring";
  stiffness: number;
  damping: number;
  mass: number;
};

export type TimingPreset = {
  type: "timing";
  duration: number;
  easing: "standard" | "arrival";
};

export const MOTION_PRESETS = {
  /** Anything that changes position: switch thumb, sheet, toast, drawer. */
  position: { type: "spring", ...motion.spring.position },
  /** Press / hover feedback that may overshoot a hair (ζ = 0.8). */
  hover: { type: "spring", ...motion.spring.hoverPhysical },
  /** Tone change of a surface or label (press wash, selection). */
  tone: { type: "timing", duration: motion.duration.hover, easing: "standard" },
  /** Small state change: badge, banner, scrim. */
  fast: { type: "timing", duration: motion.duration.fast, easing: "standard" },
  /** Panels, sheets, dialogs without a spring. */
  standard: { type: "timing", duration: motion.duration.standard, easing: "standard" },
  /** New content settling in. */
  arrival: { type: "timing", duration: motion.duration.arrival, easing: "arrival" },
} as const satisfies Record<string, SpringPreset | TimingPreset>;

export type MotionPresetName = keyof typeof MOTION_PRESETS;

/**
 * Tactile press — the mirror of `pressable` in packages/app-ui/src/motion/
 * presets.ts: a scale-down while the finger is down, released on a quick,
 * slightly under-damped spring (ζ ≈ 0.85). It is the ONLY scale in product UI.
 *
 *   icon    compact chrome (icon buttons, avatars in a rail) — desktop 0.92
 *   button  text buttons; a label shrinking 8% reads as a glitch, so a softer
 *           step (0.97) keeps the "give" without the wobble
 *
 * Rows and list cells do NOT scale (founder rule: a row's press is a tone
 * change, nothing lifts or bounces) — they use the `tone` preset only.
 */
export const PRESS = {
  scale: { icon: 0.92, button: 0.97 },
  spring: { type: "spring", stiffness: 520, damping: 30, mass: 0.6 },
} as const satisfies { scale: Record<string, number>; spring: SpringPreset };

/**
 * Enter/exit choreography for overlay surfaces, mirroring the framer variants
 * (`toastPop`, `bannerDrop`, `sheetSlide.bottom`, `popIn`). Offsets are px,
 * `from` is the hidden state. Every entry is transform + opacity only (§27).
 * The ENTER rides the position spring; the EXIT takes the `fast` timing so a
 * dismissed surface gets out of the way instead of floating off.
 */
export const OVERLAY_MOTION = {
  toast: { from: { opacity: 0, translateY: 12, scale: 0.98 }, exitTo: { opacity: 0, translateY: 8 } },
  banner: { from: { opacity: 0, translateY: -12 }, exitTo: { opacity: 0, translateY: -8 } },
  pop: { from: { opacity: 0, scale: 0.98 }, exitTo: { opacity: 0, scale: 0.98 } },
} as const;

/**
 * Reanimated-shaped config for a named spring preset (`withSpring` takes the
 * same stiffness/damping/mass triple as RN `Animated.spring`). Plain data so a
 * node test can assert the mapping without loading the native module.
 */
export function springConfigOf(
  preset: SpringPreset,
  velocity = 0,
): { stiffness: number; damping: number; mass: number; velocity: number } {
  // Called from inside `motionTo` / `pressTo`, which run on the UI thread — a
  // plain function there would crash, so this one is a worklet too (the
  // directive is an inert string to node and to the unit tests).
  "worklet";
  return { stiffness: preset.stiffness, damping: preset.damping, mass: preset.mass, velocity };
}
