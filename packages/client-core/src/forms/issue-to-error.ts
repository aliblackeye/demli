/**
 * zod issue → `{ key, params }` — the layer that finally tells a user WHICH rule
 * they broke.
 *
 * The bug this exists to kill: the API answers a failed validation with
 * `VALIDATION_ERROR`, and both clients map that code straight onto
 * `errors.generic` ("Something went wrong"). A user who typed a 40-character
 * display name, a username with a dot in it, or a 200-character password was
 * told nothing at all — the rule existed, was enforced, and was invisible. A
 * form the user cannot satisfy is worse than a form with no rules, which is the
 * complaint that started this work.
 *
 * The mapping is one-way and total: every zod issue produces a key. Unknown
 * issue codes fall back to `validation.invalid`, so a new rule can degrade to a
 * vague message but can never crash a form or render "[object Object]".
 *
 * Returned as a KEY plus params, never as a string (ADR 0009): this package is
 * shared by desktop, web and mobile, and each of them owns its own `t()`.
 */

import { z } from "zod";
import { validationCodeOf, type ValidationCode } from "@demli/protocol";

/** Interpolation values for a validation message, e.g. `{ max: 64 }`. */
export type ValidationParams = Record<string, string | number>;

/** A translatable field error: an i18n key plus its interpolation values. */
export interface FieldError {
  /** A `validation.*` key present in the `common` catalog, both languages. */
  key: string;
  /** Values for the key's `{{placeholders}}`; omitted when it has none. */
  params?: ValidationParams;
}

/** Every key this mapper can emit. Exported so an i18n test can assert coverage. */
export const VALIDATION_KEYS = [
  "validation.required",
  "validation.tooShort",
  "validation.tooLong",
  "validation.numberTooSmall",
  "validation.numberTooBig",
  "validation.notInteger",
  "validation.notANumber",
  "validation.invalidType",
  "validation.invalidOption",
  "validation.invalidEmail",
  "validation.invalidUrl",
  "validation.invalidId",
  "validation.invalidDateTime",
  "validation.pattern.username",
  "validation.pattern.emojiName",
  "validation.pattern.hexColor",
  "validation.noVisibleCharacter",
  "validation.reservedUsername",
  "validation.passwordCommon",
  "validation.passwordIsUsername",
  "validation.invalidDate",
  "validation.dateOutOfRange",
  "validation.invalidInviteCode",
  "validation.emptyUpdate",
  "validation.emptyMessage",
  "validation.invalid",
] as const;

/** One of {@link VALIDATION_KEYS}. */
export type ValidationKey = (typeof VALIDATION_KEYS)[number];

/**
 * The Demli custom codes, mapped exhaustively.
 *
 * `Record<ValidationCode, ValidationKey>` rather than a lookup with a fallback:
 * adding a code in `@demli/protocol` without adding its key here is then a
 * TYPE error, not a silent downgrade to "invalid" — which is the same class of
 * silent-degradation bug this whole file is fixing.
 */
const CODE_KEYS: Record<ValidationCode, ValidationKey> = {
  noVisibleCharacter: "validation.noVisibleCharacter",
  usernamePattern: "validation.pattern.username",
  reservedUsername: "validation.reservedUsername",
  emojiNamePattern: "validation.pattern.emojiName",
  hexColorPattern: "validation.pattern.hexColor",
  invalidUrl: "validation.invalidUrl",
  passwordCommon: "validation.passwordCommon",
  passwordIsUsername: "validation.passwordIsUsername",
  invalidDate: "validation.invalidDate",
  dateOutOfRange: "validation.dateOutOfRange",
  invalidInviteCode: "validation.invalidInviteCode",
  emptyUpdate: "validation.emptyUpdate",
  emptyMessage: "validation.emptyMessage",
};

/** zod's `invalid_string` validations that have a dedicated message. */
const STRING_VALIDATION_KEYS: Record<string, ValidationKey> = {
  email: "validation.invalidEmail",
  url: "validation.invalidUrl",
  uuid: "validation.invalidId",
  cuid: "validation.invalidId",
  datetime: "validation.invalidDateTime",
};

