/**
 * Unit tests for the join-cue settle scheduler — the timing rule that fixes the
 * "join sound comes out broken" report. Pure logic (no native `expo-audio`), so
 * it runs in the mobile node-env vitest suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinCueScheduler } from "../join-cue-timing";

const DELAY = 350;

describe("join cue scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays the join cue only after the settle delay", () => {
    const play = vi.fn();
    const s = createJoinCueScheduler(play, DELAY);
    s.arm();
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DELAY - 1);
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("suppresses the cue when the user leaves before it settles (fast join->leave)", () => {
    const play = vi.fn();
    const s = createJoinCueScheduler(play, DELAY);
    s.arm();
    vi.advanceTimersByTime(100);
    s.cancel();
    vi.advanceTimersByTime(1_000);
    expect(play).not.toHaveBeenCalled();
  });

  it("re-arming (room switch) restarts the window and still fires exactly once", () => {
    const play = vi.fn();
    const s = createJoinCueScheduler(play, DELAY);
    s.arm();
    vi.advanceTimersByTime(200);
    s.arm(); // switched rooms: cancel the first, start a fresh settle window
    vi.advanceTimersByTime(DELAY - 1);
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("cancel is a no-op when nothing is armed", () => {
    const play = vi.fn();
    const s = createJoinCueScheduler(play, DELAY);
    expect(() => s.cancel()).not.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(play).not.toHaveBeenCalled();
  });
});
