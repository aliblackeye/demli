/**
 * Enter/exit choreography for the floating call bars (voice mini bar, DM call
 * mini bar, the busy "X is calling you" banner) — the kit's overlay presets
 * (`OVERLAY_MOTION` in theme/motion-presets, the framer `toastPop`/`bannerDrop`
 * mirrors) as Reanimated layout animations.
 *
 *  - A bar anchored to the BOTTOM rises 12px into place (the toast motion).
 *  - A bar anchored to the TOP drops 12px into place (the banner motion).
 *
 * Enter on the `standard` step with the decelerating curve, exit on the quicker
 * `fast` step: a bar that is dismissed gets out of the way instead of floating
 * off. Transform + opacity only (§27). `ReduceMotion.System` makes each one an
 * instant appear/disappear when the OS asks for less motion.
 */
import { Easing, Keyframe, ReduceMotion } from "react-native-reanimated";
import { OVERLAY_MOTION } from "@/theme/motion-presets";
import { motion } from "@/theme/theme";

const EASE = Easing.bezier(...motion.easing.standard).factory();

function enter(fromY: number) {
  return new Keyframe({
    0: { opacity: 0, transform: [{ translateY: fromY }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE },
  })
    .duration(motion.duration.standard)
    .reduceMotion(ReduceMotion.System);
}

function exit(toY: number) {
  return new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: toY }], easing: EASE },
  })
    .duration(motion.duration.fast)
    .reduceMotion(ReduceMotion.System);
}

export const FLOATING_BAR_ENTER = {
  fromBottom: enter(OVERLAY_MOTION.toast.from.translateY),
  fromTop: enter(OVERLAY_MOTION.banner.from.translateY),
} as const;

export const FLOATING_BAR_EXIT = {
  toBottom: exit(OVERLAY_MOTION.toast.exitTo.translateY),
  toTop: exit(OVERLAY_MOTION.banner.exitTo.translateY),
} as const;
