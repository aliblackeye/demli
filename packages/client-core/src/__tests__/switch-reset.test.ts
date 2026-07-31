import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SWITCH_STEPS,
  AccountSwitchTimeoutError,
  runAccountSwitch,
  type AccountSwitchEffects,
  type AccountSwitchStepId,
} from "../account-vault/index.js";

/**
 * Build a full effects object that records the order every step runs in.
 * Individual steps can be overridden to throw / hang.
 */
function recordingEffects(overrides: Partial<AccountSwitchEffects> = {}) {
  const order: AccountSwitchStepId[] = [];
  const track = (id: AccountSwitchStepId) => () => {
    order.push(id);
  };
  const effects: AccountSwitchEffects = {
    endActiveCall: track("endActiveCall"),
    voiceLeaveDispose: track("voiceLeaveDispose"),
    realtimeDisconnect: track("realtimeDisconnect"),
    activateToken: track("activateToken"),
    queryCacheClear: track("queryCacheClear"),
    storeReset: track("storeReset"),
    realtimeConnect: track("realtimeConnect"),
    pushReregister: track("pushReregister"),
    profileRefresh: track("profileRefresh"),
    ...overrides,
  };
  return { effects, order };
}

describe("ACCOUNT_SWITCH_STEPS", () => {
  it("declares the contract order: teardown → pivot → bringup", () => {
    expect(ACCOUNT_SWITCH_STEPS.map((s) => s.id)).toEqual([
      "endActiveCall",
      "voiceLeaveDispose",
      "realtimeDisconnect",
      "activateToken",
      "queryCacheClear",
      "storeReset",
      "realtimeConnect",
      "pushReregister",
      "profileRefresh",
    ]);
  });

  it("marks exactly one required step — the pivot", () => {
    const required = ACCOUNT_SWITCH_STEPS.filter((s) => s.required);
    expect(required.map((s) => s.id)).toEqual(["activateToken"]);
    expect(required[0]?.phase).toBe("pivot");
  });

  it("tears down before the pivot and brings up after it", () => {
    const ids = ACCOUNT_SWITCH_STEPS.map((s) => s.id);
    const pivot = ids.indexOf("activateToken");
    const teardown = ACCOUNT_SWITCH_STEPS.filter((s) => s.phase === "teardown");
    const bringup = ACCOUNT_SWITCH_STEPS.filter((s) => s.phase === "bringup");
    for (const s of teardown) expect(ids.indexOf(s.id)).toBeLessThan(pivot);
    for (const s of bringup) expect(ids.indexOf(s.id)).toBeGreaterThan(pivot);
    // Voice teardown must precede the realtime disconnect (a leave frame can still
    // ride the old socket).
    expect(ids.indexOf("voiceLeaveDispose")).toBeLessThan(ids.indexOf("realtimeDisconnect"));
    // The cache/store purge must precede the new connection so no new-token event
    // lands in an old-identity store.
    expect(ids.indexOf("queryCacheClear")).toBeLessThan(ids.indexOf("realtimeConnect"));
    expect(ids.indexOf("storeReset")).toBeLessThan(ids.indexOf("realtimeConnect"));
  });
});

