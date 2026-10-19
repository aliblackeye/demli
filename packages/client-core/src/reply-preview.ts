/**
 * The quoted line shown in a composer's reply bar.
 *
 * Lives here rather than beside either composer because BOTH need it and they
 * cannot share code otherwise: `@demli/app-ui` is a React-DOM package, so
 * `apps/mobile` cannot import from it. Duplicating the rule is how the two bars
 * drift into disagreeing about what "no text" looks like.
 *
 * The bar existed on every surface but the desktop/web one named only the
 * author — "Azra kişisine yanıt veriliyor" — and never the message. That does
 * not answer the question the bar is there to answer: WHICH message. Pick a
 * reply target in a busy channel, get pulled away, come back, and the only way
 * to find out what you were replying to is to cancel and start over.
 * Founder-reported, 2026-07-29.
 */

import { isBroadcastMentionTarget } from "@demli/protocol";
import { parseMessageMarkdown, type MarkdownInline } from "./markdown.js";

/**
 * One truncation-ready line for a quoted message.
 *
 * @param content   the quoted message's raw text (may be empty)
 * @param emptyLabel what to show when there is no text at all — an image or file
 *                  posted without a caption is ordinary, and an empty preview
 *                  reads as a broken bar rather than as "this one has no text"
 *
 * Whitespace is collapsed because the bar is a SINGLE line: left as-is, a
 * multi-line quote would show its first line and silently hide the rest with no
 * ellipsis, so the user would believe they were replying to something shorter
 * than they were. Length is deliberately NOT capped here — CSS truncation knows
 * the real width and draws a real ellipsis; a hard cut in JS would differ per
 * surface and lose that affordance.
 */
export function replyPreviewText(content: string, emptyLabel: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length > 0 ? flattened : emptyLabel;
}

/** A spoiler's stand-in in a one-line preview: says "hidden" without the text. */
export const PREVIEW_SPOILER = "•••";

function inlinePlain(
  nodes: readonly MarkdownInline[],
  resolveName: (userId: string) => string,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
      case "link":
        out += node.value;
        break;
      case "strong":
      case "em":
      case "strike":
        out += inlinePlain(node.children, resolveName);
        break;
      case "spoiler":
        out += PREVIEW_SPOILER;
        break;
      case "mention":
        out += `@${isBroadcastMentionTarget(node.id) ? node.id : resolveName(node.id)}`;
        break;
      case "emoji":
        // A preview line cannot draw the picture; the shortcode is what the
        // thread itself falls back to when an emoji is gone.
        out += `:${node.name}:`;
        break;
      case "break":
        out += " ";
        break;
    }
  }
  return out;
}

/**
 * A message's stored content as a person reads it, for places that show it as
 * ONE plain line (the long-press sheet header, a reply quote, the composer's
 * reply strip). Stored content is the wire form: `<@id>` mentions, `**`
 * markers, `||spoilers||`. Shown raw, a preview reads "selam <@0198f3…>".
 *
 * Mentions become `@Name` through `resolveName` (broadcasts stay `@everyone` /
 * `@here`), markup markers drop, a spoiler stays hidden as "•••", and code keeps
 * its text. Uses the same parser as the thread, so a preview never disagrees
 * with the message it quotes.
 */
export function messagePlainText(content: string, resolveName: (userId: string) => string): string {
  return parseMessageMarkdown(content)
    .map((block) =>
      block.type === "codeBlock" ? block.value : inlinePlain(block.children, resolveName),
    )
    .join(" ");
}

/**
 * {@link messagePlainText} flattened into a single preview line
 * ({@link replyPreviewText}). A quoted reply target is stored cut at
 * REPLY_PREVIEW_MAX characters, which can split a mention into a dangling
 * `<@0198f3…` at the very end; that fragment is dropped rather than shown.
 */
export function messagePreviewText(
  content: string,
  resolveName: (userId: string) => string,
  emptyLabel: string,
): string {
  const whole = content.replace(/<@[A-Za-z0-9_-]*$/, "");
  return replyPreviewText(messagePlainText(whole, resolveName), emptyLabel);
}
