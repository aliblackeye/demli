import type { Message } from "@demli/types";
import type { ChatDeliveryState, ChatMessageView } from "@demli/app-ui";

/**
 * Renderer view of a message: a confirmed server Message, or a queued outbox
 * entry (deliveryState "queued"/"sending"/"failed") awaiting its
 * message.created echo.
 *
 * The SHAPE is single-sourced in @demli/app-ui (so the shared message center
 * and the desktop row agree on one type); this alias keeps every existing
 * `../lib/chat-message` import working unchanged.
 */
export type { ChatDeliveryState };
export type ChatMessage = ChatMessageView;

export function toSentChatMessage(message: Message): ChatMessage {
  return { ...message, deliveryState: "sent", errorKey: null, nonce: null };
}