describe("runAccountSwitch", () => {
  it("runs every step in contract order", async () => {
    const { effects, order } = recordingEffects();
    const result = await runAccountSwitch(effects);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(order).toEqual(ACCOUNT_SWITCH_STEPS.map((s) => s.id));
  });

  it("skips optional steps the platform does not implement", async () => {
    const order: AccountSwitchStepId[] = [];
    const track = (id: AccountSwitchStepId) => () => {
      order.push(id);
    };
    // Desktop-style: no push re-register, call teardown folded into voice.
    const effects: AccountSwitchEffects = {
      voiceLeaveDispose: track("voiceLeaveDispose"),
      realtimeDisconnect: track("realtimeDisconnect"),
      activateToken: track("activateToken"),
      queryCacheClear: track("queryCacheClear"),
      storeReset: track("storeReset"),
      realtimeConnect: track("realtimeConnect"),
    };
    const result = await runAccountSwitch(effects);
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      "voiceLeaveDispose",
      "realtimeDisconnect",
      "activateToken",
      "queryCacheClear",
      "storeReset",
      "realtimeConnect",
    ]);
  });

  it("records a teardown failure but continues the switch (best-effort)", async () => {
    const { effects, order } = recordingEffects({
      voiceLeaveDispose: () => {
        throw new Error("engine wedged");
      },
    });
    const result = await runAccountSwitch(effects);
    expect(result.ok).toBe(true);
    // The pivot and every bringup step still ran.
    expect(order).toContain("activateToken");
    expect(order).toContain("realtimeConnect");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.step).toBe("voiceLeaveDispose");
  });

  it("aborts when the pivot fails and does not run bringup", async () => {
    const { effects, order } = recordingEffects({
      activateToken: () => {
        throw new Error("token swap failed");
      },
    });
    const result = await runAccountSwitch(effects);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.step).toBe("activateToken");
    // Teardown ran, bringup did NOT.
    expect(order).toContain("realtimeDisconnect");
    expect(order).not.toContain("queryCacheClear");
    expect(order).not.toContain("realtimeConnect");
  });

  it("records a bringup failure but the switch still succeeds", async () => {
    const { effects } = recordingEffects({
      profileRefresh: () => Promise.reject(new Error("getMe 503")),
    });
    const result = await runAccountSwitch(effects);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.step).toBe("profileRefresh");
  });

  it("time-boxes a wedged teardown step and keeps going", async () => {
    const { effects, order } = recordingEffects({
      voiceLeaveDispose: () => new Promise<void>(() => {}), // never resolves
    });
    const result = await runAccountSwitch(effects, { teardownTimeoutMs: 10 });
    expect(result.ok).toBe(true);
    expect(result.errors[0]?.step).toBe("voiceLeaveDispose");
    expect(result.errors[0]?.error).toBeInstanceOf(AccountSwitchTimeoutError);
    // The switch still pivoted and brought the new session up.
    expect(order).toContain("activateToken");
    expect(order).toContain("realtimeConnect");
  });

  it("time-boxes a wedged BRINGUP step when bringupTimeoutMs is set", async () => {
    // A real-device hang: pushReregister (Expo/FCM token mint) or profileRefresh
    // (getMe on a bad network) never resolves. Without a bound the covering switch
    // overlay would stay up forever (the founder's black screen). Time-boxed, it is
    // recorded and the switch still completes → the overlay's finally clears.
    const { effects } = recordingEffects({
      pushReregister: () => new Promise<void>(() => {}), // never resolves
    });
    const start = Date.now();
    const result = await runAccountSwitch(effects, { bringupTimeoutMs: 10 });
    expect(Date.now() - start).toBeLessThan(1_000); // did NOT hang
    expect(result.ok).toBe(true); // the pivot committed; the switch stands
    expect(result.errors.map((e) => e.step)).toContain("pushReregister");
    expect(result.errors.find((e) => e.step === "pushReregister")?.error).toBeInstanceOf(
      AccountSwitchTimeoutError,
    );
  });

  it("does NOT time-box bringup by default (unbounded, prior behavior preserved)", async () => {
    // Desktop and any caller that doesn't opt in keep awaiting bringup unbounded.
    let ran = false;
    const { effects } = recordingEffects({
      profileRefresh: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            ran = true;
            resolve();
          }, 30),
        ),
    });
    const result = await runAccountSwitch(effects); // no bringupTimeoutMs
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(ran).toBe(true); // waited for it, no timeout error
  });

  it("awaits async effects (no fire-and-forget ordering hazard)", async () => {
    const order: AccountSwitchStepId[] = [];
    const delayedTrack = (id: AccountSwitchStepId, ms: number) => () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push(id);
          resolve();
        }, ms),
      );
    // Earlier step is SLOWER than the later one — only real awaiting preserves order.
    const effects: AccountSwitchEffects = {
      voiceLeaveDispose: delayedTrack("voiceLeaveDispose", 20),
      realtimeDisconnect: delayedTrack("realtimeDisconnect", 1),
      activateToken: delayedTrack("activateToken", 1),
      queryCacheClear: delayedTrack("queryCacheClear", 1),
      storeReset: delayedTrack("storeReset", 1),
      realtimeConnect: delayedTrack("realtimeConnect", 1),
    };
    await runAccountSwitch(effects);
    expect(order.indexOf("voiceLeaveDispose")).toBeLessThan(order.indexOf("realtimeDisconnect"));
  });
});