/** Everything a custom issue carried besides its Demli code. */
function customParams(issue: z.ZodIssue): ValidationParams | undefined {
  if (issue.code !== z.ZodIssueCode.custom) return undefined;
  const raw = issue.params as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const params: ValidationParams = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "demliCode") continue;
    if (typeof value === "string" || typeof value === "number") params[key] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Translate one zod issue into a key + params.
 *
 * `too_small` on a string with `minimum === 1` becomes `required` rather than
 * "at least 1 character": to a user, an empty required field is not a
 * length problem, and telling them their name needs "at least 1 character" is
 * the kind of message that reads like the form is broken.
 */
export function issueToError(issue: z.ZodIssue): FieldError {
  const code = validationCodeOf(issue);
  if (code) {
    const params = customParams(issue);
    return params ? { key: CODE_KEYS[code], params } : { key: CODE_KEYS[code] };
  }

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      // A missing field arrives as `undefined`/`null`, not as a wrong type.
      if (issue.received === "undefined" || issue.received === "null") {
        return { key: "validation.required" };
      }
      // zod reports `.int()` and NaN through invalid_type rather than through a
      // dedicated code, so both would otherwise read as "wrong format" when the
      // user's actual mistake is a decimal point or a non-numeric character.
      if (issue.expected === "integer") return { key: "validation.notInteger" };
      if (issue.received === "nan") return { key: "validation.notANumber" };
      return { key: "validation.invalidType" };

    case z.ZodIssueCode.too_small: {
      const min = Number(issue.minimum);
      if (issue.type === "string" || issue.type === "array") {
        return min <= 1
          ? { key: "validation.required" }
          : { key: "validation.tooShort", params: { min } };
      }
      return { key: "validation.numberTooSmall", params: { min } };
    }

    case z.ZodIssueCode.too_big: {
      const max = Number(issue.maximum);
      return issue.type === "string" || issue.type === "array"
        ? { key: "validation.tooLong", params: { max } }
        : { key: "validation.numberTooBig", params: { max } };
    }

    case z.ZodIssueCode.invalid_string: {
      const validation =
        typeof issue.validation === "string" ? issue.validation : "regex";
      return { key: STRING_VALIDATION_KEYS[validation] ?? "validation.invalid" };
    }

    case z.ZodIssueCode.not_multiple_of:
      return { key: "validation.notInteger" };

    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { key: "validation.invalidOption" };

    case z.ZodIssueCode.invalid_date:
      return { key: "validation.invalidDate" };

    default:
      return { key: "validation.invalid" };
  }
}

/** A field path rendered as a dotted string, e.g. `channels.0.channelId`. */
export function issuePath(issue: z.ZodIssue): string {
  return issue.path.join(".");
}

/**
 * All issues as a `path → FieldError` map, ready to drive a form.
 *
 * FIRST issue per path wins. zod reports checks in declaration order, and the
 * first failure is the one closest to what the user actually did — an empty
 * required field should say "required", not also "must contain a visible
 * character" the moment they type a space.
 *
 * The object-level path (`""`) holds cross-field failures such as "password
 * cannot be your username" when the schema did not pin them to a field.
 */
export function issuesToFieldErrors(error: z.ZodError): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const issue of error.issues) {
    const path = issuePath(issue);
    if (path in errors) continue;
    errors[path] = issueToError(issue);
  }
  return errors;
}

/** The single most relevant error — for a surface with one message slot (a toast). */
export function firstFieldError(error: z.ZodError): FieldError {
  const issue = error.issues[0];
  return issue ? issueToError(issue) : { key: "validation.invalid" };
}

/**
 * Validate and return either the parsed value or the field-error map.
 *
 * The shape a form wants: no throwing, no `error.issues` walking at every call
 * site, and a `Record` keyed exactly like the schema's fields.
 */
export function validateForm<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
):
  | { ok: true; value: z.infer<Schema> }
  | { ok: false; errors: Record<string, FieldError> } {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, errors: issuesToFieldErrors(result.error) };
}
