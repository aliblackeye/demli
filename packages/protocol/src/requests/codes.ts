/**
 * Machine-readable codes for the validation failures zod cannot express on its
 * own (a reserved username, a breached password, a date that is not a real
 * calendar date, …).
 *
 * These are CODES, never sentences. The rule that a schema carries **zero
 * user-facing text** is what keeps ADR 0009 (i18n lives in the catalogs, not in
 * shared logic) intact: `@demli/protocol` is imported by the API, the gateway,
 * the desktop renderer, the web SPA and the RN app, and only the last three have
 * a locale. A schema that embedded "Bu kullanıcı adı ayrılmış" would either ship
 * Turkish to an English user or force the API to carry translation catalogs.
 *
 * The code round-trips inside the zod issue's `params` bag (see {@link customIssue})
 * and is turned into an i18n key by `@demli/client-core`'s
 * `forms/issue-to-error.ts` — the ONE place that knows about `validation.*` keys.
 */

import { z } from "zod";

/**
 * Every custom validation code a request schema may raise.
 *
 * Adding one here without adding its key to `issue-to-error.ts` is caught by a
 * test in client-core (the mapper is exhaustive over this list), so a new rule
 * can never silently degrade to the generic "something went wrong" message —
 * which is the exact bug this whole layer exists to kill.
 */
export const VALIDATION_CODES = [
  /** Free-text field held nothing but whitespace / invisible characters. */
  "noVisibleCharacter",
  /** Username failed the `^[a-zA-Z0-9_]+$` grammar. */
  "usernamePattern",
  /** Username is on the reserved list (`everyone`, `admin`, …). */
  "reservedUsername",
  /** Custom-emoji name failed the `^[a-z0-9_]{2,32}$` grammar. */
  "emojiNamePattern",
  /** Colour field was not a `#rrggbb` hex triplet. */
  "hexColorPattern",
  /** Value was not an absolute `http:`/`https:` URL. */
  "invalidUrl",
  /** Password appears on the embedded common/breached-password denylist. */
  "passwordCommon",
  /** Password equals the account's own username (case-insensitively). */
  "passwordIsUsername",
  /** Date string was well-formed but is not a real calendar date (e.g. 2026-02-30). */
  "invalidDate",
  /** Date is a real date but outside the allowed window. */
  "dateOutOfRange",
  /** Invite input did not yield a usable code after link parsing. */
  "invalidInviteCode",
  /** A PATCH body named no field at all (client bug, never a user mistake). */
  "emptyUpdate",
  /** A message body carried neither text nor an attachment. */
  "emptyMessage",
] as const;

/** One of {@link VALIDATION_CODES}. */
export type ValidationCode = (typeof VALIDATION_CODES)[number];

/** Interpolation values a validation message may need, e.g. `{ max: 64 }`. */
export type ValidationParams = Record<string, string | number>;

/** The shape {@link customIssue} stashes in a zod issue's `params` bag. */
export type ValidationIssueParams = ValidationParams & { demliCode: ValidationCode };

/**
 * Build the `ctx.addIssue()` argument for a custom rule.
 *
 * `message` is set to the bare code on purpose: zod would otherwise default to
 * the English string "Invalid input", which is exactly the kind of untranslatable
 * text that must not leak to a user. A code in the message slot is useless to a
 * UI (which reads `params.demliCode` instead) but genuinely useful in an API
 * log line, so the field earns its keep without becoming a translation.
 */
export function customIssue(
  code: ValidationCode,
  params?: ValidationParams,
): { code: typeof z.ZodIssueCode.custom; message: string; params: ValidationIssueParams } {
  return {
    code: z.ZodIssueCode.custom,
    message: code,
    params: { ...params, demliCode: code },
  };
}

/**
 * Read the Demli code back out of an arbitrary zod issue, or `null` when the
 * issue is one of zod's own (`too_small`, `invalid_type`, …).
 */
export function validationCodeOf(issue: z.ZodIssue): ValidationCode | null {
  if (issue.code !== z.ZodIssueCode.custom) return null;
  const params = issue.params as Partial<ValidationIssueParams> | undefined;
  const code = params?.demliCode;
  return code !== undefined && (VALIDATION_CODES as readonly string[]).includes(code) ? code : null;
}
