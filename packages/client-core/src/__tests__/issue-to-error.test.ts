/**
 * The zod-issue → i18n-key mapper.
 *
 * The regression this file guards: before it existed, EVERY validation failure
 * became `errors.generic` ("Something went wrong"), so a user could not learn
 * which rule they broke. Every assertion below is really the same assertion —
 * this input produces a SPECIFIC message, not the generic one.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  claimedUsername,
  createGroupBodySchema,
  loginBodySchema,
  newPasswordField,
  registerBodySchema,
  updateProfileBodySchema,
  VALIDATION_CODES,
} from "@demli/protocol";
import {
  firstFieldError,
  issuesToFieldErrors,
  issueToError,
  validateForm,
  VALIDATION_KEYS,
} from "../forms/issue-to-error.js";

/** The key a schema produces for `input`, via the real safeParse path. */
function keyFor(schema: z.ZodTypeAny, input: unknown): string {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected a validation failure");
  return firstFieldError(result.error).key;
}

describe("zod's own issue codes", () => {
  it("maps a missing field to required, not to a type error", () => {
    const schema = z.object({ name: z.string() });
    expect(keyFor(schema, {})).toBe("validation.required");
  });

  it("maps min(1) on a string to required, not to 'at least 1 character'", () => {
    // "Use at least 1 characters" is the message that makes a form look broken.
    expect(keyFor(z.string().min(1), "")).toBe("validation.required");
  });

  it("maps a real minimum to tooShort, carrying the number", () => {
    const result = z.string().min(3).safeParse("ab");
    const error = firstFieldError((result as z.SafeParseError<string>).error);
    expect(error).toEqual({ key: "validation.tooShort", params: { min: 3 } });
  });

  it("maps a maximum to tooLong, carrying the number", () => {
    const result = z.string().max(8).safeParse("123456789");
    const error = firstFieldError((result as z.SafeParseError<string>).error);
    expect(error).toEqual({ key: "validation.tooLong", params: { max: 8 } });
  });

  it("distinguishes number bounds from string bounds", () => {
    const min = z.number().min(5).safeParse(4);
    expect(firstFieldError((min as z.SafeParseError<number>).error)).toEqual({
      key: "validation.numberTooSmall",
      params: { min: 5 },
    });
    const max = z.number().max(5).safeParse(6);
    expect(firstFieldError((max as z.SafeParseError<number>).error)).toEqual({
      key: "validation.numberTooBig",
      params: { max: 5 },
    });
  });

  it("maps a non-integer, a NaN, an enum miss, a bad uuid and a bad email", () => {
    // zod funnels `.int()` and NaN through `invalid_type`, so these two would
    // read as a generic "wrong format" without the explicit branch.
    expect(keyFor(z.number().int(), 1.5)).toBe("validation.notInteger");
    expect(keyFor(z.coerce.number(), "abc")).toBe("validation.notANumber");
    expect(keyFor(z.enum(["a", "b"]), "c")).toBe("validation.invalidOption");
    expect(keyFor(z.string().uuid(), "nope")).toBe("validation.invalidId");
    expect(keyFor(z.string().email(), "nope")).toBe("validation.invalidEmail");
  });

  it("falls back to a generic validation key for an unmapped issue", () => {
    expect(keyFor(z.string().regex(/^x$/), "y")).toBe("validation.invalid");
  });
});

describe("Demli custom codes", () => {
  it("maps every code in the protocol union — no code degrades to generic", () => {
    // The real assertion: a rule added upstream cannot silently lose its message.
    for (const code of VALIDATION_CODES) {
      const issue: z.ZodIssue = {
        code: z.ZodIssueCode.custom,
        message: code,
        path: [],
        params: { demliCode: code },
      };
      const mapped = issueToError(issue);
      expect(VALIDATION_KEYS).toContain(mapped.key);
      expect(mapped.key).not.toBe("validation.invalid");
    }
  });

  it("carries the extra params a code attached", () => {
    const issue: z.ZodIssue = {
      code: z.ZodIssueCode.custom,
      message: "dateOutOfRange",
      path: [],
      params: { demliCode: "dateOutOfRange", min: 1901 },
    };
    expect(issueToError(issue)).toEqual({
      key: "validation.dateOutOfRange",
      params: { min: 1901 },
    });
  });

  it("never leaks the internal code as a param", () => {
    const issue: z.ZodIssue = {
      code: z.ZodIssueCode.custom,
      message: "reservedUsername",
      path: [],
      params: { demliCode: "reservedUsername" },
    };
    expect(issueToError(issue).params).toBeUndefined();
  });
});

