/**
 * Design tokens for the mobile app — the RN half of Demli's "Koyu Masa" design
 * system (docs/design-system/demli-design-system.md).
 *
 * ── WHERE THESE VALUES COME FROM ───────────────────────────────────────────
 * Desktop and web paint from the Tailwind `@theme` block in
 * apps/desktop/src/renderer/src/styles/globals.css. packages/app-ui/src/tokens.css
 * states the same system as plain `--tc-*` custom properties, and is locked to
 * globals.css by the desktop design-tokens test. React Native has no CSS custom
 * properties, so this file is a hand-maintained MIRROR of tokens.css, locked to
 * it by `__tests__/design-tokens.test.ts` (colours, radius, motion, spring).
 *
 * Rule: never eyeball a value here. Change tokens.css + globals.css first, then
 * copy it across — the tests fail until all three agree.
 *
 * ── THEME: "Koyu Masa" (M16) ────────────────────────────────────────────────
 * Neutral black surfaces, one warm light (Demli coral). The accent is LIGHT, so
 * content sitting ON it must use `onAccent` (near-black), never `fg` and never
 * white — white-on-#ff8464 is ~2.4:1 and unreadable.
 */

import type { PresenceStatus } from "@demli/types";

export const colors = {
  // ── Surfaces: darkest (rail) → lightest (raised) ─────────────────────────
  /** Page / window — pure black. Desktop `--color-rail`. */
  rail: "#000000",
  /** Base: channel + DM lists. Desktop `--color-sidebar`. */
  sidebar: "#0d0d0d",
  /** Base: the backdrop everything sits on, and dialog/sheet cards. */
  app: "#0d0d0d",
  /** Inputs at rest, icon boxes, list press wash. */
  surface: "#171717",
  /** Secondary buttons, focused inputs, menu highlight. Desktop `--color-raised`. */
  surfaceRaised: "#262626",
  /** `surfaceRaised` while hovered/pressed-in (secondary button states). */
  raisedHover: "#303030",
  raisedPressed: "#1f1f1f",
  /** Opaque stand-in for glass — sheets and modals over a scrim. */
  overlay: "#171717",
  /** Floating glass (needs a blur behind it; opaque `overlay` without one). */
  glass: "rgba(23,23,23,0.72)",
  glassStrong: "rgba(23,23,23,0.92)",
  /** Translucent pill on top of video/media. */
  veil: "rgba(0,0,0,0.24)",
  /** Modal / sheet backdrop. */
  scrim: "rgba(0,0,0,0.55)",
  /** Selected row in a channel/DM list — the coral wash. */
  selected: "rgba(255,132,100,0.12)",
  /** Row press wash. Same value as `surface` by design. */
  hover: "#171717",
  /** Hover/press wash for controls without a fill of their own; lifts any surface. */
  wash: "rgba(255,255,255,0.06)",
  /** Their pressed state, and skeleton blocks. */
  washStrong: "rgba(255,255,255,0.1)",

  // ── Hairlines (functional only — Koyu Masa is borderless) ────────────────
  stroke: "rgba(255,255,255,0.08)",
  strokeStrong: "rgba(255,255,255,0.16)",

  // ── Text ─────────────────────────────────────────────────────────────────
  /** Big headings. */
  fgDisplay: "#ffffff",
  fg: "#e5e5e5",
  fgMuted: "#a3a3a3",
  /** Meta text (timestamps, hints). AA 4.5:1 on every surface up to raised. */
  fgFaint: "#8f8f8f",
  /** NON-TEXT only (idle icons, separators): 3:1 on rail/app/surface. */
  fgSubtle: "#666666",

  // ── Inverse (white primary button) ───────────────────────────────────────
  inverse: "#ffffff",
  inverseHover: "#e5e5e5",
  inversePressed: "#d4d4d4",
  onInverse: "#171717",

  // ── Brand ────────────────────────────────────────────────────────────────
  /** Demli coral. LIGHT — anything drawn on top of it MUST use `onAccent`. */
  accent: "#ff8464",
  /** Lighter tone — desktop `--color-accent-hover`. */
  accentPressed: "#ffa48c",
  /** Alias of `accentPressed` for code that reads in hover terms. */
  accentHover: "#ffa48c",
  /** Deeper tone for a pressed coral fill — desktop `--color-accent-pressed`. */
  accentDeep: "#e8624a",
  /** Near-black ink for text/icons ON `accent`. Contrast vs accent ≈ 7.5:1. */
  onAccent: "#171717",
  /** Faint accent wash — mention pills, selected rows. */
  accentSurface: "rgba(255,132,100,0.12)",
  /** Stronger accent wash — a mention of the current user. */
  accentSurfaceStrong: "rgba(255,132,100,0.24)",
  /** Radial glow behind a speaking tile / incoming call. */
  accentGlow: "rgba(255,132,100,0.24)",

  // ── Semantic ─────────────────────────────────────────────────────────────
  danger: "#ff6fb5",
  dangerSurface: "rgba(255,111,181,0.12)",
  success: "#22c55e",
  warning: "#eab30a",

  // ── Presence ─────────────────────────────────────────────────────────────
  online: "#22c55e",
  idle: "#eab30a",
  dnd: "#ff6fb5",
  offline: "#666666",
} as const;

