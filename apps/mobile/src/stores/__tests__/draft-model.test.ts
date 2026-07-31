/**
 * Unit tests for the pure per-stream draft reducers (M17). This module is the
 * platform-agnostic core of the draft store and is byte-identical on desktop and
 * mobile, so these tests cover BOTH platforms' draft logic. No native modules are
 * touched (the file/localStorage seam lives in draft-storage), so this runs in the
 * plain node test env.
 *
 * Invariants proven here: 4k per-draft cap, empty/whitespace prune, no-op identity
 * bail-outs, 100-record LRU eviction, and untrusted-blob sanitization.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_RECORDS,
  clearDraftInMap,
  getDraftText,
  hasDraft,
  sanitizeDraftMap,
  setDraftInMap,
  type DraftMap,
} from "../draft-model";

describe("draft-model: caps mirror the product spec", () => {
  it("caps a draft at 4000 chars and remembers 100 streams", () => {
    expect(MAX_DRAFT_LENGTH).toBe(4000);
    expect(MAX_DRAFT_RECORDS).toBe(100);
  });
});

describe("hasDraft / getDraftText", () => {
  it("reports presence only for a non-empty draft", () => {
    const map: DraftMap = { a: { text: "hi", updatedAt: 1 }, b: { text: "", updatedAt: 1 } };
    expect(hasDraft(map, "a")).toBe(true);
    expect(hasDraft(map, "b")).toBe(false); // empty text is not a draft
    expect(hasDraft(map, "missing")).toBe(false);
  });

  it("returns the saved text or an empty string", () => {
    const map: DraftMap = { a: { text: "hello", updatedAt: 1 } };
    expect(getDraftText(map, "a")).toBe("hello");
    expect(getDraftText(map, "missing")).toBe("");
  });
});

describe("setDraftInMap", () => {
  it("inserts a new draft with the injected timestamp", () => {
    const next = setDraftInMap({}, "c1", "hello", 100);
    expect(next).toEqual({ c1: { text: "hello", updatedAt: 100 } });
  });

  it("updates an existing draft and bumps updatedAt", () => {
    const map: DraftMap = { c1: { text: "hi", updatedAt: 1 } };
    const next = setDraftInMap(map, "c1", "hi there", 500);
    expect(next.c1).toEqual({ text: "hi there", updatedAt: 500 });
    expect(next).not.toBe(map); // new reference on a real change
  });

  it("removes a draft when the text becomes whitespace-only", () => {
    const map: DraftMap = { c1: { text: "hi", updatedAt: 1 } };
    const next = setDraftInMap(map, "c1", "   \n\t ", 200);
    expect(next).toEqual({});
    expect(next).not.toBe(map);
  });

  it("keeps identity when emptying a stream that has no draft", () => {
    const map: DraftMap = {};
    expect(setDraftInMap(map, "x", "  ", 1)).toBe(map); // nothing to remove
  });

  it("keeps identity on a no-op edit (same text)", () => {
    const map: DraftMap = { c1: { text: "hi", updatedAt: 1 } };
    expect(setDraftInMap(map, "c1", "hi", 999)).toBe(map);
  });

  it("caps an over-long draft at MAX_DRAFT_LENGTH", () => {
    const long = "a".repeat(MAX_DRAFT_LENGTH + 50);
    const next = setDraftInMap({}, "c1", long, 1);
    expect(next.c1?.text.length).toBe(MAX_DRAFT_LENGTH);
  });

  it("evicts the oldest draft once past the 100-record cap (LRU by updatedAt)", () => {
    let map: DraftMap = {};
    for (let i = 0; i < MAX_DRAFT_RECORDS; i++) {
      map = setDraftInMap(map, `c${i}`, `draft ${i}`, i); // c0 is the oldest (updatedAt 0)
    }
    expect(Object.keys(map)).toHaveLength(MAX_DRAFT_RECORDS);

    const next = setDraftInMap(map, "newest", "brand new", 10_000);
    expect(Object.keys(next)).toHaveLength(MAX_DRAFT_RECORDS); // still capped
    expect(next.c0).toBeUndefined(); // oldest evicted
    expect(next.newest).toBeDefined(); // newest kept
    expect(next.c99).toBeDefined();
  });
});

describe("clearDraftInMap", () => {
  it("drops a stream's draft", () => {
    const map: DraftMap = { c1: { text: "hi", updatedAt: 1 }, c2: { text: "yo", updatedAt: 2 } };
    const next = clearDraftInMap(map, "c1");
    expect(next).toEqual({ c2: { text: "yo", updatedAt: 2 } });
    expect(next).not.toBe(map);
  });

  it("keeps identity when clearing an absent stream", () => {
    const map: DraftMap = { c1: { text: "hi", updatedAt: 1 } };
    expect(clearDraftInMap(map, "missing")).toBe(map);
  });
});

describe("sanitizeDraftMap (untrusted persisted blob)", () => {
  it("degrades a non-object blob to an empty map", () => {
    expect(sanitizeDraftMap(null, 1)).toEqual({});
    expect(sanitizeDraftMap("nope", 1)).toEqual({});
    expect(sanitizeDraftMap(42, 1)).toEqual({});
    expect(sanitizeDraftMap(undefined, 1)).toEqual({});
  });

  it("keeps valid entries and drops malformed / empty ones", () => {
    const raw = {
      good: { text: "keep me", updatedAt: 5 },
      badText: { text: 123 },
      emptyText: { text: "   " },
      notObject: "string",
      nullish: null,
    };
    const out = sanitizeDraftMap(raw, 999);
    expect(Object.keys(out)).toEqual(["good"]);
    expect(out.good).toEqual({ text: "keep me", updatedAt: 5 });
  });

  it("caps text length and backfills a missing/invalid updatedAt with now", () => {
    const raw = {
      a: { text: "b".repeat(MAX_DRAFT_LENGTH + 10), updatedAt: "not-a-number" },
      c: { text: "hi" }, // no updatedAt
    };
    const out = sanitizeDraftMap(raw, 777);
    expect(out.a?.text.length).toBe(MAX_DRAFT_LENGTH);
    expect(out.a?.updatedAt).toBe(777);
    expect(out.c?.updatedAt).toBe(777);
  });

  it("applies the record cap to an oversized blob, keeping the newest", () => {
    const raw: Record<string, { text: string; updatedAt: number }> = {};
    for (let i = 0; i < MAX_DRAFT_RECORDS + 5; i++) {
      raw[`c${i}`] = { text: `draft ${i}`, updatedAt: i };
    }
    const out = sanitizeDraftMap(raw, 1);
    expect(Object.keys(out)).toHaveLength(MAX_DRAFT_RECORDS);
    expect(out.c0).toBeUndefined(); // oldest trimmed
    expect(out[`c${MAX_DRAFT_RECORDS + 4}`]).toBeDefined(); // newest kept
  });
});
