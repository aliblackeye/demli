/**
 * Local persistence for the per-channel "last read" watermark that positions the
 * in-thread "New Messages" divider. Client-only for now —
 * cross-device sync is a later wave; this keeps the divider useful across app
 * restarts on THIS machine.
 *
 * Shape: `{ [channelId]: messageId }` — the newest message the user had seen the
 * last time the channel was open. The chat store reads it to freeze the divider
 * position on channel open and advances it (write-through here) as the channel is
 * viewed. Deliberately tiny and self-healing: a corrupt/absent blob just means no
 * divider until the next visit re-seeds it.
 */

const STORAGE_KEY = "demli.unread-markers.v1";

export type UnreadMarkers = Record<string, string>;

/** Read the persisted watermark map (empty object on any failure). */
export function loadUnreadMarkers(): UnreadMarkers {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Keep only string→string entries; drop anything unexpected.
    const out: UnreadMarkers = {};
    for (const [channelId, messageId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof messageId === "string") out[channelId] = messageId;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the watermark map (best-effort; ignores quota / serialization errors). */
export function saveUnreadMarkers(markers: UnreadMarkers): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
  } catch {
    // Storage unavailable / over quota — the divider just won't survive a restart.
  }
}

/**
 * Drop every persisted watermark. Called on an account switch (ADR 0013 storeReset):
 * these markers are keyed by channelId only, NOT partitioned by account, so without
 * clearing them the previous user's read positions would bleed into the next
 * account's dividers. Best-effort; a failure just leaves stale markers that the next
 * channel visit re-seeds.
 */
export function clearUnreadMarkers(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing we can do; markers self-heal on next visit.
  }
}
