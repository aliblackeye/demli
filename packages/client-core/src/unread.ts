/**
 * Shared, framework-free helpers for the per-channel unread COUNT badge (#110).
 *
 * Both clients keep a live, per-channel `unreadCount` that increments as
 * background messages arrive and resets to 0 when the channel is read (the fold
 * lives in each app's chat store). This module owns the ONE rule both platforms
 * render identically: how a raw count + the legacy boolean "has unread" flag turn
 * into the little badge string.
 *
 * The honesty rule (founder: "sayı yalanı YOK"): we only ever print a number we
 * actually counted. When we know a stream is unread but have no counted total —
 * a cold start, or a server-seeded boolean that predates this session's deltas —
 * we print the neutral "1+" marker, never a fabricated "1".
 */

/** Above this the badge shows "{CAP}+" instead of the exact number. */
export const UNREAD_BADGE_CAP = 99;

/** The marker shown when a stream is known-unread but its real count is unknown. */
export const UNREAD_UNKNOWN_BADGE = "1+";

/**
 * The text a per-channel unread badge should display, or `null` for no badge.
 *
 * - `count > 0`             → the real number, capped as `"{CAP}+"`.
 * - `count === 0 & hasUnread` → {@link UNREAD_UNKNOWN_BADGE} ("1+") — we know it
 *   is unread but never counted it (cold start / server-seeded boolean).
 * - otherwise               → `null`.
 *
 * `count` is clamped at 0 so a negative (bad fold) can never print.
 */
export function unreadBadgeText(count: number, hasUnread: boolean): string | null {
  const n = Math.max(0, Math.floor(count));
  if (n > 0) return n > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(n);
  return hasUnread ? UNREAD_UNKNOWN_BADGE : null;
}
