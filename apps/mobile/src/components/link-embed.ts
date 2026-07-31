import type { MessageEmbed } from "@demli/types";

/**
 * Pure render-logic helpers for the link-preview cards (M17). Kept free of any
 * react-native import so they run under the node-env unit tests, exactly like
 * the attachment sizing helpers.
 */

/** Cap so a message never floods the thread with preview cards. */
export const MAX_EMBEDS = 3;

/**
 * Only http(s) URLs are clickable/loadable (CLAUDE.md §28). The backend already
 * filters unfurled URLs, but the client re-checks so a malformed row can never
 * produce a live link. Matches the markdown link guard used elsewhere.
 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Bare host for a fallback accessible name — a tiny extractor that avoids the URL
 * constructor (incomplete under Hermes). Strips the scheme, any path/query, and a
 * leading `www.`; returns the input unchanged when it is not an http(s) URL.
 */
export function displayHost(url: string): string {
  const host = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  return host ? host.replace(/^www\./i, "") : url;
}

/** Cap a message's embed set to the render limit (returns the input unchanged
 *  when already within the cap, so the memoized card list keeps its reference). */
export function capEmbeds(embeds: MessageEmbed[]): MessageEmbed[] {
  return embeds.length > MAX_EMBEDS ? embeds.slice(0, MAX_EMBEDS) : embeds;
}
