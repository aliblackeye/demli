/**
 * Sign-up / sign-in request bodies.
 *
 * The rules that changed here relative to the API's current inline schemas are
 * deliberate, and each one is justified where it is declared:
 *  - usernames gain a reserved-name check (register/rename only);
 *  - registration passwords gain a breached-password denylist and a
 *    "password is not your username" check, and gain NO composition rules;
 *  - LOGIN is untouched at `min(1).max(128)` — see {@link loginPasswordField}.
 */

import { z } from "zod";
import {
  BIRTH_YEAR_MIN,
  DEVICE_NAME_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  isReservedUsername,
  PASSWORD_LOGIN_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from "@demli/config";
import { customIssue } from "./codes.js";
import { isCommonPassword } from "./common-passwords.js";
import { sanitizedText, type TextField } from "./text.js";

/**
 * A username as typed, normalized to lowercase. Grammar-checked but NOT
 * reserved-checked — use {@link claimedUsername} for register/rename.
 *
 * Login and add-by-username take this one: they LOOK UP an existing account, and
 * an account that was created before the reserved list existed must still be
 * able to sign in and still be addable as a friend. Applying the reserved check
 * on a lookup path would strand exactly the users it is meant to protect.
 */
export const usernameField: TextField = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .superRefine((value, ctx) => {
    if (!USERNAME_PATTERN.test(value)) ctx.addIssue(customIssue("usernamePattern"));
  })
  .transform((value) => value.toLowerCase());

/**
 * A username being CLAIMED (registration, rename): the grammar above plus the
 * reserved-name refusal.
 *
 * Split from {@link usernameField} on purpose — the reserved list must gate what
 * a name can BECOME without ever invalidating a name that already exists.
 */
export const claimedUsername: TextField = usernameField.superRefine((value, ctx) => {
  if (isReservedUsername(value)) ctx.addIssue(customIssue("reservedUsername"));
});

/**
 * A password being SET: 8..128, and not one of the top breached passwords.
 *
 * No uppercase/digit/symbol requirement, by decision. NIST SP 800-63B §5.1.1.2
 * recommends length plus a compromised-password check and explicitly advises
 * AGAINST composition rules, because they reliably produce `Password1!` — which
 * the denylist below rejects — while blocking a long passphrase for the crime of
 * having no punctuation.
 */
export const newPasswordField: TextField = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((value, ctx) => {
    if (isCommonPassword(value)) ctx.addIssue(customIssue("passwordCommon"));
  });

/**
 * A password being PRESENTED at login: 1..128. **This must not get stricter.**
 *
 * Every rule above applies to passwords being created. A login form that
 * enforced them would reject the stored password of every account created before
 * the rule — the user could not sign in, and the change-password screen is
 * behind the login. Login's only job is to confirm something was typed; the
 * server then compares the hash and answers with the same uniform failure either
 * way. A regression test pins this at 1.
 */
export const loginPasswordField: TextField = z
  .string()
  .min(PASSWORD_LOGIN_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

/** Display name: 1..64, sanitized, unicode-free-for-all (real names are not ASCII). */
export const displayNameField: TextField = sanitizedText({
  min: 1,
  max: DISPLAY_NAME_MAX_LENGTH,
  requireVisible: true,
});

/** True when `y-m-d` is a real calendar date (rejects 2026-02-30, 2026-13-01). */
function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date of birth as `YYYY-MM-DD`: a REAL calendar date, year >= 1901, not in the
 * future.
 *
 * NOTE — there is deliberately no minimum-age rule. Whether Demli refuses
 * under-13 (COPPA) or under-16 (GDPR Art. 8) registrations is a product/legal
 * call for the founder, not an engineering default (CLAUDE.md §33); when it is
 * decided it belongs right here, as one more `dateOutOfRange` issue. The stored
 * value already drives the NSFW age gate, which is a separate question from
 * whether an account may exist at all.
 */
export const birthdateField: TextField = z.string().superRefine((value, ctx) => {
  if (!ISO_DATE.test(value)) {
    ctx.addIssue(customIssue("invalidDate"));
    return;
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (!isRealDate(year, month, day)) {
    ctx.addIssue(customIssue("invalidDate"));
    return;
  }
  const asUtc = Date.UTC(year, month - 1, day);
  if (year < BIRTH_YEAR_MIN || asUtc > Date.now()) {
    ctx.addIssue(customIssue("dateOutOfRange", { min: BIRTH_YEAR_MIN }));
  }
});

/**
 * Optional device label for the active-sessions list (M15-A). Lenient on
 * purpose: an omitted, blank or over-long value is normalized to `undefined`
 * rather than failing, because a cosmetic label must never be able to 400 a
 * login.
 */
export const deviceNameField = z
  .string()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().slice(0, DEVICE_NAME_MAX_LENGTH);
    return trimmed.length > 0 ? trimmed : undefined;
  });

/** Client surface, silently coerced — an odd/newer client must not 400 its own login. */
export const platformField = z
  .string()
  .optional()
  .transform((value): "desktop" | "mobile" | undefined =>
    value === "desktop" || value === "mobile" ? value : undefined,
  );

/**
 * `POST /auth/register`.
 *
 * The cross-field check runs at the object level because it needs both values:
 * a password equal to the username is the single most guessable password an
 * account can have, and it is the one case the static denylist cannot catch. The
 * issue is attached to `password`, not to the form root, so the message lands on
 * the field the user has to change.
 */
export const registerBodySchema = z
  .object({
    username: claimedUsername,
    password: newPasswordField,
    displayName: displayNameField.optional(),
    birthdate: birthdateField.optional(),
    deviceName: deviceNameField,
    platform: platformField,
  })
  .superRefine((body, ctx) => {
    if (body.password.toLowerCase() === body.username.toLowerCase()) {
      ctx.addIssue({ ...customIssue("passwordIsUsername"), path: ["password"] });
    }
  });

/** `POST /auth/login`. Password bounds are intentionally the loose ones. */
export const loginBodySchema = z.object({
  username: usernameField,
  password: loginPasswordField,
  /**
   * M15: re-sending the same credentials with `reactivate: true` clears a
   * pending account deletion and signs the user back in. Ignored for a live
   * account.
   */
  reactivate: z.boolean().optional(),
  deviceName: deviceNameField,
  platform: platformField,
});

/** `POST /auth/google`. */
export const googleBodySchema = z.object({
  idToken: z.string().min(1),
  deviceName: deviceNameField,
  platform: platformField,
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type GoogleBody = z.infer<typeof googleBodySchema>;
