import { describe, expect, it } from "vitest";
import { ApiClientError } from "./api-client";
import {
  invitePreviewProblem,
  inviteRedeemOutcome,
  isRetryablePreviewError,
  resolveInviteCardAction,
} from "./invite-embed";

function apiError(code: ConstructorParameters<typeof ApiClientError>[0]): ApiClientError {
  return new ApiClientError(code, "test", 400);
}

describe("invitePreviewProblem", () => {
  it("maps the dead-invite codes to their reasons", () => {
    expect(invitePreviewProblem(apiError("INVITE_EXPIRED"))).toEqual({
      kind: "dead",
      reason: "expired",
    });
    expect(invitePreviewProblem(apiError("INVITE_EXHAUSTED"))).toEqual({
      kind: "dead",
      reason: "exhausted",
    });
    expect(invitePreviewProblem(apiError("NOT_FOUND"))).toEqual({
      kind: "dead",
      reason: "invalid",
    });
  });

  it("GROUP_BANNED is indistinguishable from a plain invalid invite (§28)", () => {
    expect(invitePreviewProblem(apiError("GROUP_BANNED"))).toEqual(
      invitePreviewProblem(apiError("NOT_FOUND")),
    );
  });

  it("transport/server failures are 'unavailable', never 'dead'", () => {
    expect(invitePreviewProblem(apiError("NETWORK"))).toEqual({ kind: "unavailable" });
    expect(invitePreviewProblem(apiError("INTERNAL"))).toEqual({ kind: "unavailable" });
    expect(invitePreviewProblem(apiError("RATE_LIMITED"))).toEqual({ kind: "unavailable" });
    expect(invitePreviewProblem(new Error("boom"))).toEqual({ kind: "unavailable" });
  });
});

describe("isRetryablePreviewError", () => {
  it("retries transport, never a decided API answer", () => {
    expect(isRetryablePreviewError(apiError("NETWORK"))).toBe(true);
    expect(isRetryablePreviewError(apiError("INTERNAL"))).toBe(true);
    expect(isRetryablePreviewError(new Error("fetch failed"))).toBe(true);
    expect(isRetryablePreviewError(apiError("NOT_FOUND"))).toBe(false);
    expect(isRetryablePreviewError(apiError("INVITE_EXPIRED"))).toBe(false);
  });
});

describe("resolveInviteCardAction (buton durum makinesi)", () => {
  it("not a member → join", () => {
    expect(resolveInviteCardAction({ alreadyMember: false, joined: false })).toEqual({
      action: "join",
    });
  });

  it("already a member → go, without the 'joined' flash", () => {
    expect(resolveInviteCardAction({ alreadyMember: true, joined: false })).toEqual({
      action: "go",
      joinedNow: false,
    });
  });

  it("just joined → go + joined state (wins over alreadyMember refetch)", () => {
    expect(resolveInviteCardAction({ alreadyMember: false, joined: true })).toEqual({
      action: "go",
      joinedNow: true,
    });
    expect(resolveInviteCardAction({ alreadyMember: true, joined: true })).toEqual({
      action: "go",
      joinedNow: true,
    });
  });
});

describe("inviteRedeemOutcome", () => {
  it("CONFLICT means already a member → go", () => {
    expect(inviteRedeemOutcome(apiError("CONFLICT"))).toEqual({ kind: "member" });
  });

  it("a dead invite on redeem flips the card to the dead state", () => {
    expect(inviteRedeemOutcome(apiError("INVITE_EXPIRED"))).toEqual({
      kind: "dead",
      reason: "expired",
    });
    expect(inviteRedeemOutcome(apiError("GROUP_BANNED"))).toEqual({
      kind: "dead",
      reason: "invalid",
    });
  });

  it("anything transient keeps the join button retryable", () => {
    expect(inviteRedeemOutcome(apiError("NETWORK"))).toEqual({ kind: "retryable" });
    expect(inviteRedeemOutcome(apiError("RATE_LIMITED"))).toEqual({ kind: "retryable" });
    expect(inviteRedeemOutcome(new Error("boom"))).toEqual({ kind: "retryable" });
  });
});
