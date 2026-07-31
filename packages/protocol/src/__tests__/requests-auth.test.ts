/**
 * Sign-up / sign-in rules.
 *
 * The load-bearing test in this file is the LOGIN password regression lock. Every
 * other rule here can be tightened later; that one cannot, because tightening it
 * locks existing users out of accounts whose passwords predate the rule, with the
 * password-change screen sitting behind the login they can no longer pass.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  PASSWORD_LOGIN_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@demli/config";
import {
  birthdateField,
  claimedUsername,
  loginBodySchema,
  loginPasswordField,
  newPasswordField,
  registerBodySchema,
  usernameField,
} from "../requests/auth.js";
import { COMMON_PASSWORD_COUNT, isCommonPassword } from "../requests/common-passwords.js";
import { validationCodeOf, type ValidationCode } from "../requests/codes.js";

/** Every Demli code raised by a failed parse, in order. */
function codes(result: z.SafeParseReturnType<unknown, unknown>): ValidationCode[] {
  if (result.success) return [];
  return result.error.issues
    .map((issue) => validationCodeOf(issue))
    .filter((code): code is ValidationCode => code !== null);
}

const VALID = {
  username: "alikaragoz",
  password: "kirmizi-demlik-42",
} as const;

describe("usernameField", () => {
  it("lowercases", () => {
    expect(usernameField.parse("AliKaragoz")).toBe("alikaragoz");
  });

  it("accepts letters, digits and underscore", () => {
    expect(usernameField.parse("ali_karagoz_99")).toBe("ali_karagoz_99");
  });

  it("rejects everything else with a pattern code", () => {
    for (const bad of ["ali karagoz", "ali.karagoz", "ali-karagoz", "ali@ka", "alí"]) {
      expect(codes(usernameField.safeParse(bad))).toContain("usernamePattern");
    }
  });

  it("enforces the length window", () => {
    expect(usernameField.safeParse("a".repeat(USERNAME_MIN_LENGTH - 1)).success).toBe(false);
    expect(usernameField.safeParse("a".repeat(USERNAME_MIN_LENGTH)).success).toBe(true);
    expect(usernameField.safeParse("a".repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
    expect(usernameField.safeParse("a".repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("does NOT apply the reserved list — existing accounts must still sign in", () => {
    // This is the whole reason there are two username fields. A user who
    // registered "admin" before the list existed still has to be able to log in.
    expect(usernameField.parse("admin")).toBe("admin");
    expect(usernameField.parse("everyone")).toBe("everyone");
  });
});

describe("claimedUsername", () => {
  it("rejects every reserved name, in any case", () => {
    for (const reserved of RESERVED_USERNAMES) {
      expect(claimedUsername.safeParse(reserved).success).toBe(false);
      expect(claimedUsername.safeParse(reserved.toUpperCase()).success).toBe(false);

      // "me" is 2 characters, so the length rule refuses it before the reserved
      // check ever runs — it is unregistrable either way, and listing it keeps
      // the intent explicit if the minimum ever drops.
      if (reserved.length < USERNAME_MIN_LENGTH) continue;
      expect(codes(claimedUsername.safeParse(reserved))).toContain("reservedUsername");
      expect(codes(claimedUsername.safeParse(reserved.toUpperCase()))).toContain(
        "reservedUsername",
      );
    }
  });

  it("reserves the mention targets that would collide with @everyone / @here", () => {
    expect(codes(claimedUsername.safeParse("everyone"))).toContain("reservedUsername");
    expect(codes(claimedUsername.safeParse("here"))).toContain("reservedUsername");
  });

  it("accepts an ordinary name", () => {
    expect(claimedUsername.parse("aliKaragoz")).toBe("alikaragoz");
  });
});

describe("newPasswordField (registration)", () => {
  it("requires 8 characters", () => {
    expect(newPasswordField.safeParse("dem1ik7").success).toBe(false);
    expect(newPasswordField.safeParse("dem1ik78").success).toBe(true);
  });

  it("caps at 128 so the field cannot become an upload", () => {
    expect(newPasswordField.safeParse("a1B".repeat(50)).success).toBe(false);
    expect(newPasswordField.safeParse(`x${"y".repeat(PASSWORD_MAX_LENGTH - 1)}`).success).toBe(
      true,
    );
  });

  it("imposes NO composition rules", () => {
    // All-lowercase, no digit, no symbol: a long passphrase is a good password.
    expect(newPasswordField.safeParse("mor salkim sokagi").success).toBe(true);
  });

  it("rejects common/breached passwords", () => {
    for (const bad of ["password", "12345678", "iloveyou", "trustno1", "football"]) {
      expect(codes(newPasswordField.safeParse(bad))).toContain("passwordCommon");
    }
  });

  it("rejects them case-insensitively", () => {
    expect(codes(newPasswordField.safeParse("PASSWORD"))).toContain("passwordCommon");
    expect(codes(newPasswordField.safeParse("Password1"))).toContain("passwordCommon");
  });

  it("catches the password a composition rule would have produced", () => {
    // `Password1` satisfies "one uppercase + one digit + at least 8 characters" —
    // the exact rule this schema refuses to impose — and is on the denylist
    // anyway. That is the case for length + denylist over composition, in a line.
    expect(isCommonPassword("Password1")).toBe(true);
    expect(codes(newPasswordField.safeParse("Password1"))).toContain("passwordCommon");
  });

  it("carries a denylist big enough to matter", () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThanOrEqual(1000);
  });
});

describe("loginPasswordField — REGRESSION LOCK", () => {
  it("still accepts a single character", () => {
    // If this ever fails, someone tightened login validation and just locked out
    // every account whose password predates the new rule. Do not "fix" the test.
    expect(PASSWORD_LOGIN_MIN_LENGTH).toBe(1);
    expect(loginPasswordField.safeParse("x").success).toBe(true);
  });

  it("accepts a short legacy password", () => {
    expect(loginPasswordField.safeParse("1234").success).toBe(true);
  });

  it("accepts a password that is on the common list", () => {
    expect(loginPasswordField.safeParse("password").success).toBe(true);
  });

  it("accepts a password equal to the username", () => {
    const result = loginBodySchema.safeParse({ username: "demli", password: "demli" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password (something must be typed)", () => {
    expect(loginPasswordField.safeParse("").success).toBe(false);
  });

  it("still caps at 128", () => {
    expect(loginPasswordField.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });
});

describe("registerBodySchema", () => {
  it("accepts a minimal valid body", () => {
    const parsed = registerBodySchema.parse(VALID);
    expect(parsed.username).toBe("alikaragoz");
  });

  it("rejects a password equal to the username", () => {
    const result = registerBodySchema.safeParse({
      username: "demlikci",
      password: "demlikci",
    });
    expect(codes(result)).toContain("passwordIsUsername");
  });

  it("rejects it case-insensitively, and points at the password field", () => {
    const result = registerBodySchema.safeParse({
      username: "demlikci",
      password: "DemliKci",
    });
    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.path).toEqual(["password"]);
  });

  it("sanitizes the display name", () => {
    const parsed = registerBodySchema.parse({ ...VALID, displayName: "  Ali\u200B  " });
    expect(parsed.displayName).toBe("Ali");
  });

  it("rejects a display name over 64", () => {
    const result = registerBodySchema.safeParse({ ...VALID, displayName: "a".repeat(65) });
    expect(result.success).toBe(false);
  });

  it("keeps a Turkish display name intact", () => {
    const parsed = registerBodySchema.parse({ ...VALID, displayName: "Ali Karagöz" });
    expect(parsed.displayName).toBe("Ali Karagöz");
  });

  it("normalizes a blank device name away instead of failing", () => {
    expect(registerBodySchema.parse({ ...VALID, deviceName: "   " }).deviceName).toBeUndefined();
  });

  it("coerces an unknown platform to undefined instead of failing", () => {
    expect(registerBodySchema.parse({ ...VALID, platform: "toaster" }).platform).toBeUndefined();
  });
});

describe("birthdateField", () => {
  it("accepts a real past date", () => {
    expect(birthdateField.parse("1994-03-17")).toBe("1994-03-17");
  });

  it("rejects a malformed string", () => {
    for (const bad of ["17-03-1994", "1994/03/17", "1994-3-7", "yesterday"]) {
      expect(codes(birthdateField.safeParse(bad))).toContain("invalidDate");
    }
  });

  it("rejects an impossible calendar date", () => {
    expect(codes(birthdateField.safeParse("2001-02-30"))).toContain("invalidDate");
    expect(codes(birthdateField.safeParse("2001-13-01"))).toContain("invalidDate");
    expect(codes(birthdateField.safeParse("2001-00-10"))).toContain("invalidDate");
  });

  it("rejects a year before 1901", () => {
    expect(codes(birthdateField.safeParse("1900-01-01"))).toContain("dateOutOfRange");
    expect(birthdateField.safeParse("1901-01-01").success).toBe(true);
  });

  it("rejects a future date", () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(codes(birthdateField.safeParse(`${nextYear}-01-01`))).toContain("dateOutOfRange");
  });

  it("does NOT enforce a minimum age (founder decision, CLAUDE.md §33)", () => {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    expect(birthdateField.safeParse(`${yyyy - 5}-${mm}-${dd}`).success).toBe(true);
  });
});
