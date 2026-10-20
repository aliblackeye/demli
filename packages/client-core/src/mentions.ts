/**
 * Composer-side @mention helpers — the SHARED logic both the desktop and mobile
 * composers use so autocomplete + send-serialization behave identically (ADR
 * 0002 parity). Pure, React-free, DOM-free: string in, string/data out. The wire
 * encoding itself (`<@id>`) lives in @demli/protocol; this module is only the
 * plain-textarea ⇄ encoded-content bridge.
 *
 * Model: the user sees and edits a friendly `@Display Name` in a plain text
 * input; each pick is remembered as a {@link PendingMention} ({ id, token }).
 * At send, {@link serializeMentions} rewrites each remembered token back to its
 * `<@id>` wire form. A mention the user partially deleted simply fails to match
 * and is sent as literal text — never corrupting the message (§26). Only an
 * explicitly PICKED mention becomes a real mention, so a bare "@everyone" typed
 * by hand is inert (a safety property, not a bug).
 */

import {
  MENTION_EVERYONE,
  MENTION_HERE,
  encodeMention,
  isBroadcastMentionTarget,
} from "@demli/protocol";

/** A user or broadcast keyword offered in the autocomplete list. */
export interface MentionCandidate {
  /** User id, or a broadcast keyword (`"everyone"` / `"here"`). */
  id: string;
  /** Display label WITHOUT the leading `@` (e.g. `"Ali Kara"`, `"everyone"`). */
  label: string;
  /** Username for secondary matching (users only); omitted for broadcast rows. */
  username?: string;
  /**
   * The candidate's `user.avatarUrl`, so the picker can draw the real face
   * instead of initials. Users only — broadcast rows render an `@` glyph and
   * never carry one. Optional because a broadcast row legitimately has none.
   */
  avatarUrl?: string | null;
  /** Broadcast rows (`@everyone` / `@here`) sort first and render distinctly. */
  broadcast?: boolean;
}

/**
 * A mention the user picked, remembered until send. `token` is the EXACT inserted
 * text including the leading `@` and excluding any trailing space (e.g.
 * `"@Ali Kara"`), so it can be found and replaced verbatim in the final text.
 */
export interface PendingMention {
  id: string;
  token: string;
}

/** The `@…` fragment the caret is currently inside, if any. */
export interface MentionQuery {
  /** The text after `@` up to the caret (never contains whitespace). */
  query: string;
  /** Index of the `@` that opened this fragment. */
  start: number;
}

/** Longest `@query` fragment the detector will scan back over (bounds work). */
const MAX_QUERY_SCAN = 64;

/** True for a char that may sit inside an `@query` fragment (no whitespace/`@`). */
function isQueryChar(ch: string): boolean {
  return !/\s/.test(ch) && ch !== "@";
}

/**
 * If the caret sits inside an `@mention` fragment, return the query text (after
 * `@`) and the `@`'s index; otherwise null. The opening `@` must start the text
 * or follow whitespace (so `email@host` never triggers), and the fragment is a
 * single whitespace-free run — you type `@ali`, then pick `Ali Kara` from the
 * filtered list.
 */
export function detectMentionQuery(text: string, caret: number): MentionQuery | null {
  const from = Math.max(0, caret - MAX_QUERY_SCAN);
  for (let i = caret - 1; i >= from; i -= 1) {
    const ch = text[i] ?? "";
    if (ch === "@") {
      const before = text[i - 1];
      if (before === undefined || /\s/.test(before)) {
        return { query: text.slice(i + 1, caret), start: i };
      }
      return null; // `@` glued to a word (e.g. an email) — not a mention
    }
    if (!isQueryChar(ch)) return null; // hit whitespace before any `@`
  }
  return null;
}

/**
 * One character folded for a case-insensitive, Turkish-safe name match.
 *
 * Plain `toLowerCase` is wrong for Turkish names in both directions: "İ" lowers
 * to "i" + U+0307 (so "İsmail" no longer starts with "is"), and "ı" never folds
 * to "i" (so "@ır" can't find "Irmak"). A person typing a name treats I / İ / ı
 * / i as the same letter, so they all fold to "i". Every other character takes
 * the FIRST code unit of its lower-case form, which keeps the folded string the
 * same length as the input — so an index into the folded text is an index into
 * the original (the composer bolds the matched prefix by that length).
 */
export function foldMentionChar(ch: string): string {
  if (ch === "I" || ch === "İ" || ch === "ı") return "i";
  return ch.toLowerCase().charAt(0);
}

/** {@link foldMentionChar} over a whole string; output length equals input length. */
export function foldMentionText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += foldMentionChar(text.charAt(i));
  return out;
}

/**
 * Rank candidates for a query: prefix matches first, then substring matches,
 * with broadcast rows (`@everyone`/`@here`) floated to the top when they match.
 * Case-insensitive and Turkish-safe ({@link foldMentionText}) over label +
 * username. Capped to `limit`. An empty query lists everything (broadcast
 * first), so opening the picker with a bare `@` shows the roster.
 */
export function rankMentionCandidates(
  query: string,
  candidates: MentionCandidate[],
  limit = 8,
): MentionCandidate[] {
  const q = foldMentionText(query.trim());
  const scored: { c: MentionCandidate; score: number }[] = [];
  for (const c of candidates) {
    const label = foldMentionText(c.label);
    const username = c.username ? foldMentionText(c.username) : "";
    let score: number;
    if (q.length === 0) {
      score = 2;
    } else if (label.startsWith(q) || username.startsWith(q)) {
      score = 3;
    } else if (label.includes(q) || username.includes(q)) {
      score = 1;
    } else {
      continue;
    }
    if (c.broadcast) score += 2; // float @everyone/@here to the top when matched
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label));
  return scored.slice(0, limit).map((s) => s.c);
}

