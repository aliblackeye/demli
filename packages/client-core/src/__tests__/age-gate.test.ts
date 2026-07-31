/**
 * The 18+ gate rules. These are the guarantees the founder asked for in words:
 * verifying at the gate opens the channel WITHOUT a reload, a minor is told the
 * truth once and never handed a second (impossible) attempt, and the one-time
 * nudge stays gone after a single dismissal.
 */

import { describe, expect, it } from "vitest";
import { ApiClientError } from "../api-client.js";
import {
  ADULT_AGE,
  ageInYears,
  formatBirthdateDisplay,
  isAdultBirthdate,
  isBirthdateLockedError,
  nsfwGateStage,
  shouldPromptForBirthdate,
} from "../age-gate.js";

/** Fixed "today" so the age math is not a moving target. */
const NOW = new Date("2026-07-27T12:00:00.000Z");

describe("ageInYears", () => {
  it("counts whole years in UTC", () => {
    expect(ageInYears("2000-07-27", NOW)).toBe(26);
    expect(ageInYears("1990-01-01", NOW)).toBe(36);
  });

  it("does not round a birthday up before it happens", () => {
    // Turns 18 tomorrow — still 17 today.
    expect(ageInYears("2008-07-28", NOW)).toBe(17);
    // Turns 18 today.
    expect(ageInYears("2008-07-27", NOW)).toBe(18);
  });

  it("rejects a missing, malformed, impossible or future date", () => {
    expect(ageInYears(null, NOW)).toBeNull();
    expect(ageInYears(undefined, NOW)).toBeNull();
    expect(ageInYears("", NOW)).toBeNull();
    expect(ageInYears("27.07.2000", NOW)).toBeNull();
    expect(ageInYears("2001-13-01", NOW)).toBeNull();
    expect(ageInYears("2001-02-30", NOW)).toBeNull();
    expect(ageInYears("2030-01-01", NOW)).toBeNull();
  });

  it("isAdultBirthdate agrees with the threshold", () => {
    expect(ADULT_AGE).toBe(18);
    expect(isAdultBirthdate("2008-07-27", NOW)).toBe(true);
    expect(isAdultBirthdate("2008-07-28", NOW)).toBe(false);
    expect(isAdultBirthdate("nonsense", NOW)).toBe(false);
  });
});

describe("formatBirthdateDisplay", () => {
  it("renders the confirmation copy as DD.MM.YYYY", () => {
    expect(formatBirthdateDisplay("2000-03-07")).toBe("07.03.2000");
  });

  it("leaves a non-ISO value untouched rather than inventing one", () => {
    expect(formatBirthdateDisplay("whatever")).toBe("whatever");
  });
});

describe("nsfwGateStage", () => {
  it("offers in-place verification when no birthdate is on file", () => {
    expect(
      nsfwGateStage({ isAdult: false, birthdateSet: false, acknowledged: false }),
    ).toBe("verifyAge");
  });

  // The founder rule: verifying at the gate must open the channel with no
  // reload. The stage is a pure function of the /users/me record, so replaying
  // it with the record the PATCH returned is exactly what the UI does.
  it("moves straight to the acknowledgement once a saved birthdate makes the viewer adult", () => {
    const before = { isAdult: false, birthdateSet: false, acknowledged: false };
    expect(nsfwGateStage(before)).toBe("verifyAge");

    // …server accepted the date; /users/me now reports isAdult.
    const afterSave = { isAdult: true, birthdateSet: true, acknowledged: false };
    expect(nsfwGateStage(afterSave)).toBe("confirmAdult");

    // …the user presses Continue.
    expect(nsfwGateStage({ ...afterSave, acknowledged: true })).toBeNull();
  });

  // A minor must never be shown a second date field: the value is set-once, so
  // the control could not work, and offering it would read as "try again".
  it("never re-offers the entry once a birthdate is stored and under 18", () => {
    const minor = { isAdult: false, birthdateSet: true, acknowledged: false };
    expect(nsfwGateStage(minor)).toBe("minorBlocked");
    // Even an acknowledgement recorded earlier cannot unlock it.
    expect(nsfwGateStage({ ...minor, acknowledged: true })).toBe("minorBlocked");
  });

  it("keeps gating an adult until they acknowledge the channel", () => {
    expect(
      nsfwGateStage({ isAdult: true, birthdateSet: true, acknowledged: false }),
    ).toBe("confirmAdult");
    expect(
      nsfwGateStage({ isAdult: true, birthdateSet: true, acknowledged: true }),
    ).toBeNull();
  });
});

describe("isBirthdateLockedError", () => {
  it("recognises the set-once 409 so the UI can say what actually happened", () => {
    const locked = new ApiClientError(
      "BIRTHDATE_LOCKED",
      "Your date of birth is already set and can't be changed.",
      409,
    );
    expect(isBirthdateLockedError(locked)).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isBirthdateLockedError(new ApiClientError("CONFLICT", "nope", 409))).toBe(false);
    expect(isBirthdateLockedError(new Error("boom"))).toBe(false);
    expect(isBirthdateLockedError(null)).toBe(false);
  });
});

describe("shouldPromptForBirthdate", () => {
  it("asks once when the account has no date of birth", () => {
    expect(
      shouldPromptForBirthdate({ selfLoaded: true, birthdateSet: false, dismissed: false }),
    ).toBe(true);
  });

  it("stays gone after a single dismissal", () => {
    expect(
      shouldPromptForBirthdate({ selfLoaded: true, birthdateSet: false, dismissed: true }),
    ).toBe(false);
  });

  it("never nags an account that already has one", () => {
    expect(
      shouldPromptForBirthdate({ selfLoaded: true, birthdateSet: true, dismissed: false }),
    ).toBe(false);
  });

  it("waits for the real /users/me record instead of guessing at cold start", () => {
    expect(
      shouldPromptForBirthdate({ selfLoaded: false, birthdateSet: false, dismissed: false }),
    ).toBe(false);
  });
});
