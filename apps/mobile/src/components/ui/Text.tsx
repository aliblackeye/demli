/**
 * The app's `Text` / `TextInput` — a thin drop-in over React Native's, whose
 * only job is to put the brand typeface on every string in the app.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * React Native cannot synthesize weights for a custom font: on Android
 * `fontWeight` is IGNORED for any non-system family, so "Instrument Sans at
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
 * it uses the SAME faces (Instrument Sans 400/500/600, Space Grotesk 500/600/700).
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
import { fontFamily } from "../../theme/theme";

/**
 * Which of the two brand faces a string belongs to.
 *
 * - `body` (default) — Instrument Sans. Everything readable: messages, labels,
 *   descriptions, form fields.
 * - `display` — Space Grotesk. Chrome and emphasis: screen/section headings,
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
    // Space Grotesk: 500 / 600 / 700.
    if (w >= 700) return fontFamily.display.bold;
    if (w >= 600) return fontFamily.display.semibold;
    return fontFamily.display.medium;
  }

  // Instrument Sans: 400 / 500 / 600. Desktop ships no 700 either, so a 700 on
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

export type TextProps = RNTextProps & {
  /** `display` switches this string to Space Grotesk. Default `body`. */
  variant?: FontVariant;
  /** React 19 passes `ref` as a plain prop, so it just rides the spread. */
  ref?: Ref<RNText>;
};

/** Drop-in for RN's `Text`, wearing the brand typeface. */
export function Text({ style, variant = "body", ...props }: TextProps) {
  const styled = useMemo(() => applyFont(style, variant), [style, variant]);
  return <RNText {...props} style={styled} />;
}

/**
 * Instance type, so `useRef<TextInput>(null)` keeps working at call sites that
 * previously imported RN's class-like `TextInput`. A type alias and a function
 * may share a name — they live in different declaration namespaces.
 */
export type TextInput = RNTextInput;

export type TextInputProps = RNTextInputProps & {
  /** `display` switches this field to Space Grotesk. Default `body`. */
  variant?: FontVariant;
  /** React 19 passes `ref` as a plain prop, so it just rides the spread. */
  ref?: Ref<RNTextInput>;
};

/** Drop-in for RN's `TextInput`, wearing the brand typeface. */
export function TextInput({ style, variant = "body", ...props }: TextInputProps) {
  const styled = useMemo(() => applyFont(style, variant), [style, variant]);
  return <RNTextInput {...props} style={styled} />;
}
