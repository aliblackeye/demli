/**
 * Named motion presets as engine-neutral data — the mobile mirror of the
 * framer presets in packages/app-ui/src/motion/presets.ts.
 *
 * Plain data on purpose: node unit tests import it, the RN `Animated` adapter
 * (`animate()` in motion.ts) runs it today, and the Reanimated adapter planned
 * for Wave 4 maps the same entries onto `withSpring` / `withTiming` (Reanimated
 * takes the same stiffness/damping/mass triple), so no screen has to change
 * when the engine does.
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
