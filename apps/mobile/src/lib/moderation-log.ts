/**
 * Moderation audit log (M18) — the two decisions the screen must not get wrong,
 * kept pure so they are unit-testable without a renderer.
 *
 * Mirrors the desktop's `ServerSettingsDialog` gate and `ModerationLogTab`
 * flattening one-for-one; the API re-checks authority regardless, so the gate
 * here is only about never OFFERING a surface the server would refuse (§35).
 */

import { PERMISSIONS, type ModerationActionEntry, type PermissionBit } from "@demli/types";
import type { ModerationLogPage } from "./clients";

/**
 * Who may see the audit log: owner ∨ KICK_MEMBERS — the SAME gate the endpoint
 * enforces ("whoever may moderate may see what has been moderated"). Anyone else
 * never sees the entry at all, rather than a row that 403s on open.
 */
export function canSeeModerationLog(
  isOwner: boolean,
  can: (bit: PermissionBit) => boolean,
): boolean {
  return isOwner || can(PERMISSIONS.KICK_MEMBERS);
}

/**
 * Flatten the infinite-query pages into one newest-first list, DE-DUPLICATED by
 * action id.
 *
 * The server's cursor is a strict `(createdAt, id)` keyset, so a clean sequence
 * of pages cannot repeat an entry — but this list feeds a `FlatList` whose
 * `keyExtractor` is the action id, and a duplicate key there is a silent render
 * bug rather than a loud one. Deduplicating on the way in makes "a row can never
 * appear twice" a property of the data instead of a hope about the cursor.
 *
 * First occurrence wins, so page order (newest first) is preserved.
 */
export function flattenModerationLog(
  pages: readonly ModerationLogPage[] | undefined,
): ModerationActionEntry[] {
  const seen = new Set<string>();
  const out: ModerationActionEntry[] = [];
  for (const page of pages ?? []) {
    for (const entry of page.entries) {
      if (seen.has(entry.action.id)) continue;
      seen.add(entry.action.id);
      out.push(entry);
    }
  }
  return out;
}
