/**
 * Per-user volume helpers (participant-volume.ts) — clamp, default detection, and
 * the untrusted-blob normalizer that both platforms share for persistence.
 */

import { describe, expect, it } from "vitest";
import {
  clampParticipantVolume,
  DEFAULT_PARTICIPANT_VOLUME,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  isDefaultParticipantVolume,
  MAX_PARTICIPANT_VOLUME,
  MIN_PARTICIPANT_VOLUME,
  normalizeParticipantVolumes,
  PARTICIPANT_VOLUME_STORAGE_KEY,
} from "../index.js";

describe("clampParticipantVolume", () => {
  it("keeps in-range values untouched", () => {
    expect(clampParticipantVolume(0)).toBe(0);
    expect(clampParticipantVolume(0.5)).toBe(0.5);
    expect(clampParticipantVolume(1)).toBe(1);
    expect(clampParticipantVolume(2)).toBe(2);
  });

  it("clamps below 0 and above 2 to the range bounds", () => {
    expect(clampParticipantVolume(-1)).toBe(MIN_PARTICIPANT_VOLUME);
    expect(clampParticipantVolume(5)).toBe(MAX_PARTICIPANT_VOLUME);
  });

  it("falls back to the 100% default for non-finite input", () => {
    expect(clampParticipantVolume(Number.NaN)).toBe(DEFAULT_PARTICIPANT_VOLUME);
    expect(clampParticipantVolume(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PARTICIPANT_VOLUME);
  });
});

describe("isDefaultParticipantVolume", () => {
  it("is true only near 100%", () => {
    expect(isDefaultParticipantVolume(1)).toBe(true);
    expect(isDefaultParticipantVolume(0.9)).toBe(false);
    expect(isDefaultParticipantVolume(2)).toBe(false);
  });
});

describe("normalizeParticipantVolumes", () => {
  it("keeps valid non-default entries, clamped", () => {
    expect(normalizeParticipantVolumes({ a: 0.5, b: 2, c: 3 })).toEqual({
      a: 0.5,
      b: 2,
      c: 2, // clamped from 3
    });
  });

  it("drops default (100%) entries so storage never accumulates redundant 1s", () => {
    expect(normalizeParticipantVolumes({ a: 1, b: 0.25 })).toEqual({ b: 0.25 });
  });

  it("drops non-number / non-finite / empty-key entries and survives junk", () => {
    expect(
      normalizeParticipantVolumes({
        a: "loud",
        b: Number.NaN,
        "": 0.5,
        c: 0.25,
      }),
    ).toEqual({ c: 0.25 });
    expect(normalizeParticipantVolumes(null)).toEqual({});
    expect(normalizeParticipantVolumes("nope")).toEqual({});
    expect(normalizeParticipantVolumes(undefined)).toEqual({});
  });

  it("drops a persisted MUTE (0) so it never silently survives a restart", () => {
    // The founder's live incident: a test-drag to 0 persisted and silently
    // muted a friend on the next launch. 0 is session-only now.
    expect(normalizeParticipantVolumes({ muted: 0, low: 0.1 })).toEqual({ low: 0.1 });
  });

  it("round-trips a normalized map unchanged (persistence contract)", () => {
    const map = { u1: 0.5, u2: 1.75 };
    expect(normalizeParticipantVolumes(map)).toEqual(map);
  });

  it("exposes a stable shared storage key for both platforms", () => {
    expect(PARTICIPANT_VOLUME_STORAGE_KEY).toBe("demli.participant-volumes");
  });
});

describe("platform playback ceiling", () => {
  it("element playback (desktop + web) tops out at 100%, native at 200%", () => {
    expect(ELEMENT_PLAYBACK_MAX_VOLUME).toBe(1);
    expect(MAX_PARTICIPANT_VOLUME).toBe(2);
  });

  it("clamps to the given ceiling", () => {
    expect(clampParticipantVolume(1.6, ELEMENT_PLAYBACK_MAX_VOLUME)).toBe(1);
    expect(clampParticipantVolume(0.6, ELEMENT_PLAYBACK_MAX_VOLUME)).toBe(0.6);
    expect(clampParticipantVolume(1.6)).toBe(1.6);
  });

  it("a stored boost normalizes to 100% under the element ceiling and is pruned", () => {
    expect(
      normalizeParticipantVolumes({ a: 1.5, b: 0.4 }, ELEMENT_PLAYBACK_MAX_VOLUME),
    ).toEqual({ b: 0.4 });
    expect(normalizeParticipantVolumes({ a: 1.5, b: 0.4 })).toEqual({ a: 1.5, b: 0.4 });
  });
});
