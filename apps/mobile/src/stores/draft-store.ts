/**
 * Reactive store for per-stream message drafts (M17 — unsent messages).
 * Holds the draft map in memory (so the channel list can show a pencil on
 * streams with a draft) and mirrors every change to persistent storage via the
 * platform's ../lib/draft-storage seam (desktop: localStorage; mobile: a JSON file
 * through expo-file-system). This store file is shared VERBATIM across desktop and
 * mobile — only the draft-storage module behind it differs per platform.
 *
 * Write path (CLAUDE.md §27 — no storage write per keystroke):
 *  - the composer calls {@link DraftState.setDraft} on every keystroke, but that only
 *    updates a module-level `pending` and (re)arms a {@link DRAFT_COMMIT_DEBOUNCE_MS}
 *    timer — NO React `set` and NO storage write happen per keystroke;
 *  - the timer's `commit` is the ONLY place we touch the store + storage, so both the
 *    list re-render and the localStorage write are naturally throttled;
 *  - `flush()` forces a pending commit when the composer leaves/unmounts a channel, so
 *    the just-typed text is saved before the next channel loads;
 *  - `clearDraft()` (on send) drops the entry immediately and cancels any pending write.
 *
 * The pure map math (cap, empty-prune, LRU, sanitize) lives in ./draft-model.ts and is
 * shared verbatim with mobile.
 */

import { create } from "zustand";
import { loadDrafts, saveDrafts } from "../lib/draft-storage";
import { clearDraftInMap, setDraftInMap, type DraftMap } from "./draft-model";

/** Idle window after the last keystroke before a draft is committed + persisted. */
const DRAFT_COMMIT_DEBOUNCE_MS = 500;

interface DraftState {
  /** streamId → draft; only non-empty drafts are present. */
  drafts: DraftMap;
  /** Debounced: remember `text` for `streamId` and (re)arm the commit timer. */
  setDraft: (streamId: string, text: string) => void;
  /** Immediately drop a stream's draft (on send) and cancel a matching pending write. */
  clearDraft: (streamId: string) => void;
  /** Commit any pending debounced write now (on channel leave / composer unmount). */
  flush: () => void;
}

// Debounce state is module-level (one composer is active at a time). `pending` always
// belongs to the active stream, so `flush` commits exactly the stream being left.
let pending: { streamId: string; text: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useDraftStore = create<DraftState>((set, get) => {
  const commit = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const { streamId, text } = pending;
    pending = null;
    const next = setDraftInMap(get().drafts, streamId, text, Date.now());
    if (next === get().drafts) return; // no-op edit — skip the store + storage write
    set({ drafts: next });
    saveDrafts(next);
  };

  return {
    drafts: loadDrafts(),

    setDraft: (streamId, text) => {
      // If a pending write belongs to a DIFFERENT stream, commit it now before we
      // overwrite `pending` — otherwise switching composers within the debounce
      // window would drop the previous stream's just-typed tail. (On desktop the
      // composer flushes on channel change so this rarely fires; on mobile the
      // previous channel's composer can stay mounted underneath, so it matters.)
      if (pending && pending.streamId !== streamId) commit();
      pending = { streamId, text };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(commit, DRAFT_COMMIT_DEBOUNCE_MS);
    },

    clearDraft: (streamId) => {
      if (pending && pending.streamId === streamId) {
        pending = null;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      const next = clearDraftInMap(get().drafts, streamId);
      if (next === get().drafts) return;
      set({ drafts: next });
      saveDrafts(next);
    },

    flush: () => commit(),
  };
});
