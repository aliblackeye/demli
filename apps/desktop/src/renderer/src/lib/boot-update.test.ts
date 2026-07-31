/**
 * Startup-update rules.
 *
 * The one that MATTERS: no feed condition may stop the app from opening. A slow
 * download, a stalled download, a dead feed, a check that never answers, an
 * installer that refuses to run — every single one has to end in a `release`
 * effect. The "never blocks forever" describe block sweeps all of them, and the
 * exhaustive stage sweep at the end makes it impossible to add a new waiting
 * stage without one.
 */

import { describe, expect, it } from "vitest";
import {
  BOOT_UPDATE_APPLY_FALLBACK_MS,
  BOOT_UPDATE_CHECK_BUDGET_MS,
  BOOT_UPDATE_DOWNLOAD_BUDGET_MS,
  BOOT_UPDATE_INSTALL_NOTICE_MS,
  BOOT_UPDATE_NEAR_DONE_GRACE_MS,
  BOOT_UPDATE_NEAR_DONE_PERCENT,
  BOOT_UPDATE_STALL_MS,
  initialBootUpdateState,
  isBootUpdateActive,
  reduceBootUpdate,
  selectBootUpdateDisplay,
  type BootUpdateEffect,
  type BootUpdateEvent,
  type BootUpdateStage,
  type BootUpdateState,
} from "./boot-update";
import type { UpdateStatus } from "./update-status";

// ---------------------------------------------------------------------------
// Harness — a tiny driver so each test reads as a timeline.
// ---------------------------------------------------------------------------

const T0 = 1_000_000;

class Flow {
  state: BootUpdateState = initialBootUpdateState();
  effects: BootUpdateEffect[] = [];
  now = T0;

  private send(event: BootUpdateEvent): this {
    const result = reduceBootUpdate(this.state, event);
    this.state = result.state;
    this.effects.push(...result.effects);
    return this;
  }

  /** Arm the flow (desktop by default). */
  arm(supported = true): this {
    return this.send({ type: "arm", at: this.now, supported });
  }

  status(status: UpdateStatus): this {
    return this.send({ type: "status", at: this.now, status });
  }

  abandon(): this {
    return this.send({ type: "abandon", at: this.now });
  }

  /** Advance the clock, ticking the way the binder's interval would. */
  advance(ms: number, step = 250): this {
    const target = this.now + ms;
    while (this.now < target) {
      this.now = Math.min(this.now + step, target);
      this.send({ type: "tick", at: this.now });
    }
    return this;
  }

  get released(): boolean {
    return this.state.stage === "released";
  }

  get reasons(): string[] {
    return this.effects
      .filter((e): e is Extract<BootUpdateEffect, { type: "release" }> => e.type === "release")
      .map((e) => e.reason);
  }

  get kinds(): string[] {
    return this.effects.map((e) => e.type);
  }
}

const available = (critical = false): UpdateStatus => ({
  kind: "available",
  version: "1.2.3",
  critical,
});
const downloading = (percent: number, critical = false): UpdateStatus => ({
  kind: "downloading",
  version: "1.2.3",
  percent,
  critical,
});
const ready = (critical = false): UpdateStatus => ({
  kind: "ready",
  version: "1.2.3",
  critical,
});

/** Every stage the machine can sit in while WAITING for something. */
const WAITING_STAGES: BootUpdateStage[] = [
  "checking",
  "downloading",
  "installing",
  "applying",
];

/** Drive a fresh flow into the given waiting stage. */
function reach(stage: BootUpdateStage): Flow {
  const flow = new Flow().arm();
  if (stage === "checking") return flow;
  flow.status(available());
  if (stage === "downloading") return flow;
  flow.status(ready());
  if (stage === "installing") return flow;
  flow.advance(BOOT_UPDATE_INSTALL_NOTICE_MS + 250);
  return flow; // applying
}

// ---------------------------------------------------------------------------

