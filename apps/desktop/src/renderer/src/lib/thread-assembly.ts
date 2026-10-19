import type { Message } from "@demli/types";
import type { OutboxMessage } from "../stores/chat-store";
import { toSentChatMessage, type ChatMessage } from "./chat-message";
import { confirmedNonceFor, handoverServerIdFor, outboxRowKey } from "./confirmed-sends";

/**
 * Ascending (oldest→newest) view of one channel's thread: the cached server pages
 * plus the optimistic outbox, with the optimistic → confirmed hand-over made
 * seamless (see `confirmed-sends.ts`).
 *
 * - Pages are newest-first and each page is newest-first internally, so both are
 *   walked backwards. Deduped by id — a realtime insert racing a refetch must
 *   never render twice.
 * - A server message that confirmed one of our sends keeps the optimistic row's
 *   key (`renderKey`), so the row is UPDATED in place rather than remounted.
 * - An optimistic entry whose echo already removed it from the outbox, but whose
 *   server copy is not in the cache yet, is carried for that render so the row
 *   never blinks out between the two updates.
 * - Optimistic sends render after everything confirmed.
 *
 * `carried` is the previous call's `snapshot`; the caller stores it (a ref).
 */
export function assembleThread(
  pages: readonly { messages: readonly Message[] }[],
  outbox: readonly OutboxMessage[],
  carried: ReadonlyMap<string, ChatMessage>,
  now = Date.now(),
): { messages: ChatMessage[]; snapshot: Map<string, ChatMessage> } {
  const seen = new Set<string>();
  const ascending: ChatMessage[] = [];
  for (let p = pages.length - 1; p >= 0; p--) {
    const page = pages[p];
    if (!page) continue;
    for (let i = page.messages.length - 1; i >= 0; i--) {
      const message = page.messages[i];
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id);
      const sent = toSentChatMessage(message);
      const nonce = confirmedNonceFor(message.id);
      ascending.push(nonce ? { ...sent, renderKey: outboxRowKey(nonce) } : sent);
    }
  }

  const snapshot = new Map<string, ChatMessage>();
  const live = new Set(outbox.map((pending) => pending.nonce));

  // Confirmed a moment ago, server copy still on its way: keep the last frame.
  for (const [nonce, previous] of carried) {
    if (live.has(nonce)) continue;
    const serverId = handoverServerIdFor(nonce, now);
    if (serverId === null || seen.has(serverId)) continue;
    ascending.push(previous);
    snapshot.set(nonce, previous);
  }

  for (const pending of outbox) {
    const message: ChatMessage = {
      id: outboxRowKey(pending.nonce),
      channelId: pending.channelId,
      authorId: pending.authorId,
      content: pending.content,
      createdAt: pending.createdAt,
      updatedAt: null,
      deletedAt: null,
      deliveryState: pending.deliveryState,
      errorKey: pending.errorKey,
      nonce: pending.nonce,
      attachments: pending.attachments,
      localAttachmentUrls: pending.localAttachmentUrls,
      replyTo: pending.replyTo,
    };
    ascending.push(message);
    snapshot.set(pending.nonce, message);
  }

  return { messages: ascending, snapshot };
}