describe("real schema failures produce real messages", () => {
  it("names the rule for a reserved username", () => {
    expect(keyFor(claimedUsername, "everyone")).toBe("validation.reservedUsername");
  });

  it("names the rule for the username grammar", () => {
    expect(keyFor(claimedUsername, "ali.karagoz")).toBe("validation.pattern.username");
  });

  it("names the rule for a common password", () => {
    expect(keyFor(newPasswordField, "password")).toBe("validation.passwordCommon");
  });

  it("names the rule for a short password, with the number", () => {
    const result = newPasswordField.safeParse("kisa");
    expect(firstFieldError((result as z.SafeParseError<string>).error)).toEqual({
      key: "validation.tooShort",
      params: { min: 8 },
    });
  });

  it("names the rule for a javascript: avatar URL", () => {
    expect(keyFor(updateProfileBodySchema, { avatarUrl: "javascript:alert(1)" })).toBe(
      "validation.invalidUrl",
    );
  });

  it("names the rule for an invisible server name", () => {
    expect(keyFor(createGroupBodySchema, { name: "\u200B\u200D" })).toBe(
      "validation.noVisibleCharacter",
    );
  });
});

describe("issuesToFieldErrors", () => {
  it("keys errors by field path", () => {
    const result = registerBodySchema.safeParse({ username: "ali!", password: "short" });
    const errors = issuesToFieldErrors((result as z.SafeParseError<unknown>).error);
    expect(errors["username"]?.key).toBe("validation.pattern.username");
    expect(errors["password"]).toEqual({ key: "validation.tooShort", params: { min: 8 } });
  });

  it("keeps only the FIRST issue per field", () => {
    // "a!" is both too short AND ungrammatical; the user should see one message.
    const result = registerBodySchema.safeParse({ username: "a!", password: "demlik42" });
    const errors = issuesToFieldErrors((result as z.SafeParseError<unknown>).error);
    expect(Object.keys(errors)).toEqual(["username"]);
  });

  it("attaches a cross-field failure to the field it is about", () => {
    const result = registerBodySchema.safeParse({
      username: "demlikci",
      password: "demlikci",
    });
    const errors = issuesToFieldErrors((result as z.SafeParseError<unknown>).error);
    expect(errors["password"]?.key).toBe("validation.passwordIsUsername");
  });

  it("uses the empty path for a body-level failure", () => {
    const result = updateProfileBodySchema.safeParse({});
    const errors = issuesToFieldErrors((result as z.SafeParseError<unknown>).error);
    expect(errors[""]?.key).toBe("validation.emptyUpdate");
  });

  it("uses a dotted path for a nested field", () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string().uuid() })) });
    const result = schema.safeParse({ items: [{ id: "nope" }] });
    const errors = issuesToFieldErrors((result as z.SafeParseError<unknown>).error);
    expect(errors["items.0.id"]?.key).toBe("validation.invalidId");
  });
});

describe("validateForm", () => {
  it("returns the parsed value on success", () => {
    const result = validateForm(loginBodySchema, { username: "AliK", password: "x" });
    expect(result.ok && result.value.username).toBe("alik");
  });

  it("returns a field-error map on failure", () => {
    const result = validateForm(loginBodySchema, { username: "a", password: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors["username"]).toEqual({ key: "validation.tooShort", params: { min: 3 } });
    expect(result.errors["password"]).toEqual({ key: "validation.required" });
  });
});
