/**
 * The app must keep LOOKING for updates while it runs.
 *
 * Founder, twice: "yukarıda yeşil bir indirme butonu otomatik gelmeli" and then,
 * after the badge was fixed, "yeni sürüm geldiğini ancak ayarlara gidip
 * güncellemeyi kontrol et'e basınca oluyor". Both reports are the same defect
 * seen from two sides: the badge was never broken — nothing ever told it to look.
 * The updater checked exactly once, at launch, plus two retries that only fire
 * when the launch check ERRORED. A release published while the app was open was
 * invisible until a restart or a manual press.
 *
 * That class of bug leaves no failing assertion, because the missing thing is a
 * caller, not a branch: every unit involved works. So this is a source-level
 * invariant over the scheduling wiring, which is the only place the absence is
 * visible.
 *
 * Structure over exact numbers on purpose. The interval could reasonably be 15
 * or 60 minutes; what must not silently return is "checks once and stops".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "auto-update.ts"),
  "utf8",
);
/** Comments explain the bans and must not satisfy them. */
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("update checks are scheduled, not one-shot", () => {
  it("re-checks on a timer while the app runs", () => {
    expect(code).toMatch(/setInterval\(/);
    expect(code).toMatch(/PERIODIC_CHECK_MS/);
  });

  it("keeps the timer from holding the process open at quit", () => {
    // An un-unref'd interval keeps Electron's loop alive and the app appears to
    // hang on close — the same trap the launch rechecks documented.
    expect(code).toMatch(/setInterval\([\s\S]{0,400}?\)\.unref\(\)/);
  });

  it("also checks when a window regains focus", () => {
    // Covers the machine that was asleep, where a timer may never have fired.
    expect(code).toMatch(/browser-window-focus/);
  });

  it("rate-limits the focus trigger", () => {
    // Focus fires on every alt-tab. Without a floor this hammers the feed.
    expect(code).toMatch(/FOCUS_CHECK_FLOOR_MS/);
    expect(code).toMatch(/lastCheckStartedAt/);
  });

  it("never starts a check on top of an in-flight one", () => {
    // `downloading` matters as much as `checking`: restarting there would
    // abandon a partial transfer for nothing.
    expect(code).toMatch(/lastStatus\.kind !== "checking"/);
    expect(code).toMatch(/lastStatus\.kind !== "downloading"/);
  });

  it("checks at launch too — the timer must not have replaced it", () => {
    expect(code).toMatch(/void runCheck\(\);/);
    expect(code).toMatch(/armLaunchRechecks\(\);/);
  });

  it("uses a sane interval: minutes, not milliseconds or days", () => {
    const m = /const PERIODIC_CHECK_MS = ([^;]+);/.exec(SOURCE);
    expect(m).not.toBeNull();
    const ms = Function(`"use strict"; return (${m![1]});`)() as number;
    expect(ms).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });
});
