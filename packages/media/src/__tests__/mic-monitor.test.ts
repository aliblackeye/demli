/**
 * The "Kendini dinle" anti-feedback save/restore policy, pinned as pure data.
 *
 * The engine executes these plans (mic-monitor.ts is imported by engine.ts); the
 * behaviour is also covered end-to-end in engine.test.ts. Testing the decision
 * separately is deliberate: "put the user's audio back EXACTLY as it was" is the
 * part that silently regresses — an over-eager restore unmutes someone who
 * muted themselves on purpose, which on a call is a privacy bug, not a cosmetic one.
 */

import { describe, expect, it } from "vitest";
import {
  monitorRestorePlan,
  monitorSuppressionPlan,
  type MonitorAudioSnapshot,
} from "../mic-monitor.js";

const snapshot = (micEnabled: boolean, deafened: boolean): MonitorAudioSnapshot => ({
  micEnabled,
  deafened,
});

describe("monitorSuppressionPlan", () => {
  it("deafens an ordinary live user (which also mutes the mic)", () => {
    expect(monitorSuppressionPlan(snapshot(true, false))).toEqual({
      deafen: true,
      mute: false,
    });
  });

  it("deafens a user who had already muted themselves", () => {
    // Deafen still has to happen — otherwise they would HEAR the room while the
    // monitor plays their own voice into it.
    expect(monitorSuppressionPlan(snapshot(false, false))).toEqual({
      deafen: true,
      mute: false,
    });
  });

  it("does nothing extra for an already-deafened user", () => {
    expect(monitorSuppressionPlan(snapshot(false, true))).toEqual({
      deafen: false,
      mute: false,
    });
  });

  it("defensively mutes a deafened user whose mic is somehow still live", () => {
    expect(monitorSuppressionPlan(snapshot(true, true))).toEqual({
      deafen: false,
      mute: true,
    });
  });
});

describe("monitorRestorePlan", () => {
  it("undeafens with NO extra mic call when we were the one who deafened", () => {
    // The engine's undeafen restores the pre-deafen mic value on its own; issuing
    // a second setMic would be a visible flicker (and a redundant publish).
    expect(monitorRestorePlan(snapshot(true, false), snapshot(false, true))).toEqual({
      undeafen: true,
      mic: null,
    });
  });

  it("undeafens for a user who was muted-but-not-deafened before", () => {
    // Same single call: undeafen restores micEnabled to the saved `false`.
    expect(monitorRestorePlan(snapshot(false, false), snapshot(false, true))).toEqual({
      undeafen: true,
      mic: null,
    });
  });

  it("leaves an already-deafened user deafened and does NOT touch their mic", () => {
    // Restoring a mic under a live deafen would silently UNDEAFEN them, because
    // setMic(true) undeafens.
    expect(monitorRestorePlan(snapshot(false, true), snapshot(false, true))).toEqual({
      undeafen: false,
      mic: null,
    });
  });

  it("issues no call at all when nothing actually changed", () => {
    expect(monitorRestorePlan(snapshot(true, false), snapshot(true, false))).toEqual({
      undeafen: false,
      mic: null,
    });
  });

  it("reconciles the mic when only the mute differs", () => {
    expect(monitorRestorePlan(snapshot(true, false), snapshot(false, false))).toEqual({
      undeafen: false,
      mic: true,
    });
    expect(monitorRestorePlan(snapshot(false, false), snapshot(true, false))).toEqual({
      undeafen: false,
      mic: false,
    });
  });

  it("round-trips every reachable pre-monitor state", () => {
    // Suppress → restore must be the identity on the observable audio state for
    // every state a user can actually be in when they flip the toggle.
    const reachable: MonitorAudioSnapshot[] = [
      snapshot(true, false), // live and hearing everyone
      snapshot(false, false), // muted themselves
      snapshot(false, true), // deafened themselves
    ];
    for (const saved of reachable) {
      const suppression = monitorSuppressionPlan(saved);
      const suppressed: MonitorAudioSnapshot = suppression.deafen
        ? { micEnabled: false, deafened: true }
        : { micEnabled: suppression.mute ? false : saved.micEnabled, deafened: saved.deafened };
      // Suppression must ALWAYS end with a silent mic — that is its whole job.
      expect(suppressed.micEnabled).toBe(false);

      const restore = monitorRestorePlan(saved, suppressed);
      const restored: MonitorAudioSnapshot = restore.undeafen
        ? // The engine's undeafen puts back the mic value it saved when we deafened.
          { micEnabled: saved.micEnabled, deafened: false }
        : { micEnabled: restore.mic ?? suppressed.micEnabled, deafened: suppressed.deafened };
      expect(restored).toEqual(saved);
    }
  });
});
