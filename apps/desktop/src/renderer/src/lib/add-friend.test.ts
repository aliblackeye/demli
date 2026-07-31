import { describe, expect, it } from "vitest";
import { ApiClientError } from "@demli/client-core";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@demli/config";
import { addFriendError, validateAddFriendInput } from "./add-friend";

/**
 * The add-a-friend form's rules (founder directive, 2026-07-28: the field must
 * validate, and a missing account must say so).
 *
 * These run against the SHARED schema the API runs, so a drift between what the
 * form accepts and what the server accepts fails here rather than in front of a
 * user. The bounds are read from `@demli/config`, never re-typed — a test that
 * hard-codes "3" would keep passing after someone changed the real limit.
 */
describe("validateAddFriendInput", () => {
  it("rejects an empty field with 'type something first', not a length message", () => {
    // "Use at least 3 characters" on an untouched box reads as a broken form.
    for (const raw of ["", "   ", "@", "@@ "]) {
      const result = validateAddFriendInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({ key: "desktop:social.addErrorEmpty" });
    }
  });

  it("rejects a too-short username, naming the minimum", () => {
    const result = validateAddFriendInput("a".repeat(USERNAME_MIN_LENGTH - 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      key: "validation.tooShort",
      params: { min: USERNAME_MIN_LENGTH },
    });
  });

  it("rejects a too-long username, naming the maximum", () => {
    const result = validateAddFriendInput("a".repeat(USERNAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      key: "validation.tooLong",
      params: { max: USERNAME_MAX_LENGTH },
    });
  });

  it("rejects characters outside the username grammar", () => {
    // A dot / space / dash cannot exist in a stored username, so catching it in
    // the field is strictly better than a round-trip that answers "not found".
    for (const raw of ["ali.karagoz", "ali karagoz", "ali-k", "ali!"]) {
      const result = validateAddFriendInput(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({ key: "validation.pattern.username" });
    }
  });

  it("accepts a plain username and sends it lowercased", () => {
    const result = validateAddFriendInput("AliK");
    expect(result).toEqual({ ok: true, username: "alik" });
  });

  it("accepts a leading @ (what people paste from a mention) and strips it", () => {
    expect(validateAddFriendInput("@ali")).toEqual({ ok: true, username: "ali" });
    expect(validateAddFriendInput("  @Ali_K  ")).toEqual({ ok: true, username: "ali_k" });
  });

  it("counts the length AFTER the @ is stripped", () => {
    // `@` + a max-length name is legal input, not an over-cap one.
    const name = "a".repeat(USERNAME_MAX_LENGTH);
    expect(validateAddFriendInput(`@${name}`)).toEqual({ ok: true, username: name });
  });
});

describe("addFriendError", () => {
  const apiError = (code: ConstructorParameters<typeof ApiClientError>[0]) =>
    new ApiClientError(code, "boom");

  it("maps USER_NOT_FOUND to the 'no user with that username' line", () => {
    // The whole point of the 2026-07-28 reversal: a typo now says so.
    expect(addFriendError(apiError("USER_NOT_FOUND"))).toEqual({ key: "errors.userNotFound" });
  });

  it("keeps adding-yourself as its own distinct message", () => {
    expect(addFriendError(apiError("VALIDATION_ERROR"))).toEqual({
      key: "desktop:social.addErrorSelf",
    });
  });

  it("maps the rate limit and network failures to their own copy", () => {
    expect(addFriendError(apiError("RATE_LIMITED"))).toEqual({ key: "errors.rateLimited" });
    expect(addFriendError(apiError("NETWORK"))).toEqual({ key: "errors.network" });
  });

  it("falls back to the generic line for anything else", () => {
    expect(addFriendError(apiError("INTERNAL"))).toEqual({ key: "errors.generic" });
    expect(addFriendError(new Error("nope"))).toEqual({ key: "errors.generic" });
    expect(addFriendError(undefined)).toEqual({ key: "errors.generic" });
  });
});
