import type { InfiniteData } from "@tanstack/react-query";
import type { MessagesPage } from "@demli/client-core";

type MessagesCache = InfiniteData<MessagesPage, string | null>;

/**
 * Fold a `message.pinned` / `message.unpinned` event onto its cached message
 * (M17). The events are deliberately THIN — they carry no message body — so all
 * this does is flip the boolean the row reads to draw its pin marker.
 *
 * Pure and idempotent: returns the SAME cache reference when the message is not
 * on a loaded page (pinning an old message is common, and there is nothing to
 * update in that case — the pin board query is invalidated separately) or when it
 * already carries this flag. Only the target message object and the page/array
 * around it are rebuilt, so every other message keeps its reference and the
 * memoized rows never re-render (§27) — the same contract as `foldMessageEmbeds`.
 */
export function foldMessagePin(
  data: MessagesCache | undefined,
  messageId: string,
  pinned: boolean,
): MessagesCache | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const messages = page.messages.map((m) => {
      // `?? false` normalizes the additive/optional field: an un-enriched message
      // omits `pinned` entirely, which reads identically to false.
      if (m.id !== messageId || (m.pinned ?? false) === pinned) return m;
      pageChanged = true;
      return { ...m, pinned };
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, messages };
  });
  return changed ? { ...data, pages } : data;
}
