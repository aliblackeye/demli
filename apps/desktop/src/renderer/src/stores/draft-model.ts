/**
 * Pure, platform-agnostic reducers for per-stream message drafts (M17 — unsent
 * messages: leave a channel mid-type and your text is waiting when you return).
 * A "stream" is anything with a composer: a text channel id, or a
 * DM / group-chat hidden stream id — the same key the composer already uses.
 *
 * This module is INTENTIONALLY free of React, zustand, and storage I/O so it can be
 * reasoned about and unit-tested in isolation. The desktop and mobile copies are
 * byte-identical on purpose (CLAUDE.md §30 — platform-local, same pattern); the only
 * per-platform difference lives in the store + storage wrappers around it.
 *
 * Invariants enforced here:
 *  - a draft is capped at {@link MAX_DRAFT_LENGTH} chars (the composer already limits
 *    input, so this only guards an untrusted persisted blob);
 *  - an empty / whitespace-only draft is REMOVED, never stored (CLAUDE.md M17 spec);
 *  - the map is bounded to {@link MAX_DRAFT_RECORDS} via an LRU drop of the oldest
 *    `updatedAt` so drafts can't grow without limit (CLAUDE.md §27).
 */

import { MESSAGE_MAX_LENGTH } from "@demli/config";

/** One saved draft: the raw composer text plus when it was last touched (LRU key). */
export type DraftEntry = { text: string; updatedAt: number };

/** streamId (channel / DM stream) → draft. Only non-empty drafts are ever present. */
export type DraftMap = Record<string, DraftEntry>;

/** Per-draft character cap — mirrors the composer's own input limit. */
export const MAX_DRAFT_LENGTH = MESSAGE_MAX_LENGTH;

/** Hard cap on how many streams we remember a draft for (LRU beyond this). */
export const MAX_DRAFT_RECORDS = 100;

/** True when the stream has a non-empty saved draft (drives the list pencil). */
export function hasDraft(map: DraftMap, streamId: string): boolean {
  const entry = map[streamId];
  return entry !== undefined && entry.text.length > 0;
}

/** The saved draft text for a stream, or "" when there is none. */
export function getDraftText(map: DraftMap, streamId: string): string {
  return map[streamId]?.text ?? "";
}

/**
 * Immutably upsert a stream's draft. Whitespace-only text removes the entry (an
 * emptied composer clears the draft). Returns the SAME reference when nothing
 * changed so a store `set` can bail out. `now` is injected for deterministic tests.
 */
export function setDraftInMap(
  map: DraftMap,
  streamId: string,
  text: string,
  now: number,
): DraftMap {
  const capped = text.length > MAX_DRAFT_LENGTH ? text.slice(0, MAX_DRAFT_LENGTH) : text;

  if (capped.trim().length === 0) {
    if (!(streamId in map)) return map; // nothing to remove — keep identity
    const next = { ...map };
    delete next[streamId];
    return next;
  }

  const existing = map[streamId];
  if (existing && existing.text === capped) return map; // no-op edit — keep identity

  const next: DraftMap = { ...map, [streamId]: { text: capped, updatedAt: now } };
  return enforceRecordCap(next);
}

/** Immutably drop a stream's draft (on send / explicit clear). */
export function clearDraftInMap(map: DraftMap, streamId: string): DraftMap {
  if (!(streamId in map)) return map;
  const next = { ...map };
  delete next[streamId];
  return next;
}

/** Drop oldest-by-`updatedAt` entries until the map is within the record cap. */
function enforceRecordCap(map: DraftMap): DraftMap {
  const ids = Object.keys(map);
  if (ids.length <= MAX_DRAFT_RECORDS) return map;
  ids.sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0));
  const next = { ...map };
  const dropCount = ids.length - MAX_DRAFT_RECORDS;
  for (let i = 0; i < dropCount; i++) {
    const id = ids[i];
    if (id !== undefined) delete next[id];
  }
  return next;
}

/**
 * Normalize an untrusted persisted blob into a valid {@link DraftMap}: keep only
 * `{ text: string; updatedAt: number }` entries, cap length, drop empties, and
 * apply the record cap. A corrupt/legacy blob degrades to `{}` rather than throwing.
 */
export function sanitizeDraftMap(raw: unknown, now: number): DraftMap {
  if (!raw || typeof raw !== "object") return {};
  const out: DraftMap = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const rec = val as { text?: unknown; updatedAt?: unknown };
    if (typeof rec.text !== "string") continue;
    const text = rec.text.length > MAX_DRAFT_LENGTH ? rec.text.slice(0, MAX_DRAFT_LENGTH) : rec.text;
    if (text.trim().length === 0) continue;
    const updatedAt =
      typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : now;
    out[id] = { text, updatedAt };
  }
  return enforceRecordCap(out);
}
