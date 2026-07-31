/**
 * The set-once date of birth failure must READ like what it is.
 *
 * `PATCH /users/me { birthdate }` answers `409 BIRTHDATE_LOCKED` when the
 * account already has one — a permanent refusal, not a hiccup. Mapping it to
 * "Something went wrong. Please try again." would invite the user to keep
 * retrying a write that can never succeed (§26), so it gets its own copy and
 * that copy must exist in both languages.
 */

import { describe, expect, it } from "vitest";
import { resources } from "@demli/i18n";
import { ApiClientError } from "@demli/client-core";
import { errorKey } from "./errors";

const locked = (): ApiClientError =>
  new ApiClientError("BIRTHDATE_LOCKED", "Your date of birth is already set.", 409);

describe("BIRTHDATE_LOCKED error mapping", () => {
  it("gets bespoke copy instead of the generic line", () => {
    expect(errorKey(locked())).toBe("errors.birthdateLocked");
    expect(errorKey(locked())).not.toBe("errors.generic");
  });

  it("does not swallow a plain CONFLICT into the same message", () => {
    expect(errorKey(new ApiClientError("CONFLICT", "nope", 409))).toBe("errors.generic");
  });

  it("has real copy in both languages", () => {
    const en = (resources.en.common.errors as Record<string, string>).birthdateLocked;
    const tr = (resources.tr.common.errors as Record<string, string>).birthdateLocked;
    expect(en).toBeTruthy();
    expect(tr).toBeTruthy();
    // It must say the value is already set / unchangeable — not "try again".
    expect(en).toMatch(/already|can't be changed/i);
    expect(tr).toMatch(/zaten|değiştir/i);
  });
});
