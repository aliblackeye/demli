/**
 * The PURE half of the pin permission rule (M17), deliberately kept in its own
 * module with no React and no query imports.
 *
 * Two reasons for the split from ./pin-permissions (which owns the hook):
 *  - it is the part worth unit-testing, and a test must not drag the whole
 *    query/React module graph in to assert a boolean (the mobile twin,
 *    apps/mobile/src/lib/pin-rule.ts, carries the shared test);
 *  - it makes the boundary obvious: the expensive permission lookup happens ONCE
 *    per list (the hook), and this runs per message row.
 *
 * COSMETIC ONLY — the API re-checks every pin/unpin. This exists so an
 * unauthorized member never sees an action that would only 403 (§35).
 */

import type { UserId } from "@demli/types";

/**
 * Whether the viewer may pin/unpin a message authored by `authorId`.
 *
 * @param canManageMessages viewer holds MANAGE_MESSAGES / is the owner — or the
 *   surface has no role system at all (DM, flat group chat), where every member
 *   may pin. See `useCanManageMessages`.
 */
export function canPinMessage(
  canManageMessages: boolean,
  authorId: UserId,
  currentUserId: UserId | undefined,
): boolean {
  if (canManageMessages) return true;
  // The message's own author may always pin it.
  return currentUserId !== undefined && authorId === currentUserId;
}
