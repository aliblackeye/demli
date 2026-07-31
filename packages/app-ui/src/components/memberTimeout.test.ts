/**
 * Timeout badge state (ADR 0019 §3).
 *
 * The rule under test is "expiry is a clock comparison, not a stored flag": a
 * mute that has lapsed must read exactly like no mute at all, with no refetch
 * and no sweeper — otherwise the UI keeps claiming someone is silenced while the
 * server is already accepting their messages.
 */

import { describe, expect, it } from "vitest";
import { activeTimeouts, formatTimeoutUntil } from "./memberTimeout";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const iso = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString();

describe("activeTimeouts", () => {
  it("reports nobody, and no timer, when no member is timed out", () => {
    const snapshot = activeTimeouts(
      [{ id: "a" }, { id: "b", timedOutUntil: null }],
      NOW,
    );
    expect(snapshot.active.size).toBe(0);
    expect(snapshot.nextExpiryAt).toBeNull();
  });

  it("reports a member whose timeout is still in the future", () => {
    const snapshot = activeTimeouts([{ id: "a", timedOutUntil: iso(60_000) }], NOW);
    expect([...snapshot.active]).toEqual(["a"]);
    expect(snapshot.nextExpiryAt).toBe(NOW + 60_000);
  });

  it("DROPS a member the instant their timeout lapses — no refetch involved", () => {
    const member = { id: "a", timedOutUntil: iso(60_000) };
    expect(activeTimeouts([member], NOW).active.has("a")).toBe(true);
    // Same input, later clock: the badge disappears on its own.
    expect(activeTimeouts([member], NOW + 60_001).active.has("a")).toBe(false);
    expect(activeTimeouts([member], NOW + 60_001).nextExpiryAt).toBeNull();
  });

  it("treats the exact expiry instant as lapsed, leaving no grace window", () => {
    const snapshot = activeTimeouts([{ id: "a", timedOutUntil: iso(0) }], NOW);
    expect(snapshot.active.size).toBe(0);
    expect(snapshot.nextExpiryAt).toBeNull();
  });

  it("ignores an already-past instant, which is indistinguishable from null", () => {
    expect(activeTimeouts([{ id: "a", timedOutUntil: iso(-5_000) }], NOW).active.size).toBe(0);
  });

  it("schedules the EARLIEST expiry, so one timer serves the whole roster", () => {
    const snapshot = activeTimeouts(
      [
        { id: "a", timedOutUntil: iso(600_000) },
        { id: "b", timedOutUntil: iso(5_000) },
        { id: "c", timedOutUntil: iso(60_000) },
        { id: "d", timedOutUntil: null },
      ],
      NOW,
    );
    expect([...snapshot.active].sort()).toEqual(["a", "b", "c"]);
    expect(snapshot.nextExpiryAt).toBe(NOW + 5_000);
  });

  it("re-arms on the next member once the earliest one lapses", () => {
    const members = [
      { id: "a", timedOutUntil: iso(5_000) },
      { id: "b", timedOutUntil: iso(60_000) },
    ];
    const after = activeTimeouts(members, NOW + 5_001);
    expect([...after.active]).toEqual(["b"]);
    expect(after.nextExpiryAt).toBe(NOW + 60_000);
  });

  it("fails OPEN on an unparseable instant — a client never invents a mute", () => {
    const snapshot = activeTimeouts([{ id: "a", timedOutUntil: "not-a-date" }], NOW);
    expect(snapshot.active.size).toBe(0);
    expect(snapshot.nextExpiryAt).toBeNull();
  });

  it("returns the SAME empty set instance so consumers never churn", () => {
    const a = activeTimeouts([{ id: "a" }], NOW);
    const b = activeTimeouts([{ id: "b" }], NOW);
    expect(a.active).toBe(b.active);
  });
});

describe("formatTimeoutUntil", () => {
  it("renders a date and a time (both matter across the 60s…1 week presets)", () => {
    const text = formatTimeoutUntil("2026-07-27T15:30:00.000Z", "en-US");
    expect(text).toMatch(/\d/);
    expect(text.length).toBeGreaterThan(4);
  });

  it("returns an empty string for an unparseable instant instead of 'Invalid Date'", () => {
    expect(formatTimeoutUntil("nope", "en-US")).toBe("");
  });

  it("falls back to English rather than throwing on a bad locale tag", () => {
    expect(formatTimeoutUntil("2026-07-27T15:30:00.000Z", "!!!")).toMatch(/\d/);
  });
});
