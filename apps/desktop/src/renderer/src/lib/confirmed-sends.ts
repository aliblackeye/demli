/**
 * Which server message confirmed which optimistic send — kept so the thread can
 * render the confirmed message IN PLACE of its optimistic row.
 *
 * An optimistic send renders under the key `outbox-<nonce>`; its `message.created`
 * echo arrives with a server id. Keyed by that id, the row would unmount and
 * remount at the hand-over, replaying the arrival motion on every message the
 * viewer sends. Worse, the echo removes the outbox entry (a store update React
 * renders at once) a tick before the message lands in the query cache (whose
 * notifications are scheduled), so for one render the row vanished entirely.
 *
 * The echo handler records `serverId ↔ nonce` here; the chat data bridge then
 * (a) keys the confirmed message by its old optimistic key, and (b) keeps the
 * last optimistic copy on screen until the server copy is in the cache. Bounded
 * and short-lived: only the hand-over needs it.
 */

/** How long a just-confirmed send may stand in for its not-yet-cached server copy. */
export const CONFIRM_HANDOVER_MS = 5_000;
/** Cap on remembered confirmations (a session sends far fewer than this at once). */
const MAX_ENTRIES = 500;

interface Confirmation {
  serverId: string;
  nonce: string;
  confirmedAt: number;
}

const byServerId = new Map<string, Confirmation>();
const byNonce = new Map<string, Confirmation>();

/** The `message.created` echo of one of OUR sends: remember the pairing. */
export function rememberConfirmedSend(serverId: string, nonce: string, now = Date.now()): void {
  const entry: Confirmation = { serverId, nonce, confirmedAt: now };
  byServerId.set(serverId, entry);
  byNonce.set(nonce, entry);
  // Maps iterate in insertion order, so the first key is the oldest.
  while (byServerId.size > MAX_ENTRIES) {
    const oldest = byServerId.values().next().value as Confirmation | undefined;
    if (!oldest) break;
    byServerId.delete(oldest.serverId);
    byNonce.delete(oldest.nonce);
  }
}

/** The nonce of the optimistic send this server message confirmed, if any. */
export function confirmedNonceFor(serverId: string): string | null {
  return byServerId.get(serverId)?.nonce ?? null;
}

/**
 * The server id that confirmed `nonce`, while the hand-over window is open.
 * After it, a confirmation whose server copy never reached this cache must not
 * keep a ghost optimistic row alive.
 */
export function handoverServerIdFor(nonce: string, now = Date.now()): string | null {
  const entry = byNonce.get(nonce);
  if (!entry || now - entry.confirmedAt > CONFIRM_HANDOVER_MS) return null;
  return entry.serverId;
}

/** The virtualizer key an optimistic send renders under. */
export function outboxRowKey(nonce: string): string {
  return `outbox-${nonce}`;
}

/** Test-only reset. */
export function resetConfirmedSends(): void {
  byServerId.clear();
  byNonce.clear();
}
