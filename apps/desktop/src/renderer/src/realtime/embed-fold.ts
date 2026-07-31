import type { InfiniteData } from "@tanstack/react-query";
import type { MessageEmbed } from "@demli/types";
import type { MessagesPage } from "../lib/api-client";

type MessagesCache = InfiniteData<MessagesPage, string | null>;

/**
 * Two embed sets are equal for caching purposes when they preview the same URLs
 * with the same fetch stamps. The server replaces a message's cards wholesale, so
 * this cheap signature is enough to skip a redundant cache write (and the row
 * re-render it would cause) if `message.embeds_updated` re-fires unchanged.
 */
function sameEmbeds(a: MessageEmbed[] | undefined, b: MessageEmbed[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((embed, i) => {
    const other = b[i];
    return other !== undefined && embed.url === other.url && embed.fetchedAt === other.fetchedAt;
  });
}

/**
 * Fold an inbound link-preview set (`message.embeds_updated`, M17) onto its
 * cached message. The event carries the message's COMPLETE current card set (a
 * full replace — never empty), so we assign it directly.
 *
 * Pure and idempotent: returns the SAME cache reference when the message is not
 * on a loaded page or already holds these exact embeds, and rebuilds ONLY the
 * target message object (and the page/array around it) otherwise — so every
 * other message keeps its reference and the memoized rows never re-render (§27).
 */
export function foldMessageEmbeds(
  data: MessagesCache | undefined,
  messageId: string,
  embeds: MessageEmbed[],
): MessagesCache | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const messages = page.messages.map((m) => {
      if (m.id !== messageId || sameEmbeds(m.embeds, embeds)) return m;
      pageChanged = true;
      return { ...m, embeds };
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, messages };
  });
  return changed ? { ...data, pages } : data;
}