/**
 * Type/icon colour to draw ON a given background. Use this instead of guessing
 * when a surface is accent-tinted: the Demli accent is light, so the correct
 * ink there is near-black while every dark surface takes `fg`.
 */
export const onColor = {
  accent: colors.onAccent,
  accentPressed: colors.onAccent,
  accentDeep: colors.onAccent,
  inverse: colors.onInverse,
  /** Semantic fills are light too (pink / green / gold). */
  danger: colors.onAccent,
  success: colors.onAccent,
  warning: colors.onAccent,
  online: colors.onAccent,
} as const;

/**
 * Font families registered by `theme/fonts.ts` via expo-font.
 *
 * React Native ignores numeric `fontWeight` for custom families on Android, so
 * each weight ships as its own family/file. Body = Inter 400/500/600, display =
 * Onest 500/600/700 — the weights the product UI uses; desktop/web load the
 * same two families as variable fonts.
 *
 * `null` means "not loaded yet" is NOT represented here — these are the names
 * to use once loading finished. Read them through `useAppFonts()`'s
 * `fontsLoaded` gate, or via the `font()` helper below which falls back to the
 * platform default until the assets are registered.
 */
export const fontFamily = {
  body: {
    regular: "Inter-Regular",
    medium: "Inter-Medium",
    semibold: "Inter-SemiBold",
  },
  display: {
    medium: "Onest-Medium",
    semibold: "Onest-SemiBold",
    bold: "Onest-Bold",
  },
} as const;

/**
 * The everyday roundness knob, mirroring the desktop `--radius` custom property
 * (12px). sm/md/lg/xl derive from it — 8/10/12/16, Koyu Masa's small steps —
 * and the named steps are the authored large radii (CTA 18, card/dialog 24,
 * panel 32).
 */
const RADIUS_BASE = 12;

export const radius = {
  sm: RADIUS_BASE - 4,
  md: RADIUS_BASE - 2,
  lg: RADIUS_BASE,
  xl: RADIUS_BASE + 4,
  cta: 18,
  card: 24,
  panel: 32,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /**
   * The in-between step (desktop: `mt-4.5` → 1.125rem). Reach for it where 16
   * is cramped and 24 is loose — message-group rhythm, section gaps.
   */
  "4.5": 18,
  xl: 24,
  xxl: 48,
} as const;

/**
 * Micro-typography ramp — everything BELOW the 12px body-meta size, mirroring
 * the desktop `text-2xs` / `text-badge` / `text-3xs` tokens 1:1. React Native
 * has no rem, so these are the px values those rem tokens resolve to at the
 * default zoom; keeping the two platforms on the same three numbers is what
 * makes a screenshot comparison meaningful.
 */
