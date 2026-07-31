/**
 * Unit tests for the mobile boot-progress store.
 *
 * Two things matter here and nothing else:
 *  1. progress is REAL — it only moves on phases that were actually completed,
 *     and never exceeds 1 (CLAUDE.md §35, "no fake percentage");
 *  2. the splash ALWAYS closes — every exit route a boot can take must end at
 *     `status === "done"`. A splash that can hang makes the whole app look
 *     uninstallable, so each route is asserted explicitly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BLOCKING_BOOT_PHASES,
  BOOT_PHASES,
  isBlockingBootPhase,
  selectBootProgress,
  useBootStore,
  type BootPhase,
} from "../boot-store";

const store = () => useBootStore.getState();
const progress = () => selectBootProgress(useBootStore.getState());

describe("boot store", () => {
  beforeEach(() => store().resetBoot());

  it("starts on the first phase with zero progress", () => {
    expect(store().status).toBe("booting");
    expect(store().phase).toBe("fonts");
    expect(store().failedPhase).toBeNull();
    expect(progress()).toBe(0);
  });

  it("advances one phase at a time, in order, and finishes a signed-in boot", () => {
    const seen: (BootPhase | null)[] = [store().phase];
    for (const phase of BOOT_PHASES) {
      store().completeBootPhase(phase);
      seen.push(store().phase);
    }
    expect(seen).toEqual(["fonts", "i18n", "session", "data", "realtime", null]);
    expect(store().status).toBe("done");
    expect(progress()).toBe(1);
  });

  it("completing a phase is idempotent and never overshoots 1", () => {
    store().completeBootPhase("fonts");
    store().completeBootPhase("fonts");
    store().completeBootPhase("fonts");
    expect(store().completed).toEqual(["fonts"]);
    expect(progress()).toBeCloseTo(1 / 5);

    for (const phase of BOOT_PHASES) store().completeBootPhase(phase);
    for (const phase of BOOT_PHASES) store().completeBootPhase(phase);
    expect(progress()).toBe(1);
  });

  it("a signed-out boot drops the server phases and still reaches 100%", () => {
    store().completeBootPhase("fonts");
    store().completeBootPhase("i18n");
    // What BootPhaseBinder does when the session resolves to "unauthenticated".
    store().dropBootPhases("data", "realtime");
    store().completeBootPhase("session");

    expect(store().applicable).toEqual(["fonts", "i18n", "session"]);
    expect(store().status).toBe("done");
    expect(progress()).toBe(1);
  });

  it("dropping an already-completed phase keeps progress at most 1", () => {
    store().completeBootPhase("fonts");
    store().completeBootPhase("i18n");
    store().completeBootPhase("session");
    store().completeBootPhase("data");
    store().dropBootPhases("data", "realtime");

    expect(store().completed).toEqual(["fonts", "i18n", "session"]);
    expect(progress()).toBe(1);
  });

  it("degrading finishes an optional phase without claiming success", () => {
    for (const phase of ["fonts", "i18n", "session"] as const) store().completeBootPhase(phase);
    // Grace timers fired: no server payload, no socket.
    store().degradeBootPhase("data");
    store().degradeBootPhase("realtime");

    expect(store().status).toBe("done");
    expect(store().degraded).toEqual(["data", "realtime"]);
    expect(progress()).toBe(1);
  });

  it("degrading a phase that already succeeded does not mark it degraded", () => {
    store().completeBootPhase("fonts");
    store().degradeBootPhase("fonts");
    expect(store().degraded).toEqual([]);
  });

  it("only the phase currently being waited on can be marked failed", () => {
    store().failBootPhase("session"); // not the current phase yet
    expect(store().failedPhase).toBeNull();

    store().failBootPhase("fonts");
    expect(store().failedPhase).toBe("fonts");
  });

  it("completing the failed phase clears the error, and retry restarts the clock", () => {
    store().failBootPhase("fonts");
    store().completeBootPhase("fonts");
    expect(store().failedPhase).toBeNull();

    store().failBootPhase("i18n");
    expect(store().failedPhase).toBe("i18n");
    const before = store().phaseSince;
    store().clearBootFailure();
    expect(store().failedPhase).toBeNull();
    expect(store().phaseSince).toBeGreaterThanOrEqual(before);
  });

  it("phaseSince only moves when the phase itself changes", () => {
    const before = store().phaseSince;
    // A no-op complete (dropped phase) must not restart the stall watchdog.
    store().dropBootPhases("realtime");
    store().completeBootPhase("realtime");
    expect(store().phase).toBe("fonts");
    expect(store().phaseSince).toBe(before);
  });

  it("finishBoot is the last-resort escape hatch and closes the splash", () => {
    store().completeBootPhase("fonts");
    store().finishBoot();

    expect(store().status).toBe("done");
    expect(progress()).toBe(1);
    // Everything force-completed is reported as degraded, never as success.
    expect(store().degraded).toEqual(["i18n", "session", "data", "realtime"]);
    // Idempotent.
    store().finishBoot();
    expect(store().status).toBe("done");
  });

  it("every exit route ends with the splash closed", () => {
    const routes: Array<() => void> = [
      // Fully successful signed-in boot.
      () => {
        for (const phase of BOOT_PHASES) store().completeBootPhase(phase);
      },
      // Signed-out boot.
      () => {
        store().completeBootPhase("fonts");
        store().completeBootPhase("i18n");
        store().dropBootPhases("data", "realtime");
        store().completeBootPhase("session");
      },
      // Signed in, but the network never came back.
      () => {
        store().completeBootPhase("fonts");
        store().completeBootPhase("i18n");
        store().completeBootPhase("session");
        store().degradeBootPhase("data");
        store().degradeBootPhase("realtime");
      },
      // Nothing worked at all — the watchdog gave up.
      () => store().finishBoot(),
    ];

    for (const route of routes) {
      store().resetBoot();
      route();
      expect(store().status).toBe("done");
      expect(progress()).toBe(1);
    }
  });

  it("classifies exactly the pre-session phases as blocking", () => {
    for (const phase of BOOT_PHASES) {
      expect(isBlockingBootPhase(phase)).toBe(BLOCKING_BOOT_PHASES.includes(phase));
    }
    expect(isBlockingBootPhase(null)).toBe(false);
  });
});
