/**
 * Local persistence for per-stream message drafts (M17). Mirrors this renderer's
 * lib/unread-storage.ts: a single JSON blob in `localStorage`, best-effort and
 * self-healing (a corrupt/absent blob just means no drafts until you type again).
 *
 * localStorage rehydrates synchronously, so the store seeds itself from
 * {@link loadDrafts} at construction and every draft is available before the first
 * channel opens. Writes are cheap and already throttled upstream (the store commits
 * on a debounce), so this module stays a thin serialize/parse layer.
 */

import { sanitizeDraftMap, type DraftMap } from "../stores/draft-model";

const STORAGE_KEY = "demli.drafts.v1";

/** Read the persisted draft map (empty object on any failure). */
export function loadDrafts(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeDraftMap(JSON.parse(raw), Date.now());
  } catch {
    return {};
  }
}

/** Persist the draft map (best-effort; ignores quota / serialization errors). */
export function saveDrafts(drafts: DraftMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Storage unavailable / over quota — drafts just won't survive a restart.
  }
}