/** The exact display token a picked candidate inserts, e.g. `"@Ali Kara"`. */
export function mentionToken(candidate: MentionCandidate): string {
  return `@${candidate.label}`;
}

/**
 * Replace the active `@query` fragment (from {@link detectMentionQuery}) with the
 * picked candidate's display token plus a trailing space, and report the new
 * caret position (just past the inserted space) so the input can restore it.
 */
export function applyMentionPick(
  text: string,
  fragmentStart: number,
  caret: number,
  candidate: MentionCandidate,
): { text: string; caret: number; pending: PendingMention } {
  const token = mentionToken(candidate);
  const insert = `${token} `;
  const next = text.slice(0, fragmentStart) + insert + text.slice(caret);
  return {
    text: next,
    caret: fragmentStart + insert.length,
    pending: { id: candidate.id, token },
  };
}

/**
 * Insert a mention the user picked from the USER MENU (right-click a person →
 * "Mention") rather than by typing `@`. There is no `@query` fragment to replace
 * here, so the insertion point IS the caret.
 *
 * This is the seam that keeps a menu mention identical to a typed one — same
 * token, same trailing space, same {@link PendingMention} — so it serializes to
 * `<@id>` on send instead of arriving as decorative text.
 *
 * The one thing it adds over a bare {@link applyMentionPick} is the LEFT
 * BOUNDARY. {@link serializeMentions} only rewrites a token whose `@` starts the
 * text or follows whitespace (deliberately — `email@host` must never become a
 * ping). Splicing at a caret that sits right after a word therefore produces
 * `selam@Ali`, which looks like a mention, is remembered as one, and is sent as
 * PLAIN TEXT — the worst possible failure, because nothing visibly went wrong
 * (§35). So a separating space is inserted when, and only when, the preceding
 * character needs one.
 *
 * @param text   current composer text
 * @param caret  insertion point (clamped into range)
 * @param mention the user to mention; `label` is already nickname-resolved
 */
export function applyMentionInsert(
  text: string,
  caret: number,
  mention: { id: string; label: string },
): { text: string; caret: number; pending: PendingMention } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text[at - 1];
  const needsSpace = before !== undefined && !/\s/.test(before);
  const withBoundary = needsSpace ? `${text.slice(0, at)} ${text.slice(at)}` : text;
  const insertAt = needsSpace ? at + 1 : at;
  return applyMentionPick(withBoundary, insertAt, insertAt, {
    id: mention.id,
    label: mention.label,
  });
}

/** A char that legally bounds a mention token (start/end handled by caller). */
function isBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || /[^A-Za-z0-9_]/.test(ch);
}

/**
 * Rewrite each remembered {@link PendingMention} token in `text` to its `<@id>`
 * wire form (the SEND transform). Longest tokens first so `@Alice` is consumed
 * before `@Ali`, and each pending entry replaces at most ONE occurrence (a
 * duplicate mention carries its own entry). Tokens that no longer appear
 * verbatim (the user edited them) are left as literal text.
 */
export function serializeMentions(text: string, mentions: PendingMention[]): string {
  let out = text;
  const ordered = [...mentions].sort((a, b) => b.token.length - a.token.length);
  for (const { id, token } of ordered) {
    let from = 0;
    for (;;) {
      const at = out.indexOf(token, from);
      if (at === -1) break;
      const before = out[at - 1];
      const after = out[at + token.length];
      // The `@` must sit at a left boundary; the token must end at a right
      // boundary — so `@Ali` never rewrites inside `@Alix` or `x@Ali`.
      if ((before === undefined || /\s/.test(before)) && isBoundaryChar(after)) {
        out = out.slice(0, at) + encodeMention(id) + out.slice(at + token.length);
        break;
      }
      from = at + token.length;
    }
  }
  return out;
}

/**
 * Inverse of {@link serializeMentions} for the EDIT path: turn stored `<@id>`
 * content back into friendly `@Display Name` text and rebuild the pending list,
 * so editing a message shows names (not raw ids) and re-serializes cleanly on
 * save. `resolveLabel` maps a user id to its display name; an unresolved id (a
 * left-since member) falls back to the id itself, and broadcast keywords render
 * as `@everyone` / `@here`.
 */
export function deserializeMentions(
  content: string,
  resolveLabel: (id: string) => string | null | undefined,
): { text: string; mentions: PendingMention[] } {
  const re = /<@([A-Za-z0-9_-]{1,64})>/g;
  const mentions: PendingMention[] = [];
  const text = content.replace(re, (_match, target: string) => {
    const label = isBroadcastMentionTarget(target)
      ? target
      : (resolveLabel(target) ?? target);
    const token = `@${label}`;
    mentions.push({ id: target, token });
    return token;
  });
  return { text, mentions };
}

/** Broadcast candidate rows (`@everyone`, `@here`) for the picker, in order. */
export const BROADCAST_MENTION_CANDIDATES: readonly MentionCandidate[] = [
  { id: MENTION_EVERYONE, label: MENTION_EVERYONE, broadcast: true },
  { id: MENTION_HERE, label: MENTION_HERE, broadcast: true },
];
