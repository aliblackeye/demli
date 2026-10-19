/**
 * Sign-in / register form rules — pure, so the field each failure lands on is
 * unit-tested instead of eyeballed.
 *
 * The design system's validation recipe: a field's problem is written UNDER
 * that field (and the field takes the danger wash); only a refusal from the
 * server (wrong password, network, a taken name) is a form-level band. So every
 * local rule maps to exactly one field.
 */

export type AuthMode = "login" | "register";

/** Stable validation outcomes, mapped to localized copy at render. */
export type AuthValidationCode = "username" | "passwordShort" | "passwordRequired" | "birthdate";

export type AuthField = "username" | "password" | "birthdate";

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

/** The field a validation failure is written under. */
export const FIELD_OF: Record<AuthValidationCode, AuthField> = {
  username: "username",
  passwordShort: "password",
  passwordRequired: "password",
  birthdate: "birthdate",
};

/**
 * The FIRST problem with the form, top to bottom (the order the fields appear),
 * or null when it may be sent. One at a time on purpose: the user fixes the
 * field the message sits under, then the next one surfaces.
 */
export function validateAuthForm(
  mode: AuthMode,
  username: string,
  password: string,
  birthdate: string | null,
): AuthValidationCode | null {
  if (!USERNAME_PATTERN.test(username)) return "username";
  if (mode === "register" && password.length < 8) return "passwordShort";
  if (mode === "login" && password.length === 0) return "passwordRequired";
  if (mode === "register" && !birthdate) return "birthdate";
  return null;
}
