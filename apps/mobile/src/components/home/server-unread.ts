/**
 * Pure derivation of a per-server unread signal for the Home rail's server badge.
 *
 * The chat store tracks unread by CHANNEL id only (there is no channel→server
 * index), so the rail maps each server to its channel ids (read from the cached
 * group-details, see ServerRail) and aggregates. Mute semantics are reused
 * VERBATIM from the group screen via {@link effectiveChannelMuteMode} so a rail
 * badge and the in-panel channel badge never disagree:
 *   - "all"-muted channel      → contributes nothing.
 *   - "mentions"-muted channel → contributes only when the unread is a mention.
 *   - unmuted channel          → a plain unread lights the badge.
 *
 * The numeric `count` (#110) sums per-channel unread counts, but ONLY from
 * unmuted contributing channels — a "mentions"-muted channel's total would
 * include the muted plain messages, so it lights the badge (unread/mention) but
 * does not add a count; the badge then honestly shows "1+" (see
 * `unreadBadgeText`) rather than a number that includes muted noise.
 *
 * Kept pure (no store/query imports beyond the pure mute helper) so it is unit
 * tested under vitest's node env.
 */
import { activeMuteMode, effectiveChannelMuteMode, type MuteEntry } from "../../stores/chat-store";

export interface ServerUnread {
  /** Any unread the rail should surface as the neutral badge. */
  unread: boolean;
  /** Any of those unreads is a direct @mention (drives the stronger accent badge). */
  mention: boolean;
  /** Sum of per-channel unread counts from unmuted contributing channels (#110). */
  count: number;
}

/**
 * Aggregate `{ unread, mention, count }` per server from the channel-level unread
 * maps. Servers with no known channels (details not cached yet) simply get
 * `{ unread: false, mention: false, count: 0 }` — an honest "no signal until
 * visited".
 */
export function deriveServerUnread(
  channelIdsByServer: Record<string, readonly string[]>,
  unreadChannelIds: Record<string, boolean>,
  mentionUnreadChannelIds: Record<string, boolean>,
  unreadCounts: Record<string, number>,
  mutes: Record<string, MuteEntry>,
  now: number = Date.now(),
): Record<string, ServerUnread> {
  const out: Record<string, ServerUnread> = {};
  for (const [serverId, channelIds] of Object.entries(channelIdsByServer)) {
    let unread = false;
    let mention = false;
    let count = 0;
    for (const channelId of channelIds) {
      const muteMode = effectiveChannelMuteMode(mutes, channelId, serverId, now);
      if (muteMode === "all") continue; // fully silenced — no badge
      const isMention = !!mentionUnreadChannelIds[channelId];
      const rawUnread = !!unreadChannelIds[channelId];
      const contributes = muteMode === "mentions" ? isMention : rawUnread;
      if (contributes) {
        unread = true;
        // Only unmuted channels contribute a NUMBER — a mentions-muted channel's
        // raw count would count muted noise, so it lights the badge but its count
        // is left for the "1+" fallback.
        if (muteMode !== "mentions") count += unreadCounts[channelId] ?? 0;
      }
      if (isMention) mention = true;
    }
    out[serverId] = { unread, mention, count };
  }
  return out;
}

/** The Home tab's aggregate unread signal (#110): everything the Home surface holds. */
export interface HomeUnreadTotal {
  /** Total counted unread across servers + non-server streams (DMs, group chats). */
  count: number;
  /** Any of it is a direct @mention. */
  mention: boolean;
  /** Any unread at all (drives the badge even when `count` is 0 → "1+"). */
  hasUnread: boolean;
}

/**
 * Sum the Home tab badge total (#110). Server channels go through
 * {@link deriveServerUnread} (full group-mute precedence); every OTHER unread
 * stream — DMs, flat group chats, channels of not-yet-opened servers — is a
 * "home" stream muted only at its own channel scope. Honest by construction: a
 * fully "all"-muted stream never contributes.
 */
export function deriveHomeUnreadTotal(
  channelIdsByServer: Record<string, readonly string[]>,
  unreadChannelIds: Record<string, boolean>,
  mentionUnreadChannelIds: Record<string, boolean>,
  unreadCounts: Record<string, number>,
  mutes: Record<string, MuteEntry>,
  now: number = Date.now(),
): HomeUnreadTotal {
  const serverUnread = deriveServerUnread(
    channelIdsByServer,
    unreadChannelIds,
    mentionUnreadChannelIds,
    unreadCounts,
    mutes,
    now,
  );

  let count = 0;
  let mention = false;
  let hasUnread = false;
  const claimed = new Set<string>();
  for (const ids of Object.values(channelIdsByServer)) for (const id of ids) claimed.add(id);
  for (const s of Object.values(serverUnread)) {
    count += s.count;
    mention = mention || s.mention;
    hasUnread = hasUnread || s.unread;
  }

  // Non-server streams (DMs, group chats): channel-scope mute only, no enclosing group.
  for (const [streamId, isUnread] of Object.entries(unreadChannelIds)) {
    if (!isUnread || claimed.has(streamId)) continue;
    const muteMode = activeMuteMode(mutes, "channel", streamId, now);
    if (muteMode === "all") continue;
    const isMention = !!mentionUnreadChannelIds[streamId];
    if (muteMode === "mentions" && !isMention) continue;
    hasUnread = true;
    if (isMention) mention = true;
    if (muteMode !== "mentions") count += unreadCounts[streamId] ?? 0;
  }

  return { count, mention, hasUnread };
}
