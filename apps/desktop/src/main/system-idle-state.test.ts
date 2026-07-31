/**
 * System-idle decision rules. The founder's rule is "bilgisayarda bir yere
 * dokunmayınca" — so these tests pin the two things that make that true: the
 * threshold is measured against the OS-WIDE clock, and sleep/lock count as away
 * instantly without waiting the clock out.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVE_POLL_MS,
  ACTIVE_STATE,
  IDLE_POLL_MS,
  pollDelayMs,
  resolveSystemIdleState,
  sameSystemIdleState,
  type SystemIdleInput,
} from "./system-idle-state";

const FIVE_MIN = 5 * 60_000;

function input(over: Partial<SystemIdleInput> = {}): SystemIdleInput {
  return {
    suspended: false,
    locked: false,
    idleSeconds: 0,
    thresholdMs: FIVE_MIN,
    ...over,
  };
}

describe("inactivity threshold", () => {
  it("stays active while the machine has seen input inside the budget", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: 0 }))).toEqual(ACTIVE_STATE);
    expect(resolveSystemIdleState(input({ idleSeconds: 299 }))).toEqual(ACTIVE_STATE);
  });

  it("goes away once the OS clock reaches the threshold", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: 300 }))).toEqual({
      idle: true,
      reason: "inactivity",
    });
    expect(resolveSystemIdleState(input({ idleSeconds: 4000 }))).toEqual({
      idle: true,
      reason: "inactivity",
    });
  });

  it("honours the caller's threshold rather than a hard-coded one", () => {
    const short = input({ idleSeconds: 45, thresholdMs: 30_000 });
    expect(resolveSystemIdleState(short).idle).toBe(true);
    const long = input({ idleSeconds: 45, thresholdMs: 10 * 60_000 });
    expect(resolveSystemIdleState(long).idle).toBe(false);
  });

  it("comes straight back to active as soon as the clock resets", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: 900 })).idle).toBe(true);
    // The user moved the mouse anywhere on the machine.
    expect(resolveSystemIdleState(input({ idleSeconds: 0 }))).toEqual(ACTIVE_STATE);
  });
});

describe("sleep and lock", () => {
  it("treats a locked session as away immediately, without waiting out the clock", () => {
    expect(resolveSystemIdleState(input({ locked: true, idleSeconds: 1 }))).toEqual({
      idle: true,
      reason: "locked",
    });
  });

  it("treats a sleeping machine as away immediately", () => {
    expect(resolveSystemIdleState(input({ suspended: true, idleSeconds: 1 }))).toEqual({
      idle: true,
      reason: "suspended",
    });
  });

  it("reports sleep over lock when both are in effect", () => {
    const state = resolveSystemIdleState(
      input({ suspended: true, locked: true, idleSeconds: 0 }),
    );
    expect(state.reason).toBe("suspended");
  });

  it("falls back to the still-locked state when only sleep ends", () => {
    // resume clears `suspended`; `unlock-screen` has not fired yet.
    expect(resolveSystemIdleState(input({ locked: true, idleSeconds: 0 })).reason).toBe(
      "locked",
    );
  });

  it("returns to active once unlocked and the user has touched something", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: 0 }))).toEqual(ACTIVE_STATE);
  });

  it("stays away after a wake that nobody was there for", () => {
    // Woken by a scheduled task: no sleep/lock flag any more, but no input either.
    expect(resolveSystemIdleState(input({ idleSeconds: 3600 })).idle).toBe(true);
  });
});

describe("fail safe", () => {
  it("reports ACTIVE when the platform cannot read the idle clock", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: null }))).toEqual(ACTIVE_STATE);
  });

  it("reports ACTIVE on a nonsense clock reading", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: Number.NaN }))).toEqual(
      ACTIVE_STATE,
    );
    expect(
      resolveSystemIdleState(input({ idleSeconds: Number.POSITIVE_INFINITY })),
    ).toEqual(ACTIVE_STATE);
  });

  it("never turns a negative clock reading into away", () => {
    expect(resolveSystemIdleState(input({ idleSeconds: -10 }))).toEqual(ACTIVE_STATE);
  });

  it("still honours sleep/lock when the clock is unreadable", () => {
    expect(
      resolveSystemIdleState(input({ idleSeconds: null, suspended: true })).idle,
    ).toBe(true);
  });
});

describe("transitions and polling", () => {
  it("only counts as a change when idle or reason actually moved", () => {
    expect(
      sameSystemIdleState({ idle: true, reason: "inactivity" }, { idle: true, reason: "inactivity" }),
    ).toBe(true);
    expect(
      sameSystemIdleState({ idle: true, reason: "inactivity" }, { idle: true, reason: "locked" }),
    ).toBe(false);
    expect(sameSystemIdleState(ACTIVE_STATE, { idle: true, reason: "locked" })).toBe(false);
  });

  it("polls faster while away so the comeback feels instant", () => {
    expect(pollDelayMs({ idle: true, reason: "inactivity" })).toBe(IDLE_POLL_MS);
    expect(pollDelayMs(ACTIVE_STATE)).toBe(ACTIVE_POLL_MS);
    expect(IDLE_POLL_MS).toBeLessThan(ACTIVE_POLL_MS);
  });
});
