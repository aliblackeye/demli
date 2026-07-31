import { describe, expect, it } from "vitest";
import {
  createActiveSpeakerTracker,
  DEFAULT_ACTIVE_SPEAKER_ATTACK_MS,
  DEFAULT_ACTIVE_SPEAKER_RELEASE_MS,
  EMPTY_ACTIVE_SPEAKERS,
  pickSpeakingSubject,
} from "../active-speaker.js";

/** Fake-clock helper: everyone quiet except the listed identities. */
function room(identities: string[], talking: string[] = []) {
  return identities.map((identity) => ({ identity, speaking: talking.includes(identity) }));
}

describe("createActiveSpeakerTracker — attack hysteresis", () => {
  it("does not commit a speaker before attackMs of sustained speech", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["a"]), 1000);
    expect(tracker.snapshot.speaking).toEqual([]);
    expect(tracker.snapshot.primary).toBeNull();

    // 299 ms in — still not the subject (a cough must not steal the stage).
    const nearly = tracker.tick(1000 + DEFAULT_ACTIVE_SPEAKER_ATTACK_MS - 1);
    expect(nearly.speaking).toEqual([]);

    const committed = tracker.tick(1000 + DEFAULT_ACTIVE_SPEAKER_ATTACK_MS);
    expect(committed.speaking).toEqual(["a"]);
    expect(committed.recent).toEqual(["a"]);
    expect(committed.primary).toBe("a");
  });

  it("drops a sub-attack blip entirely (single syllable never wins)", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["a"]), 0);
    tracker.push(room(["a", "b"], []), 200); // quiet again after 200 ms
    const settled = tracker.tick(10_000);
    expect(settled.speaking).toEqual([]);
    expect(settled.recent).toEqual([]);
    expect(settled.lastSpeaker).toBeNull();
    expect(settled.primary).toBeNull();
  });

  it("reports a deadline for the pending attack and none once settled", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a"], ["a"]), 0);
    expect(tracker.nextDeadlineMs(0)).toBe(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS);
    expect(tracker.nextDeadlineMs(200)).toBe(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS - 200);
    // Overdue deadlines never go negative.
    expect(tracker.nextDeadlineMs(9999)).toBe(0);
    tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS);
    expect(tracker.nextDeadlineMs(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS)).toBeNull();
  });
});

describe("createActiveSpeakerTracker — release hysteresis", () => {
  it("keeps a speaker in `recent` through sentence gaps and releases after releaseMs", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["a"]), 0);
    tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS);
    tracker.push(room(["a", "b"], []), 1000); // pause between sentences

    const gap = tracker.tick(1000 + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS - 1);
    expect(gap.speaking).toEqual([]); // not talking right now
    expect(gap.recent).toEqual(["a"]); // but still on the strip
    expect(gap.primary).toBe("a");

    const released = tracker.tick(1000 + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS);
    expect(released.recent).toEqual([]);
    // Memory survives the release — this is what stops "fall back to list item 0".
    expect(released.lastSpeaker).toBe("a");
    expect(released.primary).toBe("a");
  });

  it("cancels a pending release when the speaker resumes", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a"], ["a"]), 0);
    tracker.tick(DEFAULT_ACTIVE_SPEAKER_ATTACK_MS);
    tracker.push(room(["a"], []), 1000);
    tracker.push(room(["a"], ["a"]), 2000); // resumed well inside the release window
    const later = tracker.tick(1000 + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS + 1);
    expect(later.speaking).toEqual(["a"]);
    expect(later.recent).toEqual(["a"]);
  });
});

describe("createActiveSpeakerTracker — ordering, ceiling, membership", () => {
  it("orders recency-first: the newest talker leads", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["a"]), 0);
    tracker.tick(400);
    tracker.push(room(["a", "b"], ["a", "b"]), 1000);
    const both = tracker.tick(1400);
    expect(both.speaking).toEqual(["a", "b"]);

    // `a` stops, `b` keeps going → b becomes the fresher entry and leads.
    tracker.push(room(["a", "b"], ["b"]), 2000);
    const after = tracker.tick(2100);
    expect(after.speaking).toEqual(["b"]);
    expect(after.recent).toEqual(["b", "a"]);
    expect(after.primary).toBe("b");
    expect(after.lastSpeaker).toBe("b");
  });

  it("caps `recent` at maxRecent while `speaking` stays complete", () => {
    const tracker = createActiveSpeakerTracker({ maxRecent: 2 });
    const everyone = ["a", "b", "c"];
    tracker.push(room(everyone, everyone), 0);
    const snap = tracker.tick(400);
    expect(snap.speaking).toEqual(["a", "b", "c"]);
    expect(snap.recent).toEqual(["a", "b"]);
  });

  it("forgets a participant who leaves the room, including as lastSpeaker", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["a"]), 0);
    tracker.tick(400);
    expect(tracker.snapshot.lastSpeaker).toBe("a");

    const afterLeave = tracker.push(room(["b"], []), 500);
    expect(afterLeave.speaking).toEqual([]);
    expect(afterLeave.recent).toEqual([]);
    expect(afterLeave.lastSpeaker).toBeNull();
    expect(afterLeave.primary).toBeNull();
  });

  it("returns a referentially stable snapshot across no-op ticks (§27)", () => {
    const tracker = createActiveSpeakerTracker();
    const first = tracker.push(room(["a", "b"], ["a"]), 0);
    expect(first).toBe(EMPTY_ACTIVE_SPEAKERS);
    const committed = tracker.tick(400);
    expect(committed).not.toBe(first);
    expect(tracker.tick(500)).toBe(committed);
    expect(tracker.push(room(["a", "b"], ["a"]), 600)).toBe(committed);
  });

  it("reset() returns to the empty snapshot", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a"], ["a"]), 0);
    tracker.tick(400);
    tracker.reset();
    expect(tracker.snapshot).toBe(EMPTY_ACTIVE_SPEAKERS);
    expect(tracker.nextDeadlineMs(0)).toBeNull();
  });
});

describe("pickSpeakingSubject", () => {
  const cameras = [{ identity: "a" }, { identity: "b" }];

  it("prefers the talking candidate over list order", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["b"]), 0);
    tracker.tick(400);
    expect(pickSpeakingSubject(cameras, tracker.snapshot)).toEqual({ identity: "b" });
  });

  it("falls back to the remembered last speaker in a silent room", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["a", "b"], ["b"]), 0);
    tracker.tick(400);
    tracker.push(room(["a", "b"], []), 500);
    const silent = tracker.tick(500 + DEFAULT_ACTIVE_SPEAKER_RELEASE_MS);
    expect(silent.speaking).toEqual([]);
    expect(pickSpeakingSubject(cameras, silent)).toEqual({ identity: "b" });
  });

  it("returns null when no candidate matches, so the caller's fallback runs", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["c"], ["c"]), 0);
    tracker.tick(400);
    // `c` is talking but has no camera → the PiP falls through to its own chain.
    expect(pickSpeakingSubject(cameras, tracker.snapshot)).toBeNull();
    expect(pickSpeakingSubject([], tracker.snapshot)).toBeNull();
  });

  it("skips a talker with no candidate and takes the next one that has", () => {
    const tracker = createActiveSpeakerTracker();
    tracker.push(room(["c", "a"], ["c", "a"]), 0);
    const snap = tracker.tick(400);
    expect(snap.speaking).toEqual(["c", "a"]);
    expect(pickSpeakingSubject(cameras, snap)).toEqual({ identity: "a" });
  });
});
