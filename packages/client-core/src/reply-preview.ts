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
