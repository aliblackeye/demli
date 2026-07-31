/**
 * The shared building blocks every request schema in this directory is made of:
 * one text sanitizer, one visibility test, and the zod field factories that wrap
 * them.
 *
 * Why a sanitizer at all — a name field that accepts raw input accepts an
 * INVISIBLE one. A display name of three U+200B zero-width spaces passes
 * `min(1)`, renders as nothing, and leaves a blank row in the member list; a
 * name ending in U+202E flips the rest of the line right-to-left. Both are
 * perfectly valid strings to zod. So every free-text field runs through
 * {@link sanitizeText} INSIDE the schema — not in a handler someone can forget —
 * and name-shaped fields additionally require one genuinely visible character.
 *
 * What is deliberately NOT stripped: U+200C (ZWNJ) and U+200D (ZWJ). Both are
 * `\p{Cf}`, and a blanket `\p{Cf}` strip is the obvious implementation — but ZWJ
 * is what holds an emoji sequence together (a family emoji is three emoji joined
 * by two ZWJ) and ZWNJ is a real letter-shaping character in Persian, Hindi and
 * Arabic. Stripping them would silently mangle display names, statuses and bios,
 * so they survive. The "must contain something visible" rule is what actually
 * stops an all-invisible name, and the length caps stop invisible padding.
 *
 * Zero user-facing text lives here (ADR 0009): failures carry codes, which
 * `@demli/client-core`'s `forms/issue-to-error.ts` turns into i18n keys.
 */

import { z } from "zod";
import { customIssue } from "./codes.js";

/**
 * Format (`\p{Cf}`) and control (`\p{Cc}`) characters, EXCEPT the two joiners
 * that carry real meaning. Covers zero-width space, BOM, soft hyphen, word
 * joiner, the bidi overrides/isolates, and every C0/C1 control including tab,
 * CR and LF.
 */
// The keep-list is an ALTERNATION rather than a character class: a class that
// puts a zero-width joiner beside another code point reads as a possibly-
// misleading joined sequence (eslint `no-misleading-character-class`), because a
// ZWJ inside `[...]` looks like it is gluing the neighbours into one grapheme.
// Alternation says exactly the same thing with no ambiguity.
const INVISIBLE_SINGLE_LINE = /(?!\u200C|\u200D)[\p{Cf}\p{Cc}]/gu;

/** Same, but `\n` survives — the multiline variant (bios, message bodies). */
const INVISIBLE_MULTI_LINE = /(?!\u200C|\u200D|\n)[\p{Cf}\p{Cc}]/gu;

/** Whitespace + the invisible formatting characters that survive sanitizing. */
const NOT_VISIBLE = /[\s\p{Cf}]/gu;

/** Any line-break convention, normalized to `\n` before control chars are cut. */
const LINE_BREAKS = /\r\n?/g;

/** Options for {@link sanitizeText}. */
export interface SanitizeTextOptions {
  /** Keep `\n` (and normalize CRLF/CR to it). Default `false` — a single line. */
  multiline?: boolean;
}

/**
 * Trim, normalize line breaks, and delete invisible formatting/control
 * characters. The canonical transform for EVERY free-text field.
 *
 * Idempotent: sanitizing an already-sanitized value returns it unchanged, so it
 * is safe to run on both the client (fast local reject) and the API
 * (authoritative) without the two disagreeing about what was stored.
 */
export function sanitizeText(value: string, options?: SanitizeTextOptions): string {
  const multiline = options?.multiline === true;
  const normalized = multiline ? value.replace(LINE_BREAKS, "\n") : value;
  const stripped = normalized.replace(
    multiline ? INVISIBLE_MULTI_LINE : INVISIBLE_SINGLE_LINE,
    "",
  );
  return stripped.trim();
}

/**
 * True when `value` contains at least one character a human can actually see —
 * i.e. something that is neither whitespace nor an invisible format character.
 */
export function hasVisibleCharacter(value: string): boolean {
  return value.replace(NOT_VISIBLE, "").length > 0;
}

/** Options for {@link sanitizedText}. */
export interface SanitizedTextOptions {
  /** Minimum length AFTER sanitizing. Default `0` (an empty value is allowed). */
  min?: number;
  /** Maximum length AFTER sanitizing. */
  max: number;
  /** Allow `\n`. Default `false`. */
  multiline?: boolean;
  /**
   * Require at least one visible character. Defaults to `min > 0` — a field that
   * must be non-empty must be non-empty to a HUMAN, not just to `.length`.
   */
  requireVisible?: boolean;
}

/** A sanitized free-text field: string in, sanitized string out. */
export type TextField = z.ZodType<string, z.ZodTypeDef, string>;

/**
 * A free-text field: sanitized first, then length-checked on the sanitized value.
 *
 * The order matters and is the reason this is a factory rather than a
 * copy-pasted chain. Checking length BEFORE trimming rejects `"  Ali  "` at a
 * 5-char limit even though the stored value is 3 chars; checking AFTER means the
 * number the user is told ("max 64") is the number actually enforced.
 */
export function sanitizedText(options: SanitizedTextOptions): TextField {
  const { min = 0, max, multiline = false } = options;
  const requireVisible = options.requireVisible ?? min > 0;

  const base = z
    .string()
    .transform((value) => sanitizeText(value, { multiline }))
    .pipe(z.string().min(min).max(max));

  if (!requireVisible) return base;

  return base.superRefine((value, ctx) => {
    // Skipped when empty: `min` already reported that, and raising two issues for
    // one mistake makes a form show a second message the moment the first is fixed.
    if (value.length > 0 && !hasVisibleCharacter(value)) {
      ctx.addIssue(customIssue("noVisibleCharacter"));
    }
  });
}

/**
 * A short single-line name (server, channel, category, role): 1..`max`,
 * sanitized, at least one visible character.
 */
export function nameText(max: number): TextField {
  return sanitizedText({ min: 1, max, requireVisible: true });
}

/** Scheme + authority shape; the `URL` parse below is the real check. */
const HTTP_URL_SHAPE = /^https?:\/\/[^\s]+$/i;

/**
 * True when `value` is an absolute `http:`/`https:` URL.
 *
 * Deliberately stricter than zod's `.url()`, which only asks whether `new URL()`
 * succeeds — and it succeeds for `javascript:alert(1)` and `data:text/html,...`.
 * Those strings reach an `<img src>` or an `<a href>` as an avatar/icon/banner,
 * so "any parseable URL" is a stored-XSS hole, not a validation nicety.
 */
export function isHttpUrl(value: string): boolean {
  if (!HTTP_URL_SHAPE.test(value)) return false;
  // A runtime without a URL parser is theoretical (Node, browsers and RN all have
  // one), but falling back to the shape check beats throwing: the scheme — the
  // part that matters for XSS — has already been proven by the regex.
  if (typeof URL === "undefined") return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** An absolute http(s) URL, length-capped. Used for every avatar/icon/banner field. */
export function httpUrl(max: number): TextField {
  return z
    .string()
    .trim()
    .max(max)
    .superRefine((value, ctx) => {
      if (!isHttpUrl(value)) ctx.addIssue(customIssue("invalidUrl"));
    });
}
