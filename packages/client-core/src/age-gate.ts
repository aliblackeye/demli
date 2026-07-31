/**
 * The 18+ age-gate decisions — the ONE place desktop/web AND mobile derive them.
 *
 * Two flows live here, both framework-free so they can be unit-tested without a
 * DOM and shared by two very different renderers:
 *
 *  1. {@link nsfwGateStage} — what an NSFW channel must show a given viewer:
 *     verify your age here, you are permanently blocked, or acknowledge the
 *     warning. The IN-PLACE verification (M-age): a user with no date of birth
 *     no longer gets bounced to settings, they enter it right at the gate.
 *  2. {@link shouldPromptForBirthdate} — whether the one-time, dismissible
 *     "verify your age" nudge is due. Never blocking: it is a pill/banner the
 *     user can wave off forever, because most accounts never touch an NSFW
 *     channel and must not be nagged about one.
 *
 * PRIVACY: nothing here handles or returns a raw date of birth except the value
 * the user is typing on their own screen. `birthdate` is me-only (it never rides
 * a public DTO or a realtime event) and peers only ever see the derived
 * `isAdult`. Do not widen these signatures to carry someone else's date.
 */

import { ApiClientError } from "./api-client.js";

/** Legal-adult threshold for age-restricted content. Matches the server rule. */
export const ADULT_AGE = 18;

/** `YYYY-MM-DD` — the shape stored in Postgres and carried on `User.birthdate`. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whole years old on `now`, or null when `birthdate` is not a real, non-future
 * ISO calendar date. Computed in UTC so it is deterministic regardless of the
 * device's timezone — the same rule the server's `isAdult` derivation uses, so
 * the confirmation screen can never promise an age the server disagrees with.
 */
export function ageInYears(
  birthdate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!birthdate) return null;
  const match = ISO_DATE.exec(birthdate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a rolled-over date (2001-02-30 → March 2) rather than silently
  // accepting garbage as a birthday.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return null;
  }
  if (asDate.getTime() > now.getTime()) return null;

  let age = now.getUTCFullYear() - year;
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();
  if (nowMonth < month || (nowMonth === month && nowDay < day)) age--;
  return age;
}

/** True when the entered ISO date is a real, non-future date of an 18+ person. */
export function isAdultBirthdate(birthdate: string, now: Date = new Date()): boolean {
  const age = ageInYears(birthdate, now);
  return age !== null && age >= ADULT_AGE;
}

/**
 * Reformat an ISO `YYYY-MM-DD` as `DD.MM.YYYY` for the confirmation screen.
 * Deliberately Intl-free (React Native's Hermes ships a trimmed Intl) and
 * deterministic — this string exists to let the user double-check what they
 * typed BEFORE it is written once and for all, so it must never surprise them.
 * Returns the input unchanged when it is not an ISO date.
 */
export function formatBirthdateDisplay(birthdate: string): string {
  const match = ISO_DATE.exec(birthdate);
  if (!match) return birthdate;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/**
 * What an NSFW channel shows a viewer instead of its content:
 *
 * - `"verifyAge"`   — no date of birth on file: show the IN-PLACE date entry
 *                     (set-once) so the user never has to leave for settings.
 * - `"minorBlocked"`— a date of birth IS on file and it is under 18: a final,
 *                     honest refusal. NO input is offered, because the value is
 *                     set-once server-side and a second attempt would 409 — an
 *                     entry field here would be a control that cannot work (§35).
 * - `"confirmAdult"`— adult, but has not yet acknowledged this channel's warning.
 * - `null`          — nothing to gate: render the channel.
 */
export type NsfwGateStage = "verifyAge" | "minorBlocked" | "confirmAdult";

export interface NsfwGateInput {
  /** `/users/me`'s derived 18+ flag. Never another user's. */
  isAdult: boolean;
  /** Whether a date of birth already exists on the account (set-once). */
  birthdateSet: boolean;
  /** Whether this viewer already acknowledged THIS channel's 18+ warning. */
  acknowledged: boolean;
}

/**
 * Pure gate decision. Re-run it with a fresh `/users/me` and the channel opens
 * without a reload: saving a birthdate flips `isAdult`, which moves the stage
 * from `"verifyAge"` to `"confirmAdult"`, and the acknowledgement moves it to
 * `null`.
 */
export function nsfwGateStage(input: NsfwGateInput): NsfwGateStage | null {
  if (!input.isAdult) return input.birthdateSet ? "minorBlocked" : "verifyAge";
  return input.acknowledged ? null : "confirmAdult";
}

/**
 * True when the server refused a birthdate write because one is already stored
 * (`409 BIRTHDATE_LOCKED`, set-once). The caller should re-read `/users/me`
 * rather than argue: the server's value is the truth, and the gate re-derives
 * itself from it.
 */
export function isBirthdateLockedError(err: unknown): boolean {
  return err instanceof ApiClientError && err.code === "BIRTHDATE_LOCKED";
}

export interface BirthdatePromptInput {
  /**
   * True once the caller's own `/users/me` record has actually been read. We
   * never nag on a guess — an un-loaded self record looks exactly like "no
   * birthdate" and would flash the prompt at every cold start.
   */
  selfLoaded: boolean;
  /** Whether a date of birth already exists on the account. */
  birthdateSet: boolean;
  /** Whether THIS account already dismissed the nudge (persisted, per account). */
  dismissed: boolean;
}

/**
 * Whether the one-time "verify your age" nudge is due.
 *
 * Non-blocking by construction: the answer only ever decides whether a small
 * dismissible affordance renders. Once dismissed it stays dismissed — a user who
 * never opens an NSFW channel must never see it twice, and one who does will hit
 * the real gate anyway.
 */
export function shouldPromptForBirthdate(input: BirthdatePromptInput): boolean {
  return input.selfLoaded && !input.birthdateSet && !input.dismissed;
}
