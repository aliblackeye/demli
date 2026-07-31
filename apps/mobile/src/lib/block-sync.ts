/**
 * What a block/unblock has to refresh (M18 / ADR 0017).
 *
 * A block is enforced SERVER-side across several surfaces at once, so the honest
 * client response is to refetch rather than patch. The exact key set lives here,
 * pure and exported, for two reasons: the mutation hooks and the
 * `user.blocks_updated` realtime handler must invalidate the SAME things (a
 * block lifted on another device has to land identically), and "the Blocked
 * users list refreshes after an unblock" is then a testable property instead of
 * a line buried in a mutation callback.
 */

import type { UserId } from "@demli/types";
import { queryKeys } from "./query-client";

/**
 * Every cache a block/unblock of `userId` invalidates:
 *
 * - `blocks`   — the Blocked users settings list itself.
 * - `profile`  — the target's card carries the `blocked` flag.
 * - friends + both request directions — a block severs the friendship AND any
 *   pending request in either direction.
 * - `dms`      — a blocked DM disappears from the list.
 * - messages   — shared-server history is filtered SERVER-side, so previously
 *   hidden messages reappear (or cached ones must vanish) only after a refetch.
 */
export function blockChangeQueryKeys(userId: UserId): readonly (readonly unknown[])[] {
  return [
    queryKeys.blocks,
    ["profile", userId],
    queryKeys.friends,
    queryKeys.friendRequests("incoming"),
    queryKeys.friendRequests("outgoing"),
    queryKeys.dms,
    queryKeys.allMessages,
  ];
}
