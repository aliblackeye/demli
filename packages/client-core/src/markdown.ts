/**
 * Message markdown tokenizer — the ONE shared source of message formatting for
 * desktop AND mobile (ADR 0002 parity). Pure, React-free, DOM-free: it turns a
 * plain message string into a safe token tree; each platform renders the SAME
 * tokens with its own text primitive (desktop `<span>`, mobile `<Text>`), so a
 * message formats identically everywhere.
 *
 * Supported subset (deliberately bounded — NOT full CommonMark):
 *   **bold**            → strong
 *   *italic* / _italic_ → em          (`_` is word-boundary-aware: snake_case is
 *                                       never emphasised)
 *   ~~strike~~          → strike
 *   `inline code`       → code         (content is literal — no nested markdown)
 *   ```fenced block```  → codeBlock    (optional language on the opening fence)
 *   > quote / >>> quote → blockquote
 *   ||spoiler||         → spoiler      (renderer hides until pressed)
 *   http(s)://…         → link         (auto-linked; composes INSIDE formatting)
 *   <@id> / <@everyone> → mention      (highlighted pill; name resolved at render)
 *
 * Safety (CLAUDE.md §28): the tokenizer only ever emits `text`/`code`/`link`
 * VALUES (and a `mention.id` that is a bounded `[A-Za-z0-9_-]` substring) that
 * come from the input, plus structural nodes. There is no HTML, no raw markup,
 * and `link.href` is always a validated http(s) URL. A renderer puts every value
 * into a TEXT node — never `innerHTML` / `dangerouslySetInnerHTML` — so user
 * content stays escaped and un-injectable.
 */

import { MENTION_AT_START } from "@demli/protocol";

/** Deepest inline nesting the parser will descend before treating markup as literal text. */
const MAX_DEPTH = 8;

/** An inline (span-level) node inside a block. */
export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "strike"; children: MarkdownInline[] }
  | { type: "spoiler"; children: MarkdownInline[] }
  | { type: "code"; value: string }
  /** Auto-linked http(s) URL. `value` is the display text, `href` the target — equal for autolinks. */
  | { type: "link"; href: string; value: string }
  /**
   * A `<@id>` mention. `id` is a user id or a broadcast keyword
   * (`everyone`/`here`); the renderer resolves it to a display name from the
   * known members and draws a highlighted pill (never stores the name).
   */
  | { type: "mention"; id: string }
  /**
   * A `:name:` custom-emoji shortcode (M17). `name` is a bounded lowercase
   * `[a-z0-9_]` run — a substring of the input — so the node carries no markup
   * (§28). The token holds the NAME ONLY, never a resolved id or URL: the
   * renderer looks the name up in the emoji map of the group the message belongs
   * to, and falls back to rendering the literal `:name:` text when there is no
   * match. That is what makes deleting an emoji degrade gracefully instead of
   * leaving a broken image in the scrollback, and what keeps emoji group-scoped.
   */
  | { type: "emoji"; name: string }
  /** A hard line break between two lines of the same block. */
  | { type: "break" };

/** A block-level node. A message is an ordered list of these. */
export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "blockquote"; children: MarkdownInline[] }
  | { type: "codeBlock"; value: string; lang: string | null };

// ---------------------------------------------------------------------------
// URL trailing-punctuation peeling (kept behaviourally identical to the mobile
// linkify that shipped in the audit-B3 wave, so auto-links do not regress).
// ---------------------------------------------------------------------------

/** Matches an http/https URL run from the start of the slice; stops at the first whitespace. */
const URL_AT_START = /^https?:\/\/[^\s]+/i;

/**
 * Peel trailing sentence punctuation (and unbalanced closing brackets) off a
 * matched URL so "see https://x.com." drops the period while
 * "https://en.wikipedia.org/wiki/A_(B)" keeps its balanced paren. Returns the
 * URL core; the peeled tail is rendered back as plain text by the caller.
 */