describe("no update to install", () => {
  it("releases at once when the feed says we are current — no waiting", () => {
    const flow = new Flow().arm().status({ kind: "up-to-date", version: "1.2.3" });
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["up-to-date"]);
    // Nothing was downloaded or installed, so the boot phase must be DROPPED
    // (denominator unchanged) rather than counted as a degraded phase.
    expect(flow.effects).toEqual([
      { type: "release", reason: "up-to-date", engaged: false },
    ]);
  });

  it("releases immediately when offline — the check error is not waited on", () => {
    const flow = new Flow().arm().status({ kind: "error", scope: "check" });
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["check-failed"]);
    // "Hiç bekletme": released on the very first status, zero elapsed time.
    expect(flow.now).toBe(T0);
  });

  it("releases on a surface with no updater (the web build)", () => {
    const flow = new Flow().arm(false);
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["unsupported"]);
  });

  it("releases on an unpackaged/dev run", () => {
    const flow = new Flow().arm().status({ kind: "disabled" });
    expect(flow.reasons).toEqual(["disabled"]);
  });

  it("never starts a download or an install when there is nothing to do", () => {
    for (const status of [
      { kind: "up-to-date", version: "1.2.3" } as UpdateStatus,
      { kind: "error", scope: "check" } as UpdateStatus,
      { kind: "disabled" } as UpdateStatus,
    ]) {
      const flow = new Flow().arm().status(status).advance(60_000);
      expect(flow.kinds).toEqual(["release"]);
    }
  });
});

describe("an update is waiting", () => {
  it("starts the download and shows the REAL percent, not a guess", () => {
    const flow = new Flow().arm().status(available());
    expect(flow.kinds).toEqual(["start-download"]);
    expect(flow.state.stage).toBe("downloading");
    expect(selectBootUpdateDisplay(flow.state)).toEqual({ mode: "downloading", percent: 0 });

    flow.advance(1_000).status(downloading(37));
    expect(selectBootUpdateDisplay(flow.state)).toEqual({ mode: "downloading", percent: 37 });
    expect(flow.released).toBe(false);
  });

  it("never lets the reported percent go backwards", () => {
    const flow = new Flow().arm().status(available()).status(downloading(60));
    flow.advance(500).status(downloading(12));
    expect(flow.state.percent).toBe(60);
  });

  it("applies the update and restarts once the download finishes", () => {
    const flow = new Flow().arm().status(available()).advance(3_000).status(downloading(99));
    flow.advance(500).status(ready());

    // The restart is ANNOUNCED before it happens — no surprise relaunch.
    expect(flow.state.stage).toBe("installing");
    expect(selectBootUpdateDisplay(flow.state)).toEqual({ mode: "installing" });
    expect(flow.kinds).toEqual(["start-download"]);

    flow.advance(BOOT_UPDATE_INSTALL_NOTICE_MS + 250);
    expect(flow.kinds).toEqual(["start-download", "apply"]);
    expect(selectBootUpdateDisplay(flow.state)).toEqual({ mode: "restarting" });
    // Still holding the splash: the process is about to go away.
    expect(flow.released).toBe(false);
  });

  it("rides along with a download main started itself (crash-recovery resume)", () => {
    const flow = new Flow().arm().status(downloading(20));
    // Must NOT ask for a second download — main is already running one.
    expect(flow.kinds).toEqual([]);
    expect(selectBootUpdateDisplay(flow.state)).toEqual({ mode: "downloading", percent: 20 });
  });

  it("adopts an already-downloaded package without re-downloading it", () => {
    const flow = new Flow().arm().status(ready());
    expect(flow.state.stage).toBe("installing");
    expect(flow.kinds).toEqual([]);
    flow.advance(BOOT_UPDATE_INSTALL_NOTICE_MS + 250);
    expect(flow.kinds).toEqual(["apply"]);
  });
});

