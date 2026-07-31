/**
 * Pure aggregation of unread across a set of streams for the group rail (#110) —
 * the desktop mirror of the mobile `deriveServerUnread`. Mute semantics are
 * reused VERBATIM from the channel sidebar via {@link channelMuteModeFor} so a
 * rail badge and the in-panel channel badge never disagree:
 *   - "all"-muted stream      → contributes nothing.
 *   - "mentions"-muted stream → contributes only when the unread is a mention,
 *                               and adds NO count (its raw count would include
 *                               the muted plain messages — the badge falls back
 *                               to "1+" instead of a misleading number).
 *   - unmuted stream          → a plain unread lights the badge and adds its count.
 *
 * `groupId` is the enclosing server for its channels (group-mute precedence), or
 * `null` for home streams (DMs / flat group chats, channel-scope mute only).
 */
import { channelMuteModeFor, type MuteEntry } from "../stores/chat-store";

export interface StreamsUnread {
  /** Any unread the rail should surface. */
  unread: boolean;
  /** Any of those unreads is a direct @mention (stronger, accent badge). */
  mention: boolean;
  /** Sum of per-stream unread counts from unmuted contributing streams. */
  count: number;
}

export interface UnreadMaps {
  unreadChannelIds: Record<string, boolean>;
  mentionUnreadChannelIds: Record<string, boolean>;
  unreadCounts: Record<string, number>;
  notificationMutes: Record<string, MuteEntry>;
}

export function deriveStreamsUnread(
  maps: UnreadMaps,
  streamIds: readonly string[],
  groupId: string | null,
  now: number = Date.now(),
): StreamsUnread {
  let unread = false;
  let mention = false;
  let count = 0;
  for (const streamId of streamIds) {
    const muteMode = channelMuteModeFor(maps.notificationMutes, streamId, groupId, now);
    if (muteMode === "all") continue;
    const isMention = !!maps.mentionUnreadChannelIds[streamId];
    const rawUnread = !!maps.unreadChannelIds[streamId];
    const contributes = muteMode === "mentions" ? isMention : rawUnread;
    if (contributes) {
      unread = true;
      if (muteMode !== "mentions") count += maps.unreadCounts[streamId] ?? 0;
    }
    if (isMention) mention = true;
  }
  return { unread, mention, count };
}
