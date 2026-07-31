/**
 * Shared timeout (mute) enforcement (migration 0020, ADR 0019 §3).
 *
 * A timeout is stored as ONE nullable column, `friend_group_members
 * .timed_out_until`. Everything else about the feature is enforcement, and
 * enforcement is the only part that makes it real: a row that says a user is
 * muted while they keep sending messages is not a feature, it is a lie in a
 * database (CLAUDE.md §35).
 *
 * The three paths a timeout must cut, and where each is gated:
 *
 *   1. sending a message   — REST `POST /channels/:id/messages` AND the WS
 *                            gateway's `message.send`. Both, always: a gate on
 *                            one transport is a gate on neither, because the
 *                            desktop client already speaks both.
 *   2. adding a reaction   — `PUT /messages/:id/reactions/:emoji`.
 *   3. joining voice       — `POST /media/token`. The token IS the join: no
 *                            token, no SFU connection, so refusing to mint one
 *                            is the authoritative block rather than a UI hint.
 *
 * Deliberately NOT cut: reading, removing your OWN reaction, leaving voice, and
 * deleting your own message. A timeout silences someone; it does not trap them
 * or take away the ability to undo something they already did.
 *
 * **Expiry is evaluated here, at query time**, never by a sweeper. `isTimedOut`
 * compares the stored instant to `Date.now()` on every check, so a timeout stops
 * applying the moment it lapses — with no job to schedule, nothing to miss across
 * a restart, and no window in which an expired mute is still enforced. A cron
 * would add moving parts to buy nothing: there is no side effect to run at the
 * expiry instant, because the state IS the comparison.
 */

import { isTimedOut } from "@demli/types";
import type { ApiError as ApiErrorType } from "../errors.js";
import { ApiError } from "../errors.js";

export { isTimedOut };

/**
 * The ONE user-facing message for a refused action, in the API's usual plain
 * register (§26 — never a raw error, never a stack trace). It names the reason
 * and the fact that it ends, because "you can't do that" with no cause is the
 * error message users file bugs about.
 */
export const TIMED_OUT_MESSAGE =
  "You are timed out in this server and cannot do that until it expires.";

/**
 * Throw `403 TIMED_OUT` when the member is currently timed out.
 *
 * Takes the raw stored value rather than a user + group id so the caller can pass
 * what it ALREADY has: `loadVisibleChannel` and `channels.findWithMembership`
 * both carry `timedOutUntil` out of the membership row they already read, so this
 * gate costs zero extra queries on the message-send hot path.
 */
export function assertNotTimedOut(timedOutUntil: Date | string | null | undefined): void {
  if (isTimedOut(timedOutUntil)) {
    throw new ApiError(403, "TIMED_OUT", TIMED_OUT_MESSAGE);
  }
}

/** Narrowing helper for tests/callers that want the error without throwing. */
export function timedOutError(): ApiErrorType {
  return new ApiError(403, "TIMED_OUT", TIMED_OUT_MESSAGE);
}
