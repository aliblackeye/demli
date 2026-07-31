import { describe, expect, it } from "vitest";
import {
  runGuardedAccountSwitch,
  type AccountSwitchEffects,
  type AccountSwitchStepId,
  type TokenProbeResult,
} from "../account-vault/index.js";

interface TestAccount {
  accountId: string;
  token: string;
}

const TARGET: TestAccount = { accountId: "u_target", token: "tok_target" };
const PREVIOUS: TestAccount = { accountId: "u_prev", token: "tok_prev" };

/**
 * A per-account effect factory that records which account each step ran for, plus
 * optional per-step overrides (to inject a bringup failure). Every effect is
 * present (desktop/mobile both provide the always-on layers).
 */
function recordingFactory(overrides: Partial<Record<AccountSwitchStepId, (account: TestAccount) => void | Promise<void>>> = {}) {
  const ran: Array<{ step: AccountSwitchStepId; accountId: string }> = [];
  const makeEffects = (account: TestAccount): AccountSwitchEffects => {
    const track =
      (step: AccountSwitchStepId) =>
      (): void | Promise<void> => {
        ran.push({ step, accountId: account.accountId });
        return overrides[step]?.(account);
      };
    return {
      endActiveCall: track("endActiveCall"),
      voiceLeaveDispose: track("voiceLeaveDispose"),
      realtimeDisconnect: track("realtimeDisconnect"),
      activateToken: track("activateToken"),
      queryCacheClear: track("queryCacheClear"),
      storeReset: track("storeReset"),
      realtimeConnect: track("realtimeConnect"),
      pushReregister: track("pushReregister"),
      profileRefresh: track("profileRefresh"),
    };
  };
  const stepsFor = (accountId: string) => ran.filter((r) => r.accountId === accountId).map((r) => r.step);
  return { makeEffects, ran, stepsFor };
}

const probeReturning = (value: TokenProbeResult) => () => Promise.resolve(value);
const isUnauthorized = (error: unknown): boolean =>
  error instanceof Error && error.message === "UNAUTHORIZED";

describe("runGuardedAccountSwitch", () => {
  it("switches when the probe says the token is valid", async () => {
    const { makeEffects, stepsFor } = recordingFactory();
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("valid"),
      makeEffects,
    });
    expect(result.status).toBe("switched");
    expect(result.warning).toBe(false);
    expect(stepsFor("u_target")).toContain("activateToken");
  });

  it("does NOT pivot when the probe says the token is invalid (dead token)", async () => {
    const { makeEffects, ran } = recordingFactory();
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("invalid"),
      makeEffects,
    });
    expect(result.status).toBe("reauth");
    expect(result.account).toBe(TARGET);
    // The whole point: no teardown, no pivot — the current session is untouched.
    expect(ran).toHaveLength(0);
  });

  it("does NOT pivot when the target is unreachable", async () => {
    const { makeEffects, ran } = recordingFactory();
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("unreachable"),
      makeEffects,
    });
    expect(result.status).toBe("offline");
    expect(ran).toHaveLength(0);
  });

  it("surfaces a soft warning when a non-auth bringup step fails but the switch holds", async () => {
    const { makeEffects } = recordingFactory({
      profileRefresh: () => Promise.reject(new Error("getMe 503")),
    });
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("valid"),
      makeEffects,
      isAuthError: isUnauthorized,
    });
    expect(result.status).toBe("switched");
    expect(result.warning).toBe(true);
  });

  it("rolls back to the previous account when the token dies mid-switch (post-pivot 401)", async () => {
    const { makeEffects, stepsFor } = recordingFactory({
      // The probe passed, but the token died before profileRefresh — a 401 race.
      profileRefresh: (account) => {
        if (account.accountId === "u_target") return Promise.reject(new Error("UNAUTHORIZED"));
      },
    });
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("valid"),
      makeEffects,
      isAuthError: isUnauthorized,
    });
    expect(result.status).toBe("reauth");
    expect(result.account).toBe(TARGET);
    // We pivoted to the target, then rolled the whole ordered switch back onto previous.
    expect(stepsFor("u_target")).toContain("activateToken");
    expect(stepsFor("u_prev")).toContain("activateToken");
  });

  it("does not roll back on a post-pivot 401 when there is no previous account", async () => {
    const { makeEffects, stepsFor } = recordingFactory({
      profileRefresh: () => Promise.reject(new Error("UNAUTHORIZED")),
    });
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: null,
      probeToken: probeReturning("valid"),
      makeEffects,
      isAuthError: isUnauthorized,
    });
    // Nothing to fall back to → the switch stands (the platform then reauths/full-signs-out).
    expect(result.status).toBe("switched");
    expect(stepsFor("u_target")).toContain("activateToken");
  });

  it("restores the previous account and reports offline when the pivot itself fails", async () => {
    const { makeEffects, stepsFor } = recordingFactory({
      activateToken: (account) => {
        if (account.accountId === "u_target") throw new Error("vault write failed");
      },
    });
    const result = await runGuardedAccountSwitch({
      target: TARGET,
      previous: PREVIOUS,
      probeToken: probeReturning("valid"),
      makeEffects,
      isAuthError: isUnauthorized,
    });
    expect(result.status).toBe("offline");
    // Target pivot threw (no bringup); previous was brought back up.
    expect(stepsFor("u_target")).not.toContain("realtimeConnect");
    expect(stepsFor("u_prev")).toContain("realtimeConnect");
  });
});
