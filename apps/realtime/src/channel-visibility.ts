import type { Repositories } from "@demli/db";
import type { ChannelId, GroupId, UserId } from "@demli/types";

/**
 * The AUTHORITY for "may this user act on this channel right now?" on the
 * WebSocket side — the exact pair the REST guard `loadVisibleChannel`
 * (apps/api/src/lib/permissions.ts) applies: group membership AND the M9
 * role-visibility filter (ADR 0007).
 *
 * ## Why this exists as its own seam
 *
 * The gateway keeps a per-connection cache of the channels a socket can see
 * (`Connection.channelKinds`), seeded at handshake and kept fresh by the Redis
 * mutation bus. That cache is the right tool for the READ path: filtering every
 * fan-out through a live DB query would cost one round trip per recipient per
 * message (§27).
 *
 * It is the WRONG tool for an authorization decision, because its freshness is
 * only as good as the bus:
 *  - the group resync is fire-and-forget (`void handleGroupMutation(...)`), so a
 *    dropped or failing bus message leaves the cache stale with no retry;
 *  - an HTTP role change and the async resync it triggers are not ordered
 *    against a WS frame already in flight.
 *
 * Either one leaves a user WRITING INTO and LISTENING TO a restricted channel
 * they can no longer see. A restricted channel is a private conversation, so
 * that is a privacy boundary, not a consistency nicety — and a boundary may not
 * be decided by a cache that "is probably fresh".
 *
 * So: the cache stays as the cheap pre-filter and the fan-out filter; every
 * WRITE / JOIN decision (message.send, voice.join, watch.*) calls THIS, freshly,
 * with no memoization. The cost is one indexed query on paths that already do
 * several and are rate-limited per connection.
 *
 * Both the gateway and the watch-party coordinator import this one function so
 * the two can never drift into different answers.
 *
 * Answering "not visible" is deliberately indistinguishable from "not a member"
 * at every call site, mirroring the REST 404: a restricted channel never leaks
 * its own existence (ADR 0007, §28).
 */
export async function canSeeChannelFresh(
  repos: Repositories,
  groupId: GroupId,
  channelId: ChannelId,
  userId: UserId,
): Promise<boolean> {
  return repos.channelAccess.canUserSeeChannel(groupId, channelId, userId);
}
