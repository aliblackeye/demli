/**
 * The app's `Text` / `TextInput` — a thin drop-in over React Native's, whose
 * only job is to put the brand typeface on every string in the app.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * React Native cannot synthesize weights for a custom font: on Android
 * `fontWeight` is IGNORED for any non-system family, so "Inter at
 * 600" has to be its own registered family (see theme/fonts.ts). That would
 * normally mean rewriting ~185 `fontWeight: "600"` literals into family names
 * by hand and remembering the rule forever.
 *
 * Instead, every call site keeps writing plain `fontWeight`, and this component
 * translates it into the right family at render time. Import `Text` from here
 * instead of from "react-native" and the whole thing is transparent.
 *
 * On the web/desktop side the browser does this matching itself from the
 * `@font-face` set in globals.css — this is the RN equivalent of that step, and
 * it uses the SAME faces (Inter 400/500/600, Onest 500/600/700).
 */

import { useMemo, type Ref } from "react";
import {
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextInputProps as RNTextInputProps,
  type TextStyle,
} from "react-native";
import { colors, fontFamily, typography } from "../../theme/theme";
import { withAlpha } from "./kit-math";

/**
 * Which of the two brand faces a string belongs to.
 *
 * - `body` (default) — Inter. Everything readable: messages, labels,
 *   descriptions, form fields.
 * - `display` — Onest. Chrome and emphasis: screen/section headings,
 *   sheet titles, big numeric callouts. Mirrors the desktop `font-display`
 *   utility, which is likewise opt-in rather than automatic.
 */
export type FontVariant = "body" | "display";

/**
 * Resolve a family name from the requested weight.
 *
 * The ladders stop where the desktop `@font-face` set stops, and heavier
 * requests clamp to the heaviest face we ship — exactly what a browser's
 * font-matching does with the same declarations, so a `fontWeight: "700"`
 * heading looks the same on Windows and Android instead of drifting apart.
 */
function familyFor(variant: FontVariant, weight: TextStyle["fontWeight"]): string {
  // `normal` / undefined / numeric-or-string weights all land here.
  const numeric =
    weight === "bold"
      ? 700
      : weight === "normal" || weight === undefined || weight === null
        ? 400
        : Number(weight);
  const w = Number.isFinite(numeric) ? (numeric as number) : 400;

  if (variant === "display") {
    // Onest: 500 / 600 / 700.
    if (w >= 700) return fontFamily.display.bold;
    if (w >= 600) return fontFamily.display.semibold;
    return fontFamily.display.medium;
  }

  // Inter: 400 / 500 / 600. Desktop ships no 700 either, so a 700 on
  // both platforms resolves to SemiBold.
  if (w >= 600) return fontFamily.body.semibold;
  if (w >= 500) return fontFamily.body.medium;
  return fontFamily.body.regular;
}

/**
 * Rewrite a style so the weight is expressed as a family.
 *
 * `fontWeight` is dropped once mapped: leaving it in lets Android draw a
 * SYNTHETIC bold on top of an already-bold face, which is the smeared,
 * too-heavy look that gives custom fonts on RN a bad name.
 *
 * An explicit `fontFamily` from the caller always wins and is passed through
 * untouched — that is how `MessageMarkdown` keeps its monospace face for code
 * spans, and monospace is a system family, so its `fontWeight` still works and
 * must survive.
 */
function applyFont(style: StyleProp<TextStyle>, variant: FontVariant): StyleProp<TextStyle> {
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  if (flat?.fontFamily) return style;

  const { fontWeight, ...rest } = flat ?? {};
  return { ...rest, fontFamily: familyFor(variant, fontWeight) };
}

/**
 * The type ramp as named steps, so a screen says "heading" instead of retyping
 * 18 / 600 / Onest. Each step is the mobile reading of the design-system scale
 * (docs/design-system §2): display steps use Onest, everything readable Inter.
 * Opt-in — `<Text style={...}>` without `type` behaves exactly as before.
 */
