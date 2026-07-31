import { describe, expect, it } from "vitest";
import { evaluateInviteRedeem } from "../invite-rules.js";

const NOW = new Date("2026-07-02T12:00:00.000Z");

describe("evaluateInviteRedeem", () => {
  it("allows an invite without expiry or use cap", () => {
    expect(
      evaluateInviteRedeem({ expiresAt: null, maxUses: null, useCount: 999 }, NOW),
    ).toEqual({ ok: true });
  });

  it("allows an unexpired invite with remaining uses", () => {
    expect(
      evaluateInviteRedeem(
        { expiresAt: "2026-07-03T12:00:00.000Z", maxUses: 5, useCount: 4 },
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it("blocks an expired invite", () => {
    expect(
      evaluateInviteRedeem(
        { expiresAt: "2026-07-01T12:00:00.000Z", maxUses: null, useCount: 0 },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("treats the exact expiry instant as expired", () => {
    expect(
      evaluateInviteRedeem(
        { expiresAt: NOW.toISOString(), maxUses: null, useCount: 0 },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("blocks an exhausted invite", () => {
    expect(
      evaluateInviteRedeem({ expiresAt: null, maxUses: 3, useCount: 3 }, NOW),
    ).toEqual({ ok: false, reason: "exhausted" });
  });

  it("reports expiry before exhaustion when both apply", () => {
    expect(
      evaluateInviteRedeem(
        { expiresAt: "2020-01-01T00:00:00.000Z", maxUses: 1, useCount: 1 },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("treats maxUses 0 as never redeemable", () => {
    expect(
      evaluateInviteRedeem({ expiresAt: null, maxUses: 0, useCount: 0 }, NOW),
    ).toEqual({ ok: false, reason: "exhausted" });
  });
});
