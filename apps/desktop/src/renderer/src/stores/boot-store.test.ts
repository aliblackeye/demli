/**
 * Boot-store rules. The one that matters most: a boot must always be able to
 * REACH "done" — a splash that can't finish is an app that doesn't open.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_PHASES,
  isBlockingBootPhase,
  selectBootProgress,
  useBootStore,
  type BootPhase,
} from "./boot-store";

const boot = () => useBootStore.getState();

beforeEach(() => {
  useBootStore.getState().resetBoot();
});

describe("boot phases", () => {
  it("starts on the first phase with zero progress", () => {
    expect(boot().status).toBe("booting");
    expect(boot().phase).toBe("shell");
    expect(selectBootProgress(boot())).toBe(0);
  });

  it("advances the current phase in order and only ever moves forward", () => {
    let last = 0;
    for (const phase of BOOT_PHASES) {
      expect(boot().phase).toBe(phase);
      boot().completeBootPhase(phase);
      const now = selectBootProgress(boot());
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(boot().status).toBe("done");
    expect(selectBootProgress(boot())).toBe(1);
  });

  it("is idempotent — completing a phase twice does not double-count", () => {
    boot().completeBootPhase("shell");
    boot().completeBootPhase("shell");
    expect(boot().completed).toEqual(["shell"]);
    expect(selectBootProgress(boot())).toBeCloseTo(1 / BOOT_PHASES.length);
  });

  it("reaches 100% on a signed-out boot, without faking the signed-in phases", () => {
    boot().completeBootPhase("shell");
    boot().completeBootPhase("i18n");
    // Landing on the login screen: no server payload, no socket.
    boot().dropBootPhases("data", "realtime");
    // Nothing to update (the common case, and every web boot).
    boot().dropBootPhases("update");
    boot().completeBootPhase("session");

    expect(boot().status).toBe("done");
    expect(selectBootProgress(boot())).toBe(1);
    // Honest: the dropped phases were never claimed as completed.
    expect(boot().completed).not.toContain("data");
    expect(boot().completed).not.toContain("realtime");
    expect(boot().completed).not.toContain("update");
  });

  /**
   * The startup-update phase must be INVISIBLE on a boot with no update to
   * install: same denominator, same bar, same copy as before the feature.
   */
  it("leaves the ordinary boot untouched once the update phase is dropped", () => {
    boot().dropBootPhases("update");
    expect(boot().applicable).toEqual(["shell", "i18n", "session", "data", "realtime"]);

    boot().completeBootPhase("shell");
    expect(selectBootProgress(boot())).toBeCloseTo(1 / 5);
    expect(boot().phase).toBe("i18n");

    for (const phase of ["i18n", "session", "data", "realtime"] as const) {
      boot().completeBootPhase(phase);
    }
    expect(boot().status).toBe("done");
    expect(selectBootProgress(boot())).toBe(1);
  });

  it("holds the boot open while the update phase is unresolved, and is not blocking", () => {
    for (const phase of ["shell", "i18n", "session", "data", "realtime"] as const) {
      boot().completeBootPhase(phase);
    }
    // Everything else is finished, yet the boot waits — that is what lets the
    // splash show the download instead of opening a stale build.
    expect(boot().status).toBe("booting");
    expect(boot().phase).toBe("update");
    // …but it can never reach the error/retry UI: a failed update is not a
    // failed startup.
    expect(isBlockingBootPhase("update")).toBe(false);

    boot().degradeBootPhase("update");
    expect(boot().status).toBe("done");
    expect(boot().degraded).toContain("update");
  });

  it("counts a degraded phase as finished but records that it did not succeed", () => {
    boot().degradeBootPhase("realtime");
    expect(boot().completed).toContain("realtime");
    expect(boot().degraded).toContain("realtime");
  });

  it("never lets progress exceed 1, whatever order phases settle in", () => {
    boot().completeBootPhase("realtime");
    boot().degradeBootPhase("data");
    boot().dropBootPhases("data", "realtime", "update");
    boot().completeBootPhase("shell");
    boot().completeBootPhase("i18n");
    boot().completeBootPhase("session");
    expect(selectBootProgress(boot())).toBe(1);
    expect(boot().status).toBe("done");
  });

  it("restarts the stall clock when the current phase changes", () => {
    const first = boot().phaseSince;
    boot().completeBootPhase("shell");
    expect(boot().phase).toBe("i18n");
    expect(boot().phaseSince).toBeGreaterThanOrEqual(first);
  });
});

describe("never traps the user", () => {
  it("finishBoot completes a boot stuck on ANY single phase", () => {
    for (const stuck of BOOT_PHASES) {
      useBootStore.getState().resetBoot();
      for (const phase of BOOT_PHASES) {
        if (phase !== stuck) boot().completeBootPhase(phase);
      }
      expect(boot().status).toBe("booting");
      expect(boot().phase).toBe(stuck);

      boot().finishBoot();

      expect(boot().status).toBe("done");
      expect(boot().phase).toBeNull();
      expect(selectBootProgress(boot())).toBe(1);
      // A force-finished phase is reported as degraded, never as a success.
      expect(boot().degraded).toContain(stuck);
    }
  });

  it("finishBoot completes a boot that made no progress at all", () => {
    boot().finishBoot();
    expect(boot().status).toBe("done");
    expect(selectBootProgress(boot())).toBe(1);
  });

  it("clears a recorded failure once its phase completes", () => {
    boot().completeBootPhase("shell");
    boot().completeBootPhase("i18n");
    boot().failBootPhase("session");
    expect(boot().failedPhase).toBe("session");

    boot().completeBootPhase("session");
    expect(boot().failedPhase).toBeNull();
  });

  it("only the current phase can be marked failed", () => {
    boot().failBootPhase("session");
    expect(boot().failedPhase).toBeNull();
  });

  it("a retry clears the failure and restarts the grace period", () => {
    boot().failBootPhase("shell");
    expect(boot().failedPhase).toBe("shell");
    const before = boot().phaseSince;
    boot().clearBootFailure();
    expect(boot().failedPhase).toBeNull();
    expect(boot().phaseSince).toBeGreaterThanOrEqual(before);
  });

  it("classifies only the phases the app truly cannot start without as blocking", () => {
    const blocking = BOOT_PHASES.filter((p: BootPhase) => isBlockingBootPhase(p));
    expect(blocking).toEqual(["shell", "i18n", "session"]);
    // The optional ones must never reach the error UI — they self-complete.
    expect(isBlockingBootPhase("data")).toBe(false);
    expect(isBlockingBootPhase("realtime")).toBe(false);
    expect(isBlockingBootPhase("update")).toBe(false);
    expect(isBlockingBootPhase(null)).toBe(false);
  });
});
