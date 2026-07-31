/**
 * Pure parsing of a push notification's `data` map into a routing target and a
 * suppression key (task #46). Deliberately free of react-native / expo imports
 * so it is unit-testable in vitest and stands as the single source of truth for
 * the client↔push-backend data contract (feat/fcm-backend).
 *
 * Expo/FCM `data` maps are string→string on the wire, so every field is read as
 * a string. Contract (reconciled by the Director at merge if the backend differs):
 *   - message push:        { type:"message", channelId, ...routing }
 *       channelId = the STREAM key the message is on (server channel id, or the
 *       DM / flat-group-chat streamId) — the same value chat-store.activeChannelId
 *       holds, so it drives foreground suppression for every surface.
 *       routing (one of):
 *         server channel:  groupId, name (channel name)
 *         dm:              dmId, userId?, name? (other participant)
 *         group chat:      groupChatId, name?
 *   - friend-request push: { type:"friend_request" }
 *   - call-invite push (ADR 0012): { type:"call_invite", callId, dmId } for a 1-1
 *       DM call, or { type:"call_invite", callId, groupId, voiceChannelId } for a
 *       seamless group-upgrade ring. The push only brings the app to the
 *       foreground near the call; the LIVE ring UI (accept/decline) is driven by
 *       the `call.invite` gateway event once the socket is up, so a tap routes to
 *       a safe landing (the friends list for a DM call, the group's voice channel
 *       for a group upgrade), never a half-populated DM screen.
 */

/** Where a tapped notification should take the user. */
export type NotificationTarget =
  | { kind: "friends" }
  | { kind: "dm"; dmId: string; streamId?: string; name?: string; userId?: string }
  | { kind: "groupChat"; groupChatId: string; name?: string }
  | { kind: "channel"; channelId: string; groupId?: string; name?: string }
  | { kind: "call"; dmId?: string; groupId?: string; voiceChannelId?: string; name?: string };

/** Read a data field as a trimmed non-empty string, or undefined. */
function str(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The stream key a message push is on (server channel id / DM / group-chat
 * streamId), used only for foreground suppression. Undefined for non-message
 * pushes (friend requests), which are never suppressed.
 */
export function streamIdOfPush(data: Record<string, unknown> | undefined): string | undefined {
  if (str(data, "type") === "friend_request") return undefined;
  return str(data, "channelId");
}

/**
 * Resolve a notification's `data` into a routing target, or null when it carries
 * nothing routable. Priority: friend request → DM → group chat → server channel.
 */
export function parseNotificationTarget(
  data: Record<string, unknown> | undefined,
): NotificationTarget | null {
  const type = str(data, "type");
  if (type === "friend_request" || type === "friend") return { kind: "friends" };

  const name = str(data, "name");

  // Call invite (ADR 0012) — route toward the call context; the live ring arrives
  // over the socket. Group-upgrade ring lands on the group's voice channel; a 1-1
  // DM call lands on the friends list (the DM screen needs a streamId this push
  // does not carry). Unroutable payloads fall through to null (app just opens).
  if (type === "call_invite") {
    const dmId = str(data, "dmId");
    if (dmId) return { kind: "call", dmId, name };
    const groupId = str(data, "groupId");
    const voiceChannelId = str(data, "voiceChannelId");
    if (groupId && voiceChannelId) return { kind: "call", groupId, voiceChannelId, name };
    return { kind: "friends" };
  }

  const dmId = str(data, "dmId");
  if (dmId) {
    return {
      kind: "dm",
      dmId,
      streamId: str(data, "channelId") ?? str(data, "streamId"),
      name,
      userId: str(data, "userId"),
    };
  }

  const groupChatId = str(data, "groupChatId");
  if (groupChatId) return { kind: "groupChat", groupChatId, name };

  const channelId = str(data, "channelId");
  if (channelId) return { kind: "channel", channelId, groupId: str(data, "groupId"), name };

  return null;
}
