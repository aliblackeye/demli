/**
 * Design tokens for the mobile app — the RN half of Demli's single-source
 * design system.
 *
 * ── WHERE THESE VALUES COME FROM ───────────────────────────────────────────
 * Desktop and web share `packages/app-ui/src/tokens.css` (`--tc-*`) and the
 * desktop `@theme` block in apps/desktop/.../styles/globals.css. React Native
 * has no CSS custom properties, so this file is a hand-maintained MIRROR of
 * those tokens: every colour below is copied byte-for-byte from the desktop
 * palette, and the names match concept-for-concept (`rail`/`app`/`raised`/
 * `fg`/`onAccent`/`stroke`…) so the two sides can move in lock step.
 *
 * Rule: never eyeball a colour here. If a value needs to change, change it in
 * tokens.css first and copy it across.
 *
 * ── THEME: "Demli Voice v2" (2026-07-27) ───────────────────────────────────
 * Warm dark red-orange ramp (was Catppuccin Macchiato's cool blue-purple).
 * The accent is a LIGHT orange, which inverts the usual dark-UI reflex:
 * content sitting ON the accent must use `onAccent` (near-black), never `fg`
 * and never white — white-on-#FF8C1A is ~2:1 and unreadable.
 */

import type { PresenceStatus } from "@demli/types";

export const colors = {
  /* 2026-07-27: "Demli Voice v2" — masaüstü globals.css @theme ve
     packages/app-ui/src/tokens.css ile BİREBİR aynı değerler; üç yüzey de
     kilit adımda kalmalı. Sıcak koyu kırmızı-turuncu rampa (founder tasarımı),
     gradient zemin #2A0F07→#180806→#0C0304'ün opak katman karşılıkları. */

  // ── Surfaces: darkest (rail) → lightest (overlay) ────────────────────────
  /** Darkest step — the group/server rail. Desktop `--color-rail`. */
  rail: "#0c0403",
  /** Sidebar / mantle — channel + DM lists. Desktop `--color-sidebar`. */
  sidebar: "#140705",
  /** App backdrop — the base layer everything sits on. */
  app: "#1a0806",
  /** Cards, sheets, the composer bar. */
  surface: "#241009",
  /** Raised rows, menus, popovers, pressed states. Desktop `--color-raised`. */
  surfaceRaised: "#2e130b",
  /** Highest step — bottom sheets and modals over a scrim. */
  overlay: "#3a1710",
  /** Selected row in a channel/DM list — the warm highlight. */
  selected: "#3a241b",
  /** Row hover/press wash. Same value as `surface` by design. */
  hover: "#241009",

  // ── Hairlines: cream at low alpha ────────────────────────────────────────
  stroke: "rgba(248,238,212,0.09)",
  strokeStrong: "rgba(248,238,212,0.16)",

  // ── Text: cream ramp ─────────────────────────────────────────────────────
  fg: "#f8eed4",
  fgMuted: "#b9a48e",
  fgFaint: "#8a7361",

  // ── Brand ────────────────────────────────────────────────────────────────
  /**
   * Demli accent orange. LIGHT (~68% relative luminance against the app
   * backdrop) — anything drawn on top of it MUST use `onAccent`.
   */
  accent: "#ff8c1a",
  /** Press/hover feedback — desktop `--color-accent-hover`, lighter not darker. */
  accentPressed: "#ffb65c",
  /** Alias of `accentPressed` for code that reads in hover terms. */
  accentHover: "#ffb65c",
  /** Near-black ink for text/icons ON `accent`. Contrast vs accent ≈ 11:1. */
  onAccent: "#120b08",
  /** Faint accent wash — mention pills, "mentions you" row emphasis. */
  accentSurface: "rgba(255,140,26,0.16)",
  /** Stronger accent wash — a mention of the current user. */
  accentSurfaceStrong: "rgba(255,140,26,0.30)",

  // ── Semantic ─────────────────────────────────────────────────────────────
  danger: "#ff7366",
  dangerSurface: "rgba(255,115,102,0.16)",
  success: "#a6da95",
  warning: "#e8c34a",

  // ── Presence ─────────────────────────────────────────────────────────────
  online: "#a6da95",
  idle: "#e8c34a",
  dnd: "#ee5a5a",
  /** Warm gray, not the old cool #6e738d — a cool gray fights the ramp. */
  offline: "#6e5d4f",
} as const;

/**
 * Type/icon colour to draw ON a given background. Use this instead of guessing
 * when a surface is accent-tinted: the Demli accent is light, so the correct
 * ink there is near-black while every dark surface takes cream.
 */
export const onColor = {
  accent: colors.onAccent,
  accentPressed: colors.onAccent,
  /** Semantic fills are light too (coral / green / yellow). */
  danger: colors.onAccent,
  success: colors.onAccent,
  warning: colors.onAccent,
  online: colors.onAccent,
} as const;

/**
 * Font families registered by `theme/fonts.ts` via expo-font.
 *
 * React Native ignores numeric `fontWeight` for custom families on Android, so
 * each weight ships as its own family/file. Mirrors the desktop `@font-face`
 * set exactly: Instrument Sans 400/500/600 for body, Space Grotesk 500/600/700
 * for display.
 *
 * `null` means "not loaded yet" is NOT represented here — these are the names
 * to use once loading finished. Read them through `useAppFonts()`'s
 * `fontsLoaded` gate, or via the `font()` helper below which falls back to the
 * platform default until the assets are registered.
 */
export const fontFamily = {
  body: {
    regular: "InstrumentSans-Regular",
    medium: "InstrumentSans-Medium",
    semibold: "InstrumentSans-SemiBold",
  },
  display: {
    medium: "SpaceGrotesk-Medium",
    semibold: "SpaceGrotesk-SemiBold",
    bold: "SpaceGrotesk-Bold",
  },
} as const;

/**
 * The one roundness knob, mirroring the desktop `--radius` custom property.
 * Every step below derives from it, so the whole app's corner language moves
 * together from a single edit — exactly like `calc(var(--radius) - 2px)` in
 * globals.css. Values resolve to today's 6/8/10, so this is a refactor.
 */
const RADIUS_BASE = 10;

export const radius = {
  sm: RADIUS_BASE - 4,
  md: RADIUS_BASE - 2,
  lg: RADIUS_BASE,
  xl: RADIUS_BASE + 2,
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
  },
} as const;

/**
 * Motion ramp — the RN half of the desktop `--motion-*` tokens. Same four
 * durations, same two decelerating curves, so a transition that takes 240ms on
 * Windows takes 240ms on Android.
 *
 * Easing is exported as raw cubic-bezier control points rather than an
 * `Easing.bezier(...)` object on purpose: this module is imported by
 * node-environment unit tests, and pulling in `react-native` here would break
 * them. `theme/motion.ts` turns these into real Easing functions.
 */
export const motion = {
  duration: {
    /** Tactile feedback: press states, hover-equivalents, focus. */
    instant: 120,
    /** State change: a control switching mode, a banner, a badge. */
    fast: 180,
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
 * The shadow colour is the desktop `--shadow-lift-color` hue (a warm near-black
 * rather than pure black) so a lifted panel reads as sitting over the Demli
 * ramp instead of punching a cold hole in it.
 */
const SHADOW_COLOR = "#080301";

export const elevation = {
  /** Floating overlay: mini bars, banners, anything resting above the page. */
  panel: {
    shadowColor: SHADOW_COLOR,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
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
