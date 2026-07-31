/**
 * Age gate (M15) — `isAdult()` unit tests.
 *
 * This one pure function is the ONLY thing standing between a minor and NSFW
 * channel content: the API derives the me-only `isAdult` flag from it, and every
 * client gate (desktop, web, mobile) just renders that boolean. It shipped
 * untested — flagged by the emulator QA pass — so a boundary slip (off-by-one on
 * the birthday, a timezone-dependent result, garbage parsed as a valid DOB)
 * would silently open the gate with nothing failing.
 *
 * `now` is injected everywhere here so these assertions never drift with the
 * wall clock, and the UTC cases pin the "deterministic regardless of server
 * timezone" promise in the implementation's own doc comment.
 */

import { describe, expect, it } from "vitest";
import { isAdult } from "@demli/types";

/** Fixed reference instant for every case: 2026-07-26T12:00:00Z. */
const NOW = new Date("2026-07-26T12:00:00Z");

describe("isAdult", () => {
  it("treats an unknown birthdate as a MINOR (conservative default)", () => {
    // Every pre-M15 account has null here. Defaulting to adult would have
    // opened NSFW channels to the entire existing user base.
    expect(isAdult(null, NOW)).toBe(false);
    expect(isAdult(undefined, NOW)).toBe(false);
    expect(isAdult("", NOW)).toBe(false);
  });

  it("is false the day BEFORE the 18th birthday and true ON it", () => {
    // The exact boundary the gate turns on.
    expect(isAdult("2008-07-27", NOW)).toBe(false); // turns 18 tomorrow
    expect(isAdult("2008-07-26", NOW)).toBe(true); // turns 18 today
    expect(isAdult("2008-07-25", NOW)).toBe(true); // turned 18 yesterday
  });

  it("does not credit a birthday later this year", () => {
    // Same year of birth, month still ahead → still 17.
    expect(isAdult("2008-12-01", NOW)).toBe(false);
    // Same month, day still ahead → still 17.
    expect(isAdult("2008-07-31", NOW)).toBe(false);
  });

  it("is true for a comfortably older DOB and false for a clearly younger one", () => {
    expect(isAdult("1990-01-01", NOW)).toBe(true);
    expect(isAdult("2015-01-01", NOW)).toBe(false);
  });

  it("rejects malformed or impossible dates instead of reading them as adult", () => {
    // Garbage must never parse into a passing age — that is a gate bypass.
    expect(isAdult("not-a-date", NOW)).toBe(false);
    expect(isAdult("1990-13-01", NOW)).toBe(false); // month 13
    expect(isAdult("1990-01-40", NOW)).toBe(false); // day 40
    expect(isAdult("1990-1-1", NOW)).toBe(false); // unpadded, not our wire form
    expect(isAdult("01-01-1990", NOW)).toBe(false); // wrong order
  });

  it("evaluates in UTC, so the verdict does not depend on the server's timezone", () => {
    // A user who turns 18 on 2026-07-26: just before and just after UTC
    // midnight. The late-evening instant is still 2026-07-25 in UTC.
    const justBeforeUtcMidnight = new Date("2026-07-25T23:59:59Z");
    const justAfterUtcMidnight = new Date("2026-07-26T00:00:01Z");
    expect(isAdult("2008-07-26", justBeforeUtcMidnight)).toBe(false);
    expect(isAdult("2008-07-26", justAfterUtcMidnight)).toBe(true);
  });
});
