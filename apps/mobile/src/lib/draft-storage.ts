/**
 * Mobile persistence for per-stream message drafts (M17) — the mobile counterpart
 * of the desktop renderer's lib/draft-storage.ts. Both expose the same synchronous
 * `loadDrafts` / `saveDrafts` seam so the shared stores/draft-store.ts sits on top
 * unchanged; only the storage medium differs.
 *
 * Medium: a single JSON blob in a file under the app's document directory, via
 * expo-file-system's synchronous File API (`textSync` / `write`). Two reasons this
 * over the obvious alternatives:
 *  - OTA safety (CLAUDE.md §32): expo-file-system is ALREADY baked into the shipped
 *    APK (used by attachments + the self-updater), so this adds no native module and
 *    stays deliverable over-the-air. `@react-native-async-storage/async-storage`
 *    would be a NEW native module and break OTA for installed builds.
 *  - Size: a draft is capped at 4k chars and we keep up to 100 of them, which can
 *    exceed expo-secure-store's ~2KB per-value cap — a plain file has no such limit.
 *
 * The sync API lets the store seed itself at construction (like desktop's
 * localStorage), so a restored draft is in memory before the first channel opens.
 * Reads/writes are best-effort and self-healing: a missing/corrupt file just means
 * no drafts until you type again. Writes are already throttled upstream (the store
 * commits on a debounce), so a tiny synchronous file write per commit is cheap.
 */

import { File, Paths } from "expo-file-system";
import { sanitizeDraftMap, type DraftMap } from "../stores/draft-model";

const DRAFTS_FILENAME = "demli-drafts.v1.json";

/** Handle to the drafts file in the document directory (created on first write). */
function draftsFile(): File {
  return new File(Paths.document, DRAFTS_FILENAME);
}

/** Read the persisted draft map (empty object on any failure). */
export function loadDrafts(): DraftMap {
  try {
    const file = draftsFile();
    if (!file.exists) return {};
    const raw = file.textSync();
    if (!raw) return {};
    return sanitizeDraftMap(JSON.parse(raw), Date.now());
  } catch {
    return {};
  }
}

/** Persist the draft map (best-effort; ignores I/O errors). */
export function saveDrafts(drafts: DraftMap): void {
  try {
    const file = draftsFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(drafts));
  } catch {
    // Storage unavailable — drafts just won't survive a restart.
  }
}