describe("never blocks the app from opening", () => {
  it("opens the app when the feed never answers", () => {
    const flow = new Flow().arm().status({ kind: "checking" });
    flow.advance(BOOT_UPDATE_CHECK_BUDGET_MS - 500);
    expect(flow.released).toBe(false);

    flow.advance(1_000);
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["check-timeout"]);
    // Never engaged, so the bar's denominator goes back to the ordinary phases.
    expect(flow.effects.at(-1)).toMatchObject({ engaged: false });
  });

  /**
   * THE test. A download that is real but too slow for a startup wait must hand
   * off, not hold the splash — this is the exact failure mode that would turn
   * "the app updates itself" into "the app does not open".
   */
  it("opens the app when the download is too slow, and hands the update off", () => {
    const flow = new Flow().arm().status(available());
    // Genuinely progressing, just slowly: a percent every two seconds keeps the
    // stall clock happy but will never finish inside the budget.
    for (let elapsed = 0, pct = 1; elapsed < 60_000; elapsed += 2_000, pct += 1) {
      flow.advance(2_000);
      if (flow.released) break;
      flow.status(downloading(Math.min(pct, BOOT_UPDATE_NEAR_DONE_PERCENT - 1)));
    }

    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["download-timeout"]);
    // It engaged, so the phase is DEGRADED — honest about having tried.
    expect(flow.effects.at(-1)).toMatchObject({ engaged: true });
    // And it must not have quit the app on the way out.
    expect(flow.kinds).not.toContain("apply");
    // Bounded: released within the budget (+ at most one near-done extension).
    expect(flow.now - T0).toBeLessThanOrEqual(
      BOOT_UPDATE_DOWNLOAD_BUDGET_MS + BOOT_UPDATE_NEAR_DONE_GRACE_MS + 2_500,
    );
  });

  it("opens the app when the download dies mid-flight, without burning the budget", () => {
    const flow = new Flow().arm().status(available()).advance(1_000).status(downloading(15));
    flow.advance(BOOT_UPDATE_STALL_MS + 500);
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["download-stalled"]);
    // Well inside the full download budget — a dead connection is not waited out.
    expect(flow.now - T0).toBeLessThan(BOOT_UPDATE_DOWNLOAD_BUDGET_MS);
  });

  it("opens the app when the download errors", () => {
    const flow = new Flow()
      .arm()
      .status(available())
      .advance(500)
      .status({ kind: "error", scope: "download" });
    expect(flow.reasons).toEqual(["download-failed"]);
  });

  it("opens the app when the installer refuses to take the process down", () => {
    const flow = reach("applying");
    expect(flow.released).toBe(false);
    flow.advance(BOOT_UPDATE_APPLY_FALLBACK_MS + 500);
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["install-timeout"]);
  });

  it("gives a nearly-finished download ONE extension, then still lets go", () => {
    // Built directly rather than driven: the point under test is the deadline
    // arithmetic, and a healthy download sitting exactly on the budget is easier
    // to state than to simulate.
    const healthy = (at: number, percent: number): BootUpdateState => ({
      ...initialBootUpdateState(),
      stage: "downloading",
      version: "1.2.3",
      percent,
      since: T0,
      progressAt: at, // still moving, so the stall rule is not what fires
      engaged: true,
    });

    const deadline = T0 + BOOT_UPDATE_DOWNLOAD_BUDGET_MS;
    const nearlyDone = BOOT_UPDATE_NEAR_DONE_PERCENT + 5;

    const extended = reduceBootUpdate(healthy(deadline, nearlyDone), {
      type: "tick",
      at: deadline,
    });
    expect(extended.state.extended).toBe(true);
    expect(extended.effects).toEqual([]);

    const past = deadline + BOOT_UPDATE_NEAR_DONE_GRACE_MS;
    const finally_ = reduceBootUpdate(
      { ...extended.state, progressAt: past },
      { type: "tick", at: past },
    );
    expect(finally_.state.stage).toBe("released");
    expect(finally_.state.release).toBe("download-timeout");
  });

  it("does NOT extend a download that is nowhere near done", () => {
    const deadline = T0 + BOOT_UPDATE_DOWNLOAD_BUDGET_MS;
    const result = reduceBootUpdate(
      {
        ...initialBootUpdateState(),
        stage: "downloading",
        version: "1.2.3",
        percent: BOOT_UPDATE_NEAR_DONE_PERCENT - 1,
        since: T0,
        progressAt: deadline,
        engaged: true,
      },
      { type: "tick", at: deadline },
    );
    expect(result.state.stage).toBe("released");
    expect(result.state.release).toBe("download-timeout");
  });

  it("EVERY waiting stage has a deadline — no stage can hang", () => {
    const longerThanAnyBudget =
      BOOT_UPDATE_CHECK_BUDGET_MS +
      BOOT_UPDATE_DOWNLOAD_BUDGET_MS +
      BOOT_UPDATE_NEAR_DONE_GRACE_MS +
      BOOT_UPDATE_APPLY_FALLBACK_MS +
      10_000;

    for (const stage of WAITING_STAGES) {
      const flow = reach(stage);
      expect(flow.state.stage).toBe(stage);
      flow.advance(longerThanAnyBudget);
      expect(`${stage}:${flow.state.stage}`).toBe(`${stage}:released`);
    }
  });

  it("stands down when something else finishes the boot", () => {
    const flow = reach("downloading").advance(2_000).abandon();
    expect(flow.released).toBe(true);
    expect(flow.reasons).toEqual(["abandoned"]);
    // Critically: it must not fire an install for an app that is already open.
    expect(flow.kinds).not.toContain("apply");
  });

  it("is terminal once released — no late event can revive it", () => {
    const flow = new Flow().arm().status({ kind: "up-to-date", version: "1.2.3" });
    const before = flow.effects.length;
    flow.status(available()).status(ready()).advance(60_000).abandon();
    expect(flow.effects.length).toBe(before);
    expect(flow.state.stage).toBe("released");
  });
});

