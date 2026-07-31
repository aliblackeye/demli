import { describe, expect, it } from "vitest";
import {
  MAX_AUTO_APPLY_ATTEMPTS,
  decidePendingApply,
  isVersionOlder,
} from "./pending-update";

/**
 * The "downloaded but never restarted" recovery decision (founder requirement:
 * an update the user downloaded must apply itself on the next launch).
 *
 * These tests pin the two properties that matter and cannot be checked by
 * running the app: the update is never LOST (a crash still resumes it), and it
 * can never LOOP (a broken installer falls back to the manual flow).
 */

describe("isVersionOlder", () => {
  it("compares major.minor.patch numerically, not lexically", () => {
    expect(isVersionOlder("0.0.9", "0.0.10")).toBe(true);
    expect(isVersionOlder("0.0.10", "0.0.9")).toBe(false);
    expect(isVersionOlder("0.9.0", "1.0.0")).toBe(true);
    expect(isVersionOlder("1.0.0", "1.0.0")).toBe(false);
  });

  it("ignores prerelease/build suffixes", () => {
    expect(isVersionOlder("1.2.3-beta.1", "1.2.3")).toBe(false);
    expect(isVersionOlder("1.2.3+build9", "1.2.4")).toBe(true);
  });
});

describe("decidePendingApply", () => {
  it("does nothing when there is no marker", () => {
    expect(decidePendingApply(null, "1.0.0")).toEqual({ action: "none" });
  });

  it("resumes an update a previous run downloaded but never installed", () => {
    expect(decidePendingApply({ version: "1.1.0", attempts: 0 }, "1.0.0")).toEqual({
      action: "apply",
      version: "1.1.0",
      attempts: 1,
    });
  });

  it("clears the marker once the running build has caught up", () => {
    // The normal path: autoInstallOnAppQuit applied it at quit time, so this
    // launch IS the new version and must not restart itself again.
    expect(decidePendingApply({ version: "1.1.0", attempts: 0 }, "1.1.0")).toEqual({
      action: "clear",
      reason: "installed",
    });
    expect(decidePendingApply({ version: "1.1.0", attempts: 1 }, "1.2.0")).toEqual({
      action: "clear",
      reason: "installed",
    });
  });

  it("gives up after the attempt budget instead of relaunching forever", () => {
    // An installer blocked by policy / a corrupt package must degrade to the
    // ordinary "an update is available" flow, never a boot loop.
    expect(
      decidePendingApply(
        { version: "1.1.0", attempts: MAX_AUTO_APPLY_ATTEMPTS },
        "1.0.0",
      ),
    ).toEqual({ action: "clear", reason: "exhausted" });
  });

  it("burns exactly one attempt per launch until the budget is spent", () => {
    let attempts = 0;
    const seen: number[] = [];
    for (let launch = 0; launch < MAX_AUTO_APPLY_ATTEMPTS + 2; launch += 1) {
      const decision = decidePendingApply({ version: "2.0.0", attempts }, "1.0.0");
      if (decision.action !== "apply") {
        expect(decision).toEqual({ action: "clear", reason: "exhausted" });
        break;
      }
      seen.push(decision.attempts);
      attempts = decision.attempts;
    }
    expect(seen).toEqual(
      Array.from({ length: MAX_AUTO_APPLY_ATTEMPTS }, (_, i) => i + 1),
    );
  });
});
