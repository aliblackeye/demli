/**
 * Shared Framer Motion presets — the SINGLE source of premium motion for the
 * renderer (desktop) and the web build, aligned 1:1 with the CSS motion ramp in
 * `globals.css` / `tokens.css` (CLAUDE.md §7: smooth, never a motion demo).
 *
 * Framer values mirror the four-step duration ramp and the two decelerating
 * curves so a framer-animated surface and a CSS-animated one feel like the same
 * system:
 *
 *   instant  120ms  tactile feedback (press / focus)
 *   fast     180ms  state changes (scrims, tooltips)
 *   hover    200ms  hover = tone change only (Koyu Masa: no slide, no scale)
 *   standard 240ms  panels, popovers, dialogs, menus
 *   arrival  500ms  new content settling in
 *
 * Anything that MOVES uses the authored position spring
 * `{ stiffness 500, damping 60, mass 1 }` (`springs.position`, from
 * @demli/ui's spring module — the same numbers the CSS `linear()` curve and the
 * React Native theme are generated from).
 *
 * LazyMotion: the renderer root is `<LazyMotion features={domAnimation} strict>`,
 * where a `motion.*` element THROWS. Everything here is plain data for `m.*`
 * elements; the helpers in ./components.tsx are `m.*` only.
 *
 * Accessibility: the whole tree is wrapped in `<MotionConfig reducedMotion="user">`
 * (see the renderer App), so framer automatically drops transform/opacity motion
 * for users who ask for reduced motion — mirroring the global CSS
 * `prefers-reduced-motion` guard. Do not re-implement that per component.
 *
 * Keep everything here transform + opacity only (GPU-cheap, §27); never animate
 * width/height/top/left on a hot surface.
 */
import type { Transition, Variants } from "framer-motion";
import { SPRING_HOVER, SPRING_POSITION } from "@demli/ui";

/** Duration ramp in SECONDS (framer's unit), matching the CSS `--*-duration-*`. */
export const MOTION_DURATION = {
  instant: 0.12,
  fast: 0.18,
  hover: 0.2,
  standard: 0.24,
  arrival: 0.5,
} as const;

/**
 * The two decelerating curves from the design system, as framer cubic-bezier
 * tuples. `standard` enters quickly and lands softly; `arrival` has the flatter
 * tail for content settling into place. Neither ever overshoots/bounces.
 */
export const MOTION_EASE = {
  standard: [0.25, 1, 0.5, 1],
  arrival: [0.16, 1, 0.3, 1],
} as const;

/** Ready-made transitions keyed to the ramp — pass straight to `transition`. */
export const transitions = {
  instant: { duration: MOTION_DURATION.instant, ease: MOTION_EASE.standard },
  fast: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.standard },
  hover: { duration: MOTION_DURATION.hover, ease: MOTION_EASE.standard },
  standard: { duration: MOTION_DURATION.standard, ease: MOTION_EASE.standard },
  arrival: { duration: MOTION_DURATION.arrival, ease: MOTION_EASE.arrival },
} satisfies Record<string, Transition>;

/**
 * Springs. `position` is the authored Koyu Masa spring for anything that changes
 * place (ζ ≈ 1.34: settles without overshoot). `hover` is the landing's
 * duration-form spring (a hair of bounce) — for a pointer-driven nudge, never
 * for text sliding (the product does not slide text on hover).
 */
export const springs = {
  position: { type: "spring", ...SPRING_POSITION },
  hover: { type: "spring", bounce: SPRING_HOVER.bounce, duration: SPRING_HOVER.durationMs / 1000 },
} satisfies Record<string, Transition>;

/**
 * Transition to use when the viewer asked for reduced motion and a component
 * drives motion by hand (framer's `useReducedMotion()`); `<MotionConfig
 * reducedMotion="user">` already covers transform/opacity animations.
 */
export const reducedTransition: Transition = { duration: 0 };

/**
 * Overlay scrim (dialog / command-menu backdrop) — opacity only, fast step. The
 * exit is symmetric so the scrim fades WITH the surface it dims.
 */
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transitions.fast },
  exit: { opacity: 0, transition: transitions.fast },
};

/**
 * Panel/dialog/popover "pop": a soft scale + fade that lands softly (matches the
 * CSS `pop-in` keyframe, scale 0.98 → 1) and — the framer win over CSS — plays
 * the SAME motion in reverse on exit.
 */
export const popIn: Variants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1, transition: transitions.standard },
  exit: { opacity: 0, scale: 0.98, transition: transitions.fast },
};

/** Bottom-anchored toast/pill: lift + fade in on the position spring, sink + fade out. */
export const toastPop: Variants = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: springs.position },
  exit: { opacity: 0, y: 8, scale: 0.98, transition: transitions.fast },
};

/** Edge sheets: travel in on the position spring, leave on the fast step. */
export const sheetSlide = {
  right: {
    initial: { opacity: 0, x: 32 },
    animate: { opacity: 1, x: 0, transition: springs.position },
    exit: { opacity: 0, x: 32, transition: transitions.fast },
  },
  left: {
    initial: { opacity: 0, x: -32 },
    animate: { opacity: 1, x: 0, transition: springs.position },
    exit: { opacity: 0, x: -32, transition: transitions.fast },
  },
  bottom: {
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0, transition: springs.position },
    exit: { opacity: 0, y: 24, transition: transitions.fast },
  },
} satisfies Record<string, Variants>;

/** Top-anchored banner: drop in from above, retract on exit. */
export const bannerDrop: Variants = {
  initial: { opacity: 0, y: -12 },
  animate: { opacity: 1, y: 0, transition: transitions.standard },
  exit: { opacity: 0, y: -8, transition: transitions.fast },
};

/**
 * A view/route crossfade for the main content column. OPACITY ONLY, on purpose:
 * the conversation column hosts the virtualized message list, so a transform
 * here could fight the virtualizer's own row transforms — a pure fade never
 * touches layout or scroll position (§27, and the chat-jank rule).
 */
export const viewFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transitions.fast },
  exit: { opacity: 0, transition: { duration: MOTION_DURATION.instant, ease: MOTION_EASE.standard } },
};

/**
 * Stagger container for a small grid/list that should resolve in sequence (e.g.
 * the voice avatar tiles). `staggerChildren` is tiny so the whole set settles
 * inside the arrival window, never a slow cascade.
 */
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.04, delayChildren: 0.02 },
  },
};

/** A single member of {@link staggerContainer}: lift + fade, arrival easing. */
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: transitions.arrival },
};

/**
 * Tactile press for interactive chrome (rail icons, tiles): a gentle scale-down
 * on press with a spring back — the physical "give" CSS `:active` can't express
 * as smoothly. NO hover scale: Koyu Masa's product hover is a tone change only
 * (the CSS base layer does it in 200ms).
 */
export const pressable = {
  whileTap: { scale: 0.92 },
  transition: { type: "spring", stiffness: 520, damping: 30, mass: 0.6 },
} as const;

/** Press-only variant for row-shaped controls where a hover scale would look odd. */
export const pressableRow = {
  whileTap: { scale: 0.985 },
  transition: { type: "spring", stiffness: 520, damping: 34, mass: 0.6 },
} as const;
