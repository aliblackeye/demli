/**
 * Local persistence for the per-channel "last read" watermark that positions the
 * in-thread "New Messages" divider on mobile. The desktop
 * mirror of this lives in the renderer's lib/unread-storage.ts; this is the same
 * contract expressed over `expo-secure-store` — the SAME native module the app
 * already ships for the locale / session token / media settings, so it adds NO
 * new native dependency and stays OTA-safe (pure JS state).
 *
 * Shape: `{ [channelId]: messageId }` — the newest message the user had seen the
 * last time the channel was open. Client-only for now; cross-device sync is a
 * later wave. Reads/writes are best-effort and self-healing: a corrupt or absent
 * blob simply means no divider until the next visit re-seeds it.
 *
 * SecureStore values are size-limited on Android, so the store caps how many
 * channels it tracks (see chat-store) — this module just serializes what it's
 * given and debounces writes so a burst of message arrivals is one keystore hit.
 */

import { secureStorage } from "./secure-storage";

const STORAGE_KEY = "demli.unread-markers.v1";
/** Coalesce rapid marker advances (one per incoming message) into one write. */
const SAVE_DEBOUNCE_MS = 800;

export type UnreadMarkers = Record<string, string>;

/** Read the persisted watermark map (empty object on any failure). */
export async function loadUnreadMarkers(): Promise<UnreadMarkers> {
  try {
    const raw = await secureStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: UnreadMarkers = {};
    for (const [channelId, messageId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof messageId === "string") out[channelId] = messageId;
    }
    return out;
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMarkers: UnreadMarkers | null = null;

/** Persist the watermark map (debounced, best-effort). Latest call wins. */
export function saveUnreadMarkers(markers: UnreadMarkers): void {
  pendingMarkers = markers;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = pendingMarkers;
    pendingMarkers = null;
    if (!snapshot) return;
    void secureStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {
      // Keystore unavailable — the divider just won't survive a restart.
    });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Drop every persisted watermark on an account switch (ADR 0013 storeReset).
 * The markers are keyed by channelId only, NOT partitioned by account, so
 * without clearing them the previous user's read positions would bleed into the
 * next account's dividers. Cancels any pending debounced write so it can't
 * resurrect the old snapshot after the wipe.
 */
export function clearUnreadMarkers(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingMarkers = null;
  void secureStorage.removeItem(STORAGE_KEY).catch(() => {
    // Keystore unavailable — markers self-heal on the next channel visit.
  });
}
