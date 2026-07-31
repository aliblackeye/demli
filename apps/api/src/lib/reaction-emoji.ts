/**
 * Authoritative reaction-key validation — the unicode half (M17 widening).
 *
 * A reaction key is accepted when it is EITHER a single unicode emoji OR a
 * `:name:` custom-emoji shortcode that resolves to an emoji uploaded to the
 * message's group. This module owns the unicode test; the custom half is a
 * per-group DB lookup done at the route (it needs the channel's group). Together
 * they replace the old fixed 8-emoji whitelist (`isReactionEmoji`).
 *
 * The test uses the `v`-flag `\p{RGI_Emoji}` property of strings, which matches
 * EXACTLY ONE Recommended-for-General-Interchange emoji sequence — a plain glyph,
 * a variation-selector form (`❤️`), a skin-tone or a ZWJ family — and rejects
 * plain digits, bare letters, `#` / `*`, empty input and multi-emoji strings.
 *
 * SERVER-ONLY on purpose (§28, §23): the `v` flag is a PARSE error on older
 * browser engines (Safari 12 / iOS 12, the web target), so this must never be
 * bundled into a client. The API runs on Node ≥ 20 (here Node 22), where the
 * flag is supported. The Safari-safe half of the grammar (`parseCustomEmojiShort‑
 * code`) lives in the shared `@demli/config` leaf instead.
 */

/**
 * Matches a single RGI emoji sequence. Built via `new RegExp` (not a literal) on
 * purpose: the `v` flag is a runtime V8 feature (Node ≥ 20) but a `/…/v` LITERAL
 * would require the TS compiler `target` to be es2024+; the constructor form is
 * validated at runtime instead, keeping this file's build settings untouched.
 */
const SINGLE_RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

/**
 * True when `v` is exactly one valid unicode emoji. The unicode half of the
 * reaction gate; the custom-emoji half is a per-group lookup at the call site.
 */
export function isUnicodeEmojiReaction(v: string): boolean {
  return SINGLE_RGI_EMOJI.test(v);
}
