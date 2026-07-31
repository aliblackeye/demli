/**
 * The app-root "that didn't work because of a block" notice channel (M18).
 *
 * Some block refusals have nowhere local to land: a DM send fails inside the
 * offline queue (whose error-key union is shared client-core code and has no
 * `blocked` member), and a DM call start fails inside the call controller, whose
 * only error hook logs for diagnostics. Both would otherwise be silent — the
 * message just fails, or the call button just does nothing (§26).
 *
 * So both publish here and one root-level component renders the result.
 *
 * A plain module-level callback, matching `setOutboxChannelGoneListener`: exactly
 * one component ever listens, so a store would add subscribers and re-renders for
 * nothing (§27). The payload is an ACTION, not a message — the component resolves
 * the catalog key at render, so a live language switch re-labels a visible notice.
 *
 * Every string reachable from here is direction-free by construction: the server
 * answers one `BLOCKED` code whether the caller blocked the other party or the
 * other way round, and telling those apart is exactly what a block must prevent
 * (§28, ADR 0017).
 */
import type { BlockedAction } from "./errors";

let listener: ((action: BlockedAction) => void) | null = null;

/** Register the root-level notice (`null` unregisters on unmount). */
export function setBlockedNoticeListener(
  next: ((action: BlockedAction) => void) | null,
): void {
  listener = next;
}

/** Announce that `action` was refused by a block. No-op when nothing is mounted. */
export function notifyBlocked(action: BlockedAction): void {
  listener?.(action);
}
