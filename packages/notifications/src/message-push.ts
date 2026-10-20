import { mentionPushBody } from "./mention-recipients.js";
import type { PushNotification } from "./push.js";

/**
 * Message / friend push builders shared by the REST API and the WS gateway, so
 * the two send paths cannot drift on delivery properties (field report
 * 2026-10-20). The `data` shapes are the client contract parsed by
 * apps/mobile/src/push/notification-target.ts — change both together.
 */

/**
 * How long an undelivered message push stays worth delivering. A phone that is
 * off for longer opens the app to the real, unread history instead of a pile of
 * stale banners; FCM's own default is four weeks.
 */
export const MESSAGE_PUSH_TTL_SECONDS = 3 * 24 * 60 * 60;

/** A friend request / acceptance stays relevant longer than a chat line. */
export const FRIEND_PUSH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Per-conversation collapse key for DM pushes: a DM burst becomes ONE rolling
 * notification per conversation (latest line) instead of N stacked banners —
 * the same rule a channel burst already follows (#94).
 */
export function dmPushCollapseKey(dmId: string): string {
  return `dm:${dmId}`;
}

/**
 * The DM message push. `userId` + `name` (the AUTHOR — the other participant
 * from the recipient's side) let the client open the DM screen with its header
 * and call buttons ready instead of a placeholder; `channelId` is the DM stream.
 */
export function dmMessagePush(input: {
  authorId: string;
  authorName: string;
  dmId: string;
  channelId: string;
  messageId: string;
  content: string;
}): PushNotification {
  return {
    title: input.authorName,
    body: mentionPushBody(input.content),
    data: {
      type: "dm_message",
      dmId: input.dmId,
      channelId: input.channelId,
      messageId: input.messageId,
      userId: input.authorId,
      name: input.authorName,
    },
    collapseKey: dmPushCollapseKey(input.dmId),
    ttlSeconds: MESSAGE_PUSH_TTL_SECONDS,
  };
}
