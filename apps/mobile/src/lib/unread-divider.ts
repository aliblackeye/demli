/**
 * Pure positioning logic for the in-thread "New Messages" divider — the mobile
 * mirror of the renderer's lib/unread-divider.ts (kept as a tiny per-app copy
 * rather than a shared package, since the two clients don't share app code).
 *
 * Given the channel's messages oldest→newest and the persisted read watermark
 * (the last message the user had seen), return the id of the FIRST message that
 * arrived after it — the message the divider renders directly above — or `null`
 * when there is nothing new to mark. Conservative so the divider never lies:
 * - No watermark (never visited) → no divider.
 * - Watermark is the newest message → all read → no divider.
 * - Watermark not found in the loaded (newest) window → it is older than
 *   everything on screen, so the whole window is new → divider at the top.
 */

export function firstUnreadMessageId(
  ascendingIds: readonly string[],
  watermarkId: string | null | undefined,
): string | null {
  if (ascendingIds.length === 0) return null;
  if (!watermarkId) return null;

  const index = ascendingIds.indexOf(watermarkId);

  // Watermark older than the loaded window (or its message was deleted): treat
  // the oldest loaded message as the first unread.
  if (index === -1) return ascendingIds[0] ?? null;

  // Watermark is the newest message → caught up.
  if (index >= ascendingIds.length - 1) return null;

  return ascendingIds[index + 1] ?? null;
}
