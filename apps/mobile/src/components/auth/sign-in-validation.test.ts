import { describe, expect, it } from "vitest";
import { FIELD_OF, validateAuthForm } from "./sign-in-validation";

describe("sign-in form rules", () => {
  it("lets a well-formed login through", () => {
    expect(validateAuthForm("login", "ali_42", "x", null)).toBeNull();
  });

  it("lets a well-formed registration through", () => {
    expect(validateAuthForm("register", "ali_42", "longenough", "1990-04-12")).toBeNull();
  });

  it("rejects a handle outside 3–32 letters/digits/underscore", () => {
    expect(validateAuthForm("login", "al", "x", null)).toBe("username");
    expect(validateAuthForm("login", "ali veli", "x", null)).toBe("username");
    expect(validateAuthForm("login", "a".repeat(33), "x", null)).toBe("username");
  });

  it("asks for a password on login, and 8+ characters on register", () => {
    expect(validateAuthForm("login", "ali", "", null)).toBe("passwordRequired");
    expect(validateAuthForm("register", "ali", "short", "1990-04-12")).toBe("passwordShort");
  });

  it("requires a valid date of birth only when registering", () => {
    expect(validateAuthForm("register", "ali", "longenough", null)).toBe("birthdate");
    expect(validateAuthForm("login", "ali", "pw", null)).toBeNull();
  });

  it("reports the FIRST problem from the top, so the message sits on the field to fix now", () => {
    expect(validateAuthForm("register", "a", "short", null)).toBe("username");
    expect(validateAuthForm("register", "ali", "short", null)).toBe("passwordShort");
  });

  it("writes every failure under exactly one field", () => {
    expect(FIELD_OF).toEqual({
      username: "username",
      passwordShort: "password",
      passwordRequired: "password",
      birthdate: "birthdate",
    });
  });
});
