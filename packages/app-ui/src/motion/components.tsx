/**
 * `m.*` motion helpers — the LazyMotion-safe way to put a preset on screen.
 *
 * The renderer root is `<LazyMotion features={domAnimation} strict>`: a
 * `motion.div` there throws at render and white-screens desktop AND web. These
 * wrappers use `m.div` only (a test mounts each under `strict` to keep it that
 * way) and pair with `<AnimatePresence>` for exits.
 *
 * Layout animations (`layout`, `layoutId`) are NOT in `domAnimation`; a sliding
 * selection indicator needs `domMax` or a CSS transform instead.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { m } from "framer-motion";
import { overlayFade, popIn, sheetSlide, toastPop } from "./presets";

type MotionDivProps = Omit<ComponentPropsWithoutRef<typeof m.div>, "variants" | "initial" | "animate" | "exit">;

function presetDiv(variants: typeof overlayFade, displayName: string) {
  const Component = forwardRef<ElementRef<typeof m.div>, MotionDivProps>((props, ref) => (
    <m.div ref={ref} variants={variants} initial="initial" animate="animate" exit="exit" {...props} />
  ));
  Component.displayName = displayName;
  return Component;
}

/** Opacity-only fade (scrims, crossfades over the virtualized message list). */
export const MotionFade = presetDiv(overlayFade, "MotionFade");

/** Panel / popover pop: scale 0.98 → 1 + fade, mirrored on exit. */
export const MotionPop = presetDiv(popIn, "MotionPop");

/** Toast / pill: lift in on the position spring. */
export const MotionToast = presetDiv(toastPop, "MotionToast");

export interface MotionSheetProps extends MotionDivProps {
  side: keyof typeof sheetSlide;
}

/** Edge sheet travelling in from `side` on the position spring. */
export const MotionSheet = forwardRef<ElementRef<typeof m.div>, MotionSheetProps>(
  ({ side, ...props }, ref) => (
    <m.div ref={ref} variants={sheetSlide[side]} initial="initial" animate="animate" exit="exit" {...props} />
  ),
);
MotionSheet.displayName = "MotionSheet";