export const TEXT_TYPE = {
  /** Screen titles, big empty-state headings. */
  title: { variant: "display", style: { fontSize: 22, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2 } },
  /** Sheet / dialog / section titles. */
  heading: { variant: "display", style: { fontSize: 18, lineHeight: 24, fontWeight: "600", letterSpacing: -0.2 } },
  /** Card titles, row-group headers with weight. */
  subheading: { variant: "display", style: { fontSize: 16, lineHeight: 22, fontWeight: "600" } },
  /** Row titles, button labels, messages. */
  body: { variant: "body", style: { fontSize: 15, lineHeight: 21, fontWeight: "400" } },
  /** Dense UI copy — the desktop 14/19.6 step. */
  ui: { variant: "body", style: { fontSize: typography.size.body, lineHeight: 20, fontWeight: "500" } },
  /** Field labels, help and validation lines. */
  label: { variant: "body", style: { fontSize: typography.size.label, lineHeight: 18, fontWeight: "500" } },
  /** Subtitles and secondary lines. */
  meta: { variant: "body", style: { fontSize: typography.size.sm, lineHeight: 16, fontWeight: "500" } },
  /** Timestamps, section eyebrows. */
  caption: { variant: "body", style: { fontSize: typography.size["2xs"], lineHeight: 14, fontWeight: "500" } },
  /** Counters and pills. */
  badge: {
    variant: "body",
    style: { fontSize: typography.size.badge, lineHeight: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  },
} as const satisfies Record<string, { variant: FontVariant; style: TextStyle }>;

export type TextType = keyof typeof TEXT_TYPE;

/** Ink by role. `onAccent`/`onInverse` are for text sitting ON a light fill. */
export const TEXT_TONE = {
  default: colors.fg,
  display: colors.fgDisplay,
  muted: colors.fgMuted,
  faint: colors.fgFaint,
  accent: colors.accent,
  danger: colors.danger,
  success: colors.success,
  warning: colors.warning,
  onAccent: colors.onAccent,
  onInverse: colors.onInverse,
} as const;

export type TextTone = keyof typeof TEXT_TONE;

export type TextProps = RNTextProps & {
  /** `display` switches this string to Onest. Default: the `type`'s face, else `body`. */
  variant?: FontVariant;
  /** A named step of the type ramp (size, line height, weight, face). */
  type?: TextType;
  /** Ink colour by role. A `color` in `style` still wins. */
  tone?: TextTone;
  /** React 19 passes `ref` as a plain prop, so it just rides the spread. */
  ref?: Ref<RNText>;
};

/** Drop-in for RN's `Text`, wearing the brand typeface. */
export function Text({ style, variant, type, tone, ...props }: TextProps) {
  const styled = useMemo(() => {
    const preset = type ? TEXT_TYPE[type] : undefined;
    const face: FontVariant = variant ?? preset?.variant ?? "body";
    const composed: StyleProp<TextStyle> =
      preset || tone ? [preset?.style, tone ? { color: TEXT_TONE[tone] } : null, style] : style;
    return applyFont(composed, face);
  }, [style, variant, type, tone]);
  return <RNText {...props} style={styled} />;
}

/**
 * Instance type, so `useRef<TextInput>(null)` keeps working at call sites that
 * previously imported RN's class-like `TextInput`. A type alias and a function
 * may share a name — they live in different declaration namespaces.
 */
export type TextInput = RNTextInput;

export type TextInputProps = RNTextInputProps & {
  /** `display` switches this field to Onest. Default `body`. */
  variant?: FontVariant;
  /** React 19 passes `ref` as a plain prop, so it just rides the spread. */
  ref?: Ref<RNTextInput>;
};

/** Coral selection highlight — the accent at a third, so selected text stays legible. */
const SELECTION = withAlpha(colors.accent, 0.32);

/**
 * Drop-in for RN's `TextInput`, wearing the brand typeface and the Koyu Masa
 * coral caret + selection handles (every field in the app, not just the ones
 * built on TextField). Callers can still override any of the three.
 */
export function TextInput({ style, variant = "body", ...props }: TextInputProps) {
  const styled = useMemo(() => applyFont(style, variant), [style, variant]);
  return (
    <RNTextInput
      cursorColor={colors.accent}
      selectionColor={SELECTION}
      selectionHandleColor={colors.accent}
      {...props}
      style={styled}
    />
  );
}