describe("mandatory updates are left alone", () => {
  it.each([
    ["available", available(true)],
    ["downloading", downloading(40, true)],
    ["ready", ready(true)],
  ])("releases on a critical %s without acting on it", (_label, status) => {
    const flow = new Flow().arm().status(status);
    expect(flow.reasons).toEqual(["critical"]);
    // Main force-installs these and CriticalUpdateOverlay owns the UI; a second
    // driver here would double-download and fight over the restart.
    expect(flow.kinds).toEqual(["release"]);
  });

  it("bails out if an in-flight download turns out to be critical", () => {
    const flow = new Flow().arm().status(available()).advance(500).status(downloading(30, true));
    expect(flow.reasons).toEqual(["critical"]);
    expect(flow.kinds).not.toContain("apply");
  });
});

describe("arming", () => {
  it("is idempotent — StrictMode's double mount does not restart the clock", () => {
    const flow = new Flow().arm();
    const since = flow.state.since;
    flow.advance(1_000).arm();
    expect(flow.state.since).toBe(since);
    expect(flow.state.stage).toBe("checking");
  });

  it("ignores statuses that arrive before it is armed", () => {
    const flow = new Flow().status(available());
    expect(flow.state.stage).toBe("idle");
    expect(flow.effects).toEqual([]);
  });
});

describe("splash presentation", () => {
  it("shows nothing while merely checking — the real phases narrate instead", () => {
    const flow = new Flow().arm();
    expect(selectBootUpdateDisplay(flow.state)).toBeNull();
    expect(isBootUpdateActive(flow.state.stage)).toBe(false);
  });

  it("takes the splash over exactly for the stages that need it", () => {
    const active: BootUpdateStage[] = ["downloading", "installing", "applying"];
    const inert: BootUpdateStage[] = ["idle", "checking", "released"];
    for (const stage of active) expect(isBootUpdateActive(stage)).toBe(true);
    for (const stage of inert) expect(isBootUpdateActive(stage)).toBe(false);
  });

  it("shows nothing once released, so the splash goes back to its phases", () => {
    const flow = new Flow().arm().status({ kind: "up-to-date", version: "1.2.3" });
    expect(selectBootUpdateDisplay(flow.state)).toBeNull();
  });
});
