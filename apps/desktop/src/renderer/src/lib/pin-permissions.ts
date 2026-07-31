/**
 * Client-side mirror of the server's pin permission rule (M17).
 *
 * COSMETIC ONLY — the API is authoritative and re-checks every pin/unpin. This
 * exists so an unauthorized member never sees a "Pin message" item that would
 * only 403 (§35: no dead buttons), not as a security boundary.
 *
 * The rule, verbatim from the API contract:
 *   - the message's OWN author may pin it;
 *   - a member with MANAGE_MESSAGES (or the server owner) may pin anything;
 *   - in DMs and flat group chats — which have no role system — ANY member may
 *     pin, which is why a null server context resolves to true.
 *
 * SHAPE MATTERS FOR §27: the expensive half (roles + members) is a HOOK that a
 * list calls ONCE, and the per-message half is a pure function. Calling the hook
 * per message row would put two query subscriptions on every one of the ~50
 * mounted rows and re-render the whole scrollback whenever the member list
 * ticked.
 */

import { PERMISSIONS, type GroupId } from "@demli/types";
import { useServerPermissions } from "../queries/chat-queries";

// The per-message half lives in ./pin-rule (pure, unit-tested); re-exported here
// so callers still import the whole rule from one place.
export { canPinMessage } from "./pin-rule";

/**
 * Whether the viewer may pin ANY message in this surface, independent of author.
 * Call once per message list and pass the boolean down to the rows.
 *
 * @param groupId the SERVER the channel belongs to, or null for a DM / flat
 *                group chat (no roles → everyone may pin).
 */
export function useCanManageMessages(groupId: GroupId | null): boolean {
  const permissions = useServerPermissions(groupId);
  if (groupId === null) return true;
  return permissions.can(PERMISSIONS.MANAGE_MESSAGES);
}
