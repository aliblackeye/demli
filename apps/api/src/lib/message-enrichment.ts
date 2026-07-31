/**
 * Message DTO enrichment for the reaction + reply features (ADR 0011). Sits
 * beside `attachments.ts` and follows the same no-N+1 batch shape: for a whole
 * page of messages, each enrichment issues exactly ONE query and grafts the
 * result onto the DTOs (`attachments.listForMessages`,
 * `messageReactions.summariesForMessages`, `messages.getReplyPreviews`).
 *
 * The list and REST-create paths both call {@link enrichMessages}, so the three
 * enrichments always run together and in the same order. `viewerId` is required
 * because `reactedByMe` is computed relative to the caller.
 *
 * Enrichment is ADDITIVE: a message with no reactions / no reply is returned
 * unchanged (no empty `reactions` array, no `replyTo` key), so text-only
 * messages and pre-M14 fixtures read identically to before.
 */

import type { MessageDTO } from "@demli/protocol";
import type { Repositories } from "@demli/db";
import type { Message, MessageId, UserId } from "@demli/types";
import { enrichMessagesWithAttachments } from "./attachments.js";

/**
 * Graft each message's aggregated reaction summary (ADR 0011 §1) onto its DTO in
 * ONE grouped query. `reactedByMe` is relative to `viewerId`. Messages with no
 * reactions are left untouched.
 */
export async function enrichMessagesWithReactions(
  repos: Repositories,
  messages: MessageDTO[],
  viewerId: UserId,
): Promise<MessageDTO[]> {
  if (messages.length === 0) return messages;
  const byMessage = await repos.messageReactions.summariesForMessages(
    messages.map((m) => m.id),
    viewerId,
  );
  return messages.map((message) => {
    const reactions = byMessage.get(message.id);
    if (!reactions || reactions.length === 0) return message;
    return { ...message, reactions };
  });
}

/**
 * Graft the reply preview (ADR 0011 §2) onto every message that replies to
 * another, in ONE `WHERE id IN (…)` lookup. The target ids come from the ORIGINAL
 * `Message[]` (`replyToMessageId` is the raw FK, deliberately stripped from the
 * wire DTO), so this reads `sources` alongside the DTOs it is decorating.
 *
 * A non-reply message keeps no `replyTo` key. A reply to a soft-deleted target
 * carries the "deleted" stub (`deleted: true`, blank content). A hard-deleted
 * target went `SET NULL`, so `replyToMessageId` is already null and the message
 * is treated as a non-reply. `?? null` guards the (unexpected) missing-row case.
 */
export async function enrichMessagesWithReplyPreviews(
  repos: Repositories,
  messages: MessageDTO[],
  sources: Message[],
): Promise<MessageDTO[]> {
  if (messages.length === 0) return messages;
  const targetIds = sources
    .map((m) => m.replyToMessageId)
    .filter((id): id is MessageId => id != null);
  if (targetIds.length === 0) return messages;

  const previews = await repos.messages.getReplyPreviews(targetIds);
  return messages.map((message, i) => {
    const replyToId = sources[i]?.replyToMessageId;
    if (!replyToId) return message;
    return { ...message, replyTo: previews.get(replyToId) ?? null };
  });
}

/**
 * Graft each message's link previews (M17) onto its DTO in ONE grouped query
 * (mirrors `attachments.listForMessages`). Messages with no embeds are left
 * untouched. Embeds are built ASYNCHRONOUSLY after send, so on the create-response
 * path they are simply absent (not ready yet); a reload's GET carries whatever the
 * unfurl service has since persisted.
 */
export async function enrichMessagesWithEmbeds(
  repos: Repositories,
  messages: MessageDTO[],
): Promise<MessageDTO[]> {
  if (messages.length === 0) return messages;
  const byMessage = await repos.messageEmbeds.listForMessages(messages.map((m) => m.id));
  return messages.map((message) => {
    const embeds = byMessage.get(message.id);
    if (!embeds || embeds.length === 0) return message;
    return { ...message, embeds };
  });
}

/**
 * Graft the pin flag (M17) onto each message in ONE `WHERE id IN (…)` lookup.
 * Only PINNED messages are touched — an unpinned message keeps no `pinned` key,
 * so absent reads identically to `false` and pre-M17 fixtures are unchanged
 * (the same additive shape as reactions/embeds).
 */
export async function enrichMessagesWithPins(
  repos: Repositories,
  messages: MessageDTO[],
): Promise<MessageDTO[]> {
  if (messages.length === 0) return messages;
  const pinned = await repos.messagePins.pinnedIdsForMessages(messages.map((m) => m.id));
  if (pinned.size === 0) return messages;
  return messages.map((message) =>
    pinned.has(message.id) ? { ...message, pinned: true } : message,
  );
}

/**
 * The one enrichment the list + create paths call: attachments → reactions →
 * reply previews → embeds → pins, each a single batched query (no N+1). Preserves
 * index alignment with `messages` so the reply-preview pass can read the raw
 * `replyToMessageId` off the source rows.
 */
export async function enrichMessages(
  repos: Repositories,
  messages: Message[],
  viewerId: UserId,
  /**
   * Authors the viewer has blocked / been blocked by (M18, ADR 0017). The page
   * ITSELF is already filtered in SQL, but a surviving message may QUOTE a
   * blocked user — so the reply preview is redacted here, otherwise blocking
   * would leak the exact text it is meant to hide through someone else's reply.
   * Omitted/empty ⇒ this pass is a no-op and the output is byte-identical to
   * pre-M18.
   */
  hiddenAuthorIds?: ReadonlySet<UserId>,
): Promise<MessageDTO[]> {
  if (messages.length === 0) return [];
  const withAttachments = await enrichMessagesWithAttachments(repos, messages);
  const withReactions = await enrichMessagesWithReactions(repos, withAttachments, viewerId);
  const withReplies = await enrichMessagesWithReplyPreviews(repos, withReactions, messages);
  const withEmbeds = await enrichMessagesWithEmbeds(repos, withReplies);
  const withPins = await enrichMessagesWithPins(repos, withEmbeds);
  return redactBlockedReplyPreviews(withPins, hiddenAuthorIds);
}

/**
 * Blank the CONTENT of any reply preview whose author is blocked (M18), reusing
 * the existing "deleted" stub shape so clients need no new rendering branch: the
 * quote box renders its placeholder instead of the blocked user's words. Pure and
 * synchronous — no extra query, since the preview already carries its `authorId`.
 */
function redactBlockedReplyPreviews(
  messages: MessageDTO[],
  hiddenAuthorIds?: ReadonlySet<UserId>,
): MessageDTO[] {
  if (!hiddenAuthorIds || hiddenAuthorIds.size === 0) return messages;
  return messages.map((message) => {
    const preview = message.replyTo;
    if (!preview || !hiddenAuthorIds.has(preview.authorId)) return message;
    return { ...message, replyTo: { ...preview, content: "", deleted: true } };
  });
}

/** Single-message convenience over {@link enrichMessages} (REST create response). */
export async function enrichMessage(
  repos: Repositories,
  message: Message,
  viewerId: UserId,
  hiddenAuthorIds?: ReadonlySet<UserId>,
): Promise<MessageDTO> {
  const [enriched] = await enrichMessages(repos, [message], viewerId, hiddenAuthorIds);
  return enriched ?? message;
}
