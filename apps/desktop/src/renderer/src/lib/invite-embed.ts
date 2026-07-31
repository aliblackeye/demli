/**
 * Pure state logic for the in-chat invite embed card (davet kartı) — kept out
 * of the component so the button state machine is unit-testable.
 *
 * The card has two independent axes:
 *   1. What the PREVIEW said (loading / dead invite / transport failure / data).
 *   2. What the viewer's RELATION to the group is (member / not / just joined),
 *      which picks the button ("Katıl" vs "git" vs "Katıldın" + "git").
 */

import { ApiClientError } from "./api-client";

/** Why a preview shows the faded "this invite is gone" card. */
export type InviteDeadReason = "expired" | "exhausted" | "invalid";

/**
 * Classify a failed preview fetch.
 *
 *  - `dead`        → the INVITE is finished; faded card, friendly one-liner, no
 *                    button. GROUP_BANNED deliberately maps to the same neutral
 *                    `invalid` line as NOT_FOUND — a banned viewer must not be
 *                    able to tell the two apart (§28).
 *  - `unavailable` → WE failed (network/server/rate limit); the invite may be
 *                    fine, so the card says "couldn't load" and offers a retry
 *                    instead of lying that the invite is dead.
 */
export function invitePreviewProblem(
  error: unknown,
): { kind: "dead"; reason: InviteDeadReason } | { kind: "unavailable" } {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "INVITE_EXPIRED":
        return { kind: "dead", reason: "expired" };
      case "INVITE_EXHAUSTED":
        return { kind: "dead", reason: "exhausted" };
      case "NOT_FOUND":
      case "GROUP_BANNED":
      case "VALIDATION_ERROR":
        return { kind: "dead", reason: "invalid" };
      default:
        return { kind: "unavailable" };
    }
  }
  return { kind: "unavailable" };
}

/** Whether a failed preview fetch is worth an automatic retry (transport only). */
export function isRetryablePreviewError(error: unknown): boolean {
  if (error instanceof ApiClientError) {
    return error.code === "NETWORK" || error.code === "INTERNAL";
  }
  return true;
}

/** What the card's action area shows once a preview LOADED. */
export type InviteCardAction =
  | { action: "join" }
  | {
      action: "go";
      /** True right after a successful redeem — the card also shows "Katıldın". */
      joinedNow: boolean;
    };

/** The join/go button state machine (üye / değil / katıldı). */
export function resolveInviteCardAction(input: {
  alreadyMember: boolean;
  joined: boolean;
}): InviteCardAction {
  if (input.joined) return { action: "go", joinedNow: true };
  if (input.alreadyMember) return { action: "go", joinedNow: false };
  return { action: "join" };
}

/** How a failed REDEEM resolves on the card. */
export type InviteRedeemOutcome =
  | { kind: "dead"; reason: InviteDeadReason }
  /** CONFLICT — the server says we are already in; flip straight to "go". */
  | { kind: "member" }
  /** Transient — keep the join button, show a one-line error, allow retry. */
  | { kind: "retryable" };

export function inviteRedeemOutcome(error: unknown): InviteRedeemOutcome {
  if (error instanceof ApiClientError) {
    if (error.code === "CONFLICT") return { kind: "member" };
    const problem = invitePreviewProblem(error);
    if (problem.kind === "dead") return { kind: "dead", reason: problem.reason };
  }
  return { kind: "retryable" };
}
