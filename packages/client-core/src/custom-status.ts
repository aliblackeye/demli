/**
 * Custom status (M18) — the two rules every surface has to agree on:
 *
 *  1. WHAT A DURATION CHOICE MEANS. "30 minutes" / "1 hour" / "today" have to
 *     become `expiresInMinutes` for `PUT /users/me/custom-status`, and "today"
 *     is the only interesting one: it is the user's OWN local midnight, not the
 *     server's, computed at submit time.
 *  2. WHETHER A STORED STATUS IS STILL SHOWABLE. The API nulls an expired status
 *     at read time (packages/db mappers), so a FRESH fetch is always clean — but
 *     a client holds `User` DTOs for minutes or hours, and a status that expired
 *     while the app was open must stop rendering without waiting for a refetch.
 *
 * Both rules are pure functions here so desktop/web and mobile cannot drift on
 * them, and so the awkward cases (a blank status, a malformed timestamp, a
 * 23:59:30 "today") are decided once and tested once instead of per renderer.
 *
 * Framework-free: no React, no DOM, no Intl. `now` is always injectable so the
 * tests are not clock-dependent.
 */

import { CUSTOM_STATUS_MAX_MINUTES } from "@demli/config";

/**
 * The duration options offered by the status editor, in display order.
 * `never` means "don't clear it" — the request omits `expiresInMinutes`.
 */
export const CUSTOM_STATUS_EXPIRY_CHOICES = ["never", "30m", "1h", "today"] as const;

export type CustomStatusExpiry = (typeof CUSTOM_STATUS_EXPIRY_CHOICES)[number];

/** Anything carrying the two wire fields — `User`, or a partial profile DTO. */
export interface CustomStatusCarrier {
  customStatus?: string | null;
  customStatusExpiresAt?: string | null;
}

/** Normalize an injectable clock (epoch ms or Date) to epoch ms. */
function toEpochMs(now: number | Date | undefined): number {
  if (now === undefined) return Date.now();
  return now instanceof Date ? now.getTime() : now;
}

/**
 * Minutes to send for a duration choice, or `undefined` for "don't clear".
 *
 * "Today" is the number of minutes until the NEXT local midnight, so it always
 * lands inside the same calendar day the user is looking at. Two edges are
 * handled deliberately:
 *
 * - Floored at 1, because the API's minimum is 1 minute: setting a status at
 *   23:59:30 would otherwise round to 0 and come back as a validation error —
 *   a rounding artefact must never surface to the user as "invalid input".
 * - Capped at {@link CUSTOM_STATUS_MAX_MINUTES}, the server's own ceiling, so a
 *   device whose clock is badly wrong produces a rejected-but-honest request
 *   rather than a number the schema refuses outright.
 */
export function customStatusExpiryMinutes(
  choice: CustomStatusExpiry,
  now?: number | Date,
): number | undefined {
  switch (choice) {
    case "never":
      return undefined;
    case "30m":
      return 30;
    case "1h":
      return 60;
    case "today": {
      const at = new Date(toEpochMs(now));
      const midnight = new Date(at);
      midnight.setHours(24, 0, 0, 0);
      const minutes = Math.round((midnight.getTime() - at.getTime()) / 60_000);
      return Math.min(CUSTOM_STATUS_MAX_MINUTES, Math.max(1, minutes));
    }
  }
}

/**
 * The exact body for `PUT /users/me/custom-status` (or the clear call) given
 * what the editor holds.
 *
 * "Empty means clear" is the founder-stated rule, so a blank/whitespace-only box
 * produces `{ text: null }` and no duration — a duration on a cleared status
 * would be a timer over nothing. The caller routes `text: null` to
 * `clearCustomStatus()`; everything else to `setCustomStatus()`.
 */
export function buildCustomStatusInput(
  text: string,
  expiry: CustomStatusExpiry,
  now?: number | Date,
): { text: null } | { text: string; expiresInMinutes?: number } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text: null };
  const expiresInMinutes = customStatusExpiryMinutes(expiry, now);
  return expiresInMinutes === undefined ? { text: trimmed } : { text: trimmed, expiresInMinutes };
}

/**
 * `true` once `expiresAt` is in the past. Absent/blank = never expires;
 * an unparseable timestamp is treated as NOT expired, because hiding a status
 * the user really set is a worse failure than briefly showing a stale one (the
 * next fetch corrects it authoritatively).
 */
export function isCustomStatusExpired(
  expiresAt: string | null | undefined,
  now?: number | Date,
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return false;
  return at <= toEpochMs(now);
}

/**
 * The status line to render for a user, or `null` when there is nothing to show.
 *
 * One function for every surface (roster row, profile card, own footer): it
 * trims, drops the empty string, and drops an EXPIRED status — so a status whose
 * "clears at 18:00" passed while the app stayed open disappears on the next
 * render instead of lingering until a refetch.
 */
export function visibleCustomStatus(
  carrier: CustomStatusCarrier | null | undefined,
  now?: number | Date,
): string | null {
  const text = carrier?.customStatus?.trim();
  if (!text) return null;
  if (isCustomStatusExpired(carrier?.customStatusExpiresAt, now)) return null;
  return text;
}
