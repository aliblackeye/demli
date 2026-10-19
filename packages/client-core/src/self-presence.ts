/**
 * Self presence — how a client applies presence frames about ITS OWN USER.
 *
 * The gateway's contract (M16, stated on `PresencePayload` in packages/protocol):
 *
 *  - PEERS get the masked status (`invisible` arrives as `offline`).
 *  - The user's OWN sockets get `presence.updated` about themselves with the
 *    REAL account status. That is the multi-device channel: the account status is
 *    derived from every live connection (ADR 0020), so a `dnd` or `invisible`
 *    picked on the phone is what the desktop's own dot must show.
 *  - The `auth.succeeded` snapshot holds peers only.
 *
 * Until M16 the gateway broke all three: the user was in their own presence
 * audience, so they received the PEER mask about themselves — an invisible user
 * was told they were `offline`, live and in every handshake snapshot, and both
 * clients painted that on their own dot. The server is fixed; these two rules
 * are the client half, so a pre-M16 gateway (or any future regression of the
 * same kind) cannot repaint the user's own dot as gone.
 *
 * Framework-free and shared so desktop/web and mobile cannot disagree on what
 * their own dot does with a frame about themselves.
 */

import type { PresenceStatus, UserId } from "@demli/types";

/** The two fields every presence entry carries — snapshot entry or live payload. */
export interface PresenceEntryLike {
  userId: UserId;
  status: PresenceStatus;
}

/**
 * True when a `presence.updated` frame about `selfId` must be DROPPED rather
 * than painted: it says the user is `offline`.
 *
 * That is never true from where the client stands — it is reading the frame on
 * its own live socket — so it can only be a masked or stale value: exactly what
 * a pre-M16 gateway sent an invisible user. Every OTHER self status is painted,
 * because the server's real status is the account's derived truth, including
 * when it disagrees with this device's own pick (a phone's `dnd` outranks the
 * desktop's `online` for the whole account, ADR 0020) — hiding that would show
 * the user a status their friends are not seeing.
 *
 * Frames about anyone else are never dropped here (`offline` is a normal peer
 * value). `selfId` null/undefined (signed out) drops nothing.
 */
export function isStaleSelfPresence(
  frame: PresenceEntryLike,
  selfId: UserId | null | undefined,
): boolean {
  return selfId != null && frame.userId === selfId && frame.status === "offline";
}

/**
 * The handshake snapshot with any entry about `selfId` removed.
 *
 * The contract is that the snapshot never carries self; a pre-M16 gateway sent
 * self MASKED (an invisible user as `offline`). The client seeds its own dot from
 * its locally chosen status instead, so whatever a server put there for self is
 * discarded rather than relied on being overwritten by a later entry. Order of
 * the remaining entries is preserved; the input is not mutated.
 */
export function withoutSelfPresence<T extends { userId: UserId }>(
  entries: readonly T[],
  selfId: UserId | null | undefined,
): T[] {
  if (selfId == null) return [...entries];
  return entries.filter((entry) => entry.userId !== selfId);
}