function peelUrlTrailing(url: string): string {
  let core = url;
  for (;;) {
    const last = core[core.length - 1];
    if (last === undefined) break;
    if (".,;:!?".includes(last) || last === '"' || last === "'") {
      core = core.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = core.split(open).length - 1;
      const closes = core.split(last).length - 1;
      if (closes > opens) {
        core = core.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return core;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

interface InlineMatch {
  node: MarkdownInline;
  /** Index in the source immediately after the consumed run. */
  next: number;
}

/** True when `ch` is a "word" character (letters/digits/underscore) — used for `_` boundaries. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

/**
 * Find the closing `delim` for a run opened just before `start` (which is the
 * first inner char). Skips an immediate (empty-inner) match. When `tight`, a
 * candidate whose preceding char is whitespace is skipped, so `* x *`-style
 * spaced runs do not emphasise. Returns the close index, or -1.
 */
function findClose(text: string, delim: string, start: number, tight: boolean): number {
  let search = start;
  for (;;) {
    const close = text.indexOf(delim, search);
    if (close === -1) return -1;
    if (close === start) {
      search = close + delim.length;
      continue;
    }
    if (tight && /\s/.test(text[close - 1] ?? "")) {
      search = close + delim.length;
      continue;
    }
    return close;
  }
}

/**
 * Try to match a `delim`-wrapped inline (`**`, `*`, `~~`, `||`) at `i`. `tight`
 * additionally requires the run to not open or close on whitespace (used for the
 * single-`*` emphasis that would otherwise fire on prose like "2 * 3 * 4").
 */
function matchWrapped(
  text: string,
  i: number,
  delim: string,
  type: "strong" | "em" | "strike" | "spoiler",
  depth: number,
  tight: boolean,
): InlineMatch | null {
  const start = i + delim.length;
  if (tight && /\s/.test(text[start] ?? "")) return null;
  const close = findClose(text, delim, start, tight);
  if (close === -1) return null;
  const inner = text.slice(start, close);
  if (inner.trim().length === 0) return null;
  return {
    node: { type, children: parseInline(inner, depth + 1) },
    next: close + delim.length,
  };
}

/** Inline code `` `x` `` — content is literal (no nested markdown). */
function matchCode(text: string, i: number): InlineMatch | null {
  const close = text.indexOf("`", i + 1);
  if (close === -1) return null;
  const value = text.slice(i + 1, close);
  if (value.length === 0) return null;
  return { node: { type: "code", value }, next: close + 1 };
}

/** Word-boundary-aware `_italic_` — never fires inside snake_case identifiers. */
function matchUnderscoreEm(text: string, i: number, depth: number): InlineMatch | null {
  // Opening `_` must sit at a left word boundary and not precede whitespace.
  if (isWordChar(text[i - 1])) return null;
  if (/\s/.test(text[i + 1] ?? "")) return null;
  let search = i + 1;
  for (;;) {
    const close = text.indexOf("_", search);
    if (close === -1) return null;
    const inner = text.slice(i + 1, close);
    if (inner.length === 0 || /\s/.test(text[close - 1] ?? "")) {
      search = close + 1;
      continue;
    }
    // Closing `_` must sit at a right word boundary (so `a_b_c` stays literal).
    if (isWordChar(text[close + 1])) {
      search = close + 1;
      continue;
    }
    return {
      node: { type: "em", children: parseInline(inner, depth + 1) },
      next: close + 1,
    };
  }
}

/** Auto-link a bare http(s) URL at `i`, peeling trailing sentence punctuation. */
function matchUrl(text: string, i: number): InlineMatch | null {
  const m = URL_AT_START.exec(text.slice(i));
  if (!m) return null;
  const core = peelUrlTrailing(m[0]);
  if (core.length === 0) return null;
  return { node: { type: "link", href: core, value: core }, next: i + core.length };
}

/**
 * Match a `<@id>` mention at `i`. The id (capture 1) is a bounded
 * `[A-Za-z0-9_-]` run — a substring of the input — so the emitted node carries
 * no markup (§28). An unbalanced/oversized `<@…` falls through to literal text.
 */
function matchMention(text: string, i: number): InlineMatch | null {
  const m = MENTION_AT_START.exec(text.slice(i));
  if (!m) return null;
  return { node: { type: "mention", id: m[1] ?? "" }, next: i + m[0].length };
}

/**
 * Matches a `:name:` custom-emoji shortcode. The charset and length bounds
 * mirror `CUSTOM_EMOJI_NAME_PATTERN` in @demli/config, so the tokenizer can
 * never emit a name the server would have rejected. Case-insensitive on input
 * (names are stored lowercased); the emitted name is normalized to lowercase so
 * `:Cat:` and `:cat:` resolve to the same emoji.
 */
const EMOJI_AT_START = /^:([A-Za-z0-9_]{2,32}):/;

/**
 * Match a `:name:` shortcode at `i`. A colon that does not open a well-formed,
 * bounded shortcode falls through to literal text, so ordinary prose (`10:30`,
 * `note: this`, an emoticon) is completely unaffected.
 */
function matchCustomEmoji(text: string, i: number): InlineMatch | null {
  const m = EMOJI_AT_START.exec(text.slice(i));
  if (!m) return null;
  return { node: { type: "emoji", name: (m[1] ?? "").toLowerCase() }, next: i + m[0].length };
}

/** Try every inline rule at position `i`; returns the first hit or null (literal char). */
function matchInline(text: string, i: number, depth: number): InlineMatch | null {
  const c = text[i];
  if (c === "`") return matchCode(text, i);
  if (c === "|" && text[i + 1] === "|") return matchWrapped(text, i, "||", "spoiler", depth, false);
  if (c === "*" && text[i + 1] === "*") return matchWrapped(text, i, "**", "strong", depth, false);
  if (c === "~" && text[i + 1] === "~") return matchWrapped(text, i, "~~", "strike", depth, false);
  if (c === "*") return matchWrapped(text, i, "*", "em", depth, true);
  if (c === "_") return matchUnderscoreEm(text, i, depth);
  if (c === "<" && text[i + 1] === "@") return matchMention(text, i);
  if (c === ":") return matchCustomEmoji(text, i);
  if ((c === "h" || c === "H") && URL_AT_START.test(text.slice(i, i + 9))) return matchUrl(text, i);
  return null;
}

/** Parse one line of text into inline nodes. `depth` guards runaway nesting. */
function parseInline(text: string, depth: number): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      nodes.push({ type: "text", value: buf });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const match = depth < MAX_DEPTH ? matchInline(text, i, depth) : null;
    if (match) {
      flush();
      nodes.push(match.node);
      i = match.next;
    } else {
      buf += text[i] ?? "";
      i += 1;
    }
  }
  flush();
  return nodes;
}

/** Join lines into one inline stream, dropping outer blank lines and inserting hard breaks. */
function inlineLinesToNodes(rawLines: string[]): MarkdownInline[] {
  let start = 0;
  let end = rawLines.length;
  while (start < end && (rawLines[start] ?? "").trim() === "") start += 1;
  while (end > start && (rawLines[end - 1] ?? "").trim() === "") end -= 1;
  const nodes: MarkdownInline[] = [];
  for (let k = start; k < end; k += 1) {
    if (k > start) nodes.push({ type: "break" });
    for (const node of parseInline(rawLines[k] ?? "", 0)) nodes.push(node);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const FENCE = /^```(.*)$/;
const FENCE_CLOSE = /^```\s*$/;
const TRIPLE_QUOTE = /^>>>\s?(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/**
 * Tokenize a message into a safe block tree. Newlines are normalized; the input
 * is otherwise untouched. Always returns a fresh array (never mutates input).
 * An empty / whitespace-only message yields `[]`.
 */
export function parseMessageMarkdown(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const children = inlineLinesToNodes(paragraph);
    if (children.length > 0) blocks.push({ type: "paragraph", children });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block: everything until the closing ``` is literal. An
    // unclosed fence is NOT a code block — it falls through to normal text so it
    // cannot swallow the rest of the message.
    const fence = FENCE.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const codeLine = lines[j] ?? "";
        if (FENCE_CLOSE.test(codeLine)) {
          closed = true;
          break;
        }
        codeLines.push(codeLine);
        j += 1;
      }
      if (closed) {
        flushParagraph();
        const opener = (fence[1] ?? "").trim();
        let lang: string | null = null;
        if (opener.length > 0 && !/\s/.test(opener)) {
          lang = opener;
        } else if (opener.length > 0) {
          // Not a bare language token — treat the opener remainder as code.
          codeLines.unshift(opener);
        }
        blocks.push({ type: "codeBlock", value: codeLines.join("\n"), lang });
        i = j + 1;
        continue;
      }
    }

    // `>>>` — the rest of the message is one blockquote.
    const triple = TRIPLE_QUOTE.exec(line);
    if (triple) {
      flushParagraph();
      const quoteLines = [triple[1] ?? "", ...lines.slice(i + 1)];
      blocks.push({ type: "blockquote", children: inlineLinesToNodes(quoteLines) });
      break;
    }

    // `>` — a run of consecutive single-line quotes folds into one blockquote.
    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const quoteLines = [quote[1] ?? ""];
      let j = i + 1;
      while (j < lines.length) {
        const next = QUOTE.exec(lines[j] ?? "");
        if (!next) break;
        quoteLines.push(next[1] ?? "");
        j += 1;
      }
      blocks.push({ type: "blockquote", children: inlineLinesToNodes(quoteLines) });
      i = j;
      continue;
    }

    // Ordinary line (blank lines included, so intentional gaps survive).
    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * True when `input` contains any markup the tokenizer would format (a link, a
 * `<@` mention, or a `:name:` custom-emoji shortcode). Lets a renderer skip the
 * token walk for the overwhelmingly common plain-text message and render a
 * single flat text node instead.
 *
 * The emoji probe is the FULL shortcode pattern, not a bare `:`. A bare colon
 * would drag every `10:30`, `note: this` and `:)` through the tokenizer for
 * nothing — this keeps the fast path fast (§27) while guaranteeing that a
 * message the tokenizer WOULD turn into an emoji never skips it.
 */
export function hasMarkdown(input: string): boolean {
  return /[*_~`|>]|https?:\/\/|<@|:[A-Za-z0-9_]{2,32}:/.test(input);
}
