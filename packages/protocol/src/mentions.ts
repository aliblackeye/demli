/**
 * Mention wire format — the ONE canonical encoding for @mentions, shared by the
 * client tokenizer (render), the composer (encode on send), and the server
 * (detect recipients to notify). Defined here in @demli/protocol so there is
 * a SINGLE source of truth — no magic mention strings duplicated across the
 * client tokenizer and the server (CLAUDE.md §24: the protocol package is the
 * only place wire encodings are defined).
 *
 * Encoding stored in `message.content`: `<@TARGET>`, where TARGET
 * is either a user id or one of the broadcast keywords `everyone` / `here`. It
 * composes with the markdown tokenizer as a `mention` inline token; the display
 * name is resolved from the known members at RENDER time, never stored — so a
 * rename reflects everywhere and the content carries no display text to drift.
 *
 * Safety (CLAUDE.md §28): TARGET is always a bounded `[A-Za-z0-9_-]` run, so a
 * decoded mention value is always a substring of the message and never markup;
 * the tokenizer emits it into a TEXT node like every other token. The length cap
 * bounds the matcher against adversarial input.
 */

/** Broadcast mention keyword: everyone in the channel. */
export const MENTION_EVERYONE = "everyone";
/** Broadcast mention keyword: the online members of the channel. */
export const MENTION_HERE = "here";

/** The two broadcast (non-user) mention targets. */
export type BroadcastMentionTarget = typeof MENTION_EVERYONE | typeof MENTION_HERE;

/** Max characters in a mention target — bounds the matcher (UUIDs are 36). */
export const MENTION_TARGET_MAX = 64;

/** The allowed target run, as a source fragment shared by both regexes below. */
const MENTION_TARGET = `[A-Za-z0-9_-]{1,${MENTION_TARGET_MAX}}`;

/**
 * Matches a single mention token at the START of a slice — the tokenizer's
 * anchored matcher. Capture group 1 is the target. Non-global (no `lastIndex`
 * state), safe to reuse across calls.
 */
export const MENTION_AT_START = new RegExp(`^<@(${MENTION_TARGET})>`);

/** Encode a user id / broadcast keyword into its `<@TARGET>` wire form. */
export function encodeMention(target: string): string {
  return `<@${target}>`;
}

/**
 * Every mention target in a message body, in document order (may repeat). Pure —
 * used by the client tokenizer's fast-path detector and by the server to pick
 * notification recipients. The server MUST still validate each id against
 * channel membership before notifying (never trust the sender — §28).
 */
export function extractMentionTargets(content: string): string[] {
  const re = new RegExp(`<@(${MENTION_TARGET})>`, "g");
  const out: string[] = [];
  for (const match of content.matchAll(re)) out.push(match[1] as string);
  return out;
}

/** True when `target` is a broadcast keyword (`@everyone` / `@here`), not a user id. */
export function isBroadcastMentionTarget(target: string): target is BroadcastMentionTarget {
  return target === MENTION_EVERYONE || target === MENTION_HERE;
}

/**
 * True when `content` mentions `userId` — directly (`<@userId>`) or, when
 * `includeBroadcast` (default), via a broadcast keyword that targets everyone.
 * Cheap membership test for the in-app "you were mentioned" emphasis; callers
 * should pre-gate on `content.includes("<@")` to skip the scan for the common
 * plain message.
 */
export function contentMentionsUser(
  content: string,
  userId: string,
  includeBroadcast = true,
): boolean {
  for (const target of extractMentionTargets(content)) {
    if (target === userId) return true;
    if (includeBroadcast && isBroadcastMentionTarget(target)) return true;
  }
  return false;
}
