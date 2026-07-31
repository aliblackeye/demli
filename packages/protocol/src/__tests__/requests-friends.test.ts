/**
 * The add-a-friend username rule.
 *
 * This schema is shared verbatim by the desktop add-friend form and the
 * `POST /friends/requests/by-username` route, which is the whole point of it
 * existing: before it, the API capped the field at a hand-written 64 while a
 * username can only ever be 32, so a user could type 40 characters that could
 * not possibly match an account and be told nothing about why. These tests pin
 * the bounds against `@demli/config` rather than against literals — a test
 * that hard-codes 3 and 32 keeps passing after someone changes the real rule.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@demli/config";
import {
  friendUsernameField,
  normalizeUsernameInput,
  sendFriendRequestByUsernameBodySchema,
} from "../requests/friends.js";
import { validationCodeOf } from "../requests/codes.js";

/** The Demli code on the first issue, or null when zod raised its own. */
function firstCode(result: z.SafeParseReturnType<unknown, unknown>): string | null {
  if (result.success) return null;
  const issue = result.error.issues[0];
  return issue ? (validationCodeOf(issue) ?? issue.code) : null;
}

describe("normalizeUsernameInput", () => {
  it("strips a leading @, trims and lowercases", () => {
    expect(normalizeUsernameInput("  @Ali_K  ")).toBe("ali_k");
  });

  it("strips repeated @ (a double-paste), not just one", () => {
    expect(normalizeUsernameInput("@@ali")).toBe("ali");
  });

  it("leaves an already-canonical handle untouched", () => {
    expect(normalizeUsernameInput("ali_k")).toBe("ali_k");
  });
});

describe("friendUsernameField", () => {
  it("accepts a plain username and yields the stored (lowercase) form", () => {
    expect(friendUsernameField.parse("AliK")).toBe("alik");
  });

  it("accepts the @ people paste out of a mention", () => {
    expect(friendUsernameField.parse("@ali")).toBe("ali");
  });

  it("measures the length AFTER the @ is stripped", () => {
    // Otherwise `@` + a max-length name — legal input — would be rejected as
    // one character too long.
    const name = "a".repeat(USERNAME_MAX_LENGTH);
    expect(friendUsernameField.parse(`@${name}`)).toBe(name);
  });

  it("rejects below the minimum", () => {
    const result = friendUsernameField.safeParse("a".repeat(USERNAME_MIN_LENGTH - 1));
    expect(result.success).toBe(false);
    expect(firstCode(result)).toBe("too_small");
  });

  it("rejects above the maximum", () => {
    const result = friendUsernameField.safeParse("a".repeat(USERNAME_MAX_LENGTH + 1));
    expect(result.success).toBe(false);
    expect(firstCode(result)).toBe("too_big");
  });

  it("rejects anything outside the username grammar with a nameable code", () => {
    // `usernamePattern` is what lets the form say "letters, numbers and
    // underscores only" instead of a flat "invalid".
    for (const value of ["ali.k", "ali k", "ali-k", "ali!", "alı"]) {
      const result = friendUsernameField.safeParse(value);
      expect(result.success).toBe(false);
      expect(firstCode(result)).toBe("usernamePattern");
    }
  });

  it("carries no user-facing English (requests/ carries codes, not sentences)", () => {
    const result = friendUsernameField.safeParse("ali.k");
    expect(result.success).toBe(false);
    if (result.success) return;
    // The message slot holds the bare code — useful in a log, useless as copy,
    // which is exactly what keeps untranslated text out of a UI (ADR 0009).
    expect(result.error.issues[0]?.message).toBe("usernamePattern");
  });
});

describe("sendFriendRequestByUsernameBodySchema", () => {
  it("parses a body into the normalized username", () => {
    expect(sendFriendRequestByUsernameBodySchema.parse({ username: " @Ali " })).toEqual({
      username: "ali",
    });
  });

  it("pins the failure to the `username` path so a form can render it under the field", () => {
    const result = sendFriendRequestByUsernameBodySchema.safeParse({ username: "ali.k" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["username"]);
  });

  it("rejects a missing username", () => {
    expect(sendFriendRequestByUsernameBodySchema.safeParse({}).success).toBe(false);
  });
});
