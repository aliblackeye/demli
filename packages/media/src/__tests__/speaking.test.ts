/**
 * Local speaking detector (task #54): threshold + attack/release hysteresis.
 * Driven by explicit (level, now) samples with a virtual clock — no timers,
 * fully deterministic. Defaults: threshold 0.05, attack 50ms, release 400ms.
 */

import { describe, expect, it } from "vitest";
import { createSpeakingDetector } from "../speaking.js";

describe("speaking detector — attack (turn ON)", () => {
  it("starts silent", () => {
    const d = createSpeakingDetector();
    expect(d.speaking).toBe(false);
  });

  it("flips ON only after the level stays at/above threshold for attackMs", () => {
    const d = createSpeakingDetector();
    expect(d.push(0.2, 0)).toBe(false); // loud starts, attack timer begins
    expect(d.push(0.2, 49)).toBe(false); // 49ms < 50ms
    expect(d.push(0.2, 50)).toBe(true); // 50ms >= 50ms → ON
    expect(d.speaking).toBe(true);
  });

  it("does not trigger on a sub-attack blip, and restarts the attack timer after a dip", () => {
    const d = createSpeakingDetector();
    d.push(0.2, 0);
    expect(d.push(0.0, 20)).toBe(false); // dips quiet before 50ms → cancels pending
    d.push(0.2, 30); // loud again → attack timer restarts at 30
    expect(d.push(0.2, 79)).toBe(false); // only 49ms sustained
    expect(d.push(0.2, 80)).toBe(true); // 50ms sustained → ON
  });

  it("treats a level exactly at threshold as loud (>=)", () => {
    const d = createSpeakingDetector({ threshold: 0.05 });
    d.push(0.05, 0);
    expect(d.push(0.05, 50)).toBe(true);
  });

  it("treats non-finite or negative levels as silence", () => {
    const d = createSpeakingDetector();
    expect(d.push(Number.NaN, 0)).toBe(false);
    expect(d.push(-1, 50)).toBe(false);
    expect(d.push(Number.POSITIVE_INFINITY, 100)).toBe(false); // Infinite is not finite
    expect(d.speaking).toBe(false);
  });
});

describe("speaking detector — release (turn OFF)", () => {
  /** Drive the detector to the speaking state, returning it at t=50. */
  function speaking() {
    const d = createSpeakingDetector();
    d.push(0.2, 0);
    d.push(0.2, 50); // ON
    return d;
  }

  it("flips OFF only after the level stays below threshold for releaseMs", () => {
    const d = speaking();
    expect(d.push(0.0, 60)).toBe(true); // release timer begins
    expect(d.push(0.0, 459)).toBe(true); // 399ms < 400ms
    expect(d.push(0.0, 460)).toBe(false); // 400ms → OFF
    expect(d.speaking).toBe(false);
  });

  it("stays ON through a short gap between words (dip shorter than releaseMs)", () => {
    const d = speaking();
    d.push(0.0, 100); // release timer begins
    expect(d.push(0.2, 200)).toBe(true); // loud again before 400ms → cancels release
    d.push(0.0, 300); // release timer restarts at 300
    expect(d.push(0.0, 699)).toBe(true); // 399ms sustained
    expect(d.push(0.0, 700)).toBe(false); // 400ms sustained → OFF
  });

  it("reset() forces silent immediately and cancels a pending flip", () => {
    const d = speaking();
    expect(d.speaking).toBe(true);
    d.reset();
    expect(d.speaking).toBe(false);
    // A single loud sample right after reset must not instantly re-trigger.
    expect(d.push(0.2, 800)).toBe(false);
    expect(d.push(0.2, 850)).toBe(true); // needs the full attack again
  });
});

describe("speaking detector — custom tunables", () => {
  it("honours zero attack/release for instant switching", () => {
    const d = createSpeakingDetector({ threshold: 0.1, attackMs: 0, releaseMs: 0 });
    expect(d.push(0.1, 0)).toBe(true); // instant ON
    expect(d.push(0.05, 10)).toBe(false); // below threshold → instant OFF
  });

  it("uses a custom threshold", () => {
    const d = createSpeakingDetector({ threshold: 0.3, attackMs: 0 });
    expect(d.push(0.2, 0)).toBe(false); // below the higher bar
    expect(d.push(0.3, 10)).toBe(true);
  });
});
