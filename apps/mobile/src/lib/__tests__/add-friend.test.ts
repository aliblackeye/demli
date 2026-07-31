/**
 * The add-friend form's rules. Mobile used to check only "is it empty", so every
 * real rule (length, allowed characters) was learned from a failed round trip;
 * these cover the rules the field now enforces locally, and the normalization
 * the server expects.
 */

import { describe, expect, it } from "vitest";
import { ApiClientError } from "@demli/client-core";
import { addFriendError, validateAddFriendInput } from "../add-friend.js";

describe("validateAddFriendInput", () => {
  it("normalizes the accepted handle", () => {
    // Leading @, surrounding space and case are all the user's business, not the
    // server's — the schema strips them and THAT value is what gets sent.
    const result = validateAddFriendInput("  @AliBlack  ");
    expect(result).toEqual({ ok: true, username: "aliblack" });
  });

  it("treats a blank field as blank, not as too short", () => {
    for (const raw of ["", "   ", "@", " @@ "]) {
      const result = validateAddFriendInput(raw);
      expect(result.ok, `${JSON.stringify(raw)} should be rejected`).toBe(false);
      // "use at least 3 characters" on an untouched box reads as a broken form.
      expect(result.ok ? null : result.error.key).toBe("mobile:friends.addValidation");
    }
  });

  it("rejects a handle the server would reject, on the field", () => {
    const tooShort = validateAddFriendInput("ab");
    expect(tooShort.ok).toBe(false);

    const illegal = validateAddFriendInput("ali black!");
    expect(illegal.ok).toBe(false);
    // Whatever key it maps to, it must be a real one the catalogs can render.
    expect(illegal.ok ? "" : illegal.error.key).toMatch(/^(validation\.|mobile:)/);
  });

  it("accepts an ordinary handle unchanged", () => {
    expect(validateAddFriendInput("ali_black99")).toEqual({ ok: true, username: "ali_black99" });
  });
});

describe("addFriendError", () => {
  const err = (code: string) =>
    new ApiClientError(code as ConstructorParameters<typeof ApiClientError>[0], "x", 400);

  it("names the two failures the user can act on", () => {
    // A mistyped handle used to be answered "sent" — the sender then waited for
    // a request that was never coming.
    expect(addFriendError(err("USER_NOT_FOUND")).key).toBe("errors.userNotFound");
    expect(addFriendError(err("VALIDATION_ERROR")).key).toBe("mobile:friends.addSelf");
  });

  it("maps transport failures and falls back for anything else", () => {
    expect(addFriendError(err("RATE_LIMITED")).key).toBe("errors.rateLimited");
    expect(addFriendError(err("NETWORK")).key).toBe("errors.network");
    expect(addFriendError(new Error("boom")).key).toBe("errors.generic");
    expect(addFriendError(null).key).toBe("errors.generic");
  });
});