export const typography = {
  size: {
    /** 14px — body. */
    body: 14,
    /** 12px — secondary body / dense labels. */
    sm: 12,
    /** 11px — timestamps, meta rows, section headings. The workhorse. */
    "2xs": 11,
    /** 10px — badges, counters, pills. */
    badge: 10,
    /** 8px — tiny glyphs inside small avatars. */
    "3xs": 8,
    /** 13px — field labels, help and validation lines. */
    label: 13,
  },
} as const;

/**
 * Motion ramp — the RN half of the desktop `--motion-*` tokens. Same durations,
 * same two decelerating curves, same springs, so a transition that takes 240ms
 * on Windows takes 240ms on Android.
 *
 * Easing is exported as raw cubic-bezier control points rather than an
 * `Easing.bezier(...)` object on purpose: this module is imported by
 * node-environment unit tests, and pulling in `react-native` here would break
 * them. `theme/motion.ts` turns these into real Easing functions and springs.
 */
export const motion = {
  duration: {
    /** Tactile feedback: press states, focus. */
    instant: 120,
    /** State change: a control switching mode, a banner, a badge. */
    fast: 180,
    /** Tone change — Koyu Masa's only "hover" motion (press washes on touch). */
    hover: 200,
    /** Sheets, panels, dialogs — anything with real surface area. */
    standard: 240,
    /** New content settling into place. */
    arrival: 500,
  },
  easing: {
    /** cubic-bezier(0.25, 1, 0.5, 1) — the general decelerating curve. */
    standard: [0.25, 1, 0.5, 1],
    /** cubic-bezier(0.16, 1, 0.3, 1) — flatter tail, for arrivals. */
    arrival: [0.16, 1, 0.3, 1],
  },
  spring: {
    /**
     * The authored position spring (landing measurement). ζ ≈ 1.34 — it never
     * overshoots. RN `Animated.spring` and Reanimated `withSpring` both take
     * these three numbers directly.
     */
    position: { stiffness: 500, damping: 60, mass: 1 },
    /**
     * The hover spring in framer's duration form. RN `Animated.spring` has no
     * duration form, so `hoverPhysical` is the same spring solved into
     * stiffness/damping — the numbers framer-motion's own `findSpring` returns
     * for it (asserted in the tests).
     */
    hover: { bounce: 0.2, durationMs: 400 },
    hoverPhysical: { stiffness: 505.6086, damping: 35.9772, mass: 1 },
  },
  arrival: {
    /**
     * Desktop lifts new content 12px and sharpens it out of a 2px blur. RN has
     * no cheap blur, and an inverted FlatList flips the Y axis inside every
     * cell (so a translate would travel the wrong way), so the mobile arrival
     * is opacity + a hair of scale. Same duration, same curve, same intent.
     */
    scaleFrom: 0.97,
  },
} as const;

/**
 * Elevation — RN's answer to the desktop shadow utilities. CSS box-shadows do
 * not exist here: Android draws the integer `elevation`, iOS draws the
 * `shadow*` quad, so every lifted surface needs both.
 *
 * Koyu Masa itself uses no outer shadows (depth = surface tone); these stay for
 * the few legacy floating bars until Wave 4 restyles them, in the neutral black
 * of the desktop `--shadow-lift-color`.
 */
const SHADOW_COLOR = "#000000";

export const elevation = {
  /** Floating overlay: mini bars, banners, anything resting above the page. */
  panel: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  /**
   * The landing's pill signature — a 1px inset line along the bottom edge
   * (design system §1.5). Not a lift: the one "shadow" Koyu Masa keeps, drawn
   * with RN 0.76+ `boxShadow`. Desktop writes the same value inline on the
   * veil Badge (`shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]`).
   */
  pillInset: { boxShadow: "inset 0 -1px 0 rgba(38,49,64,0.32)" },
  /** A pill or card lifted just off the surface. */
  raised: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
  },
} as const;

/**
 * Presence status → dot color. `invisible` is only ever the OWNER's own status
 * (peers receive it masked to offline), so it reads as the offline gray here.
 */
export function presenceColor(status: PresenceStatus): string {
  if (status === "online") return colors.online;
  if (status === "idle") return colors.idle;
  if (status === "dnd") return colors.dnd;
  return colors.offline; // offline + invisible
}
