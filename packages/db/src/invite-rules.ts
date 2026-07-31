/**
 * Pure invite redeem rules — separated from the repository so they are
 * unit-testable without a database.
 */

export interface InviteRuleInput {
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
}

export type InviteRedeemBlock = "expired" | "exhausted";

export type InviteRuleResult = { ok: true } | { ok: false; reason: InviteRedeemBlock };

export function evaluateInviteRedeem(invite: InviteRuleInput, now: Date): InviteRuleResult {
  if (invite.expiresAt !== null && Date.parse(invite.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return { ok: false, reason: "exhausted" };
  }
  return { ok: true };
}
