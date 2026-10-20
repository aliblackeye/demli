/**
 * Small pure helpers behind the mobile composer, kept apart so node tests can
 * pin them without loading React Native.
 */

import { foldMentionChar } from "@demli/client-core";

/**
 * Characters left before the message cap. Counts UTF-16 code units — the same
 * unit the TextInput's `maxLength` and the server's length check use — so the
 * counter reaches 0 exactly where typing stops.
 */
export function charsLeft(text: string, max: number): number {
  return Math.max(0, max - text.length);
}

/**
 * How many leading characters of `label` the typed `query` matches (prefix,
 * case-insensitive, Turkish-safe with the same fold the ranker uses) — the
 * bold part of a mention suggestion.
 * 0 when the query is empty or the label does not start with it (the ranker
 * may still have matched elsewhere, e.g. the @username; then nothing is bold).
 */
export function mentionMatchLength(label: string, query: string): number {
  if (query.length === 0 || query.length > label.length) return 0;
  for (let i = 0; i < query.length; i += 1) {
    if (foldMentionChar(label.charAt(i)) !== foldMentionChar(query.charAt(i))) return 0;
  }
  return query.length;
}
