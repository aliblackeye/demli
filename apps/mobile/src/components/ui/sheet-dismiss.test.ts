import { describe, expect, it } from "vitest";
import { createDismissController } from "./sheet-dismiss";

/** A caller whose `onClose` decides; frames are flushed by hand. */
function harness(decide: (state: { visible: boolean }) => void) {
  const state = { visible: true };
  const springBacks: number[] = [];
  const frames: Array<() => void> = [];
  let closes = 0;
  const c = createDismissController({
    close: () => {
      closes += 1;
      decide(state);
    },
    isVisible: () => state.visible,
    springBack: (v) => springBacks.push(v),
    later: (fn) => frames.push(fn),
  });
  const flushFrames = () => frames.splice(0).forEach((fn) => fn());
  return { c, state, springBacks, flushFrames, closes: () => closes };
}

describe("sheet dismissal handshake", () => {
  it("a caller that closes gets the release velocity for the exit, and no spring back", () => {
    const h = harness((s) => {
      s.visible = false;
    });
    h.c.request(2100);
    expect(h.closes()).toBe(1);
    // The commit with visible=false: the exit effect runs first and takes it.
    expect(h.c.takeExitVelocity()).toBe(2100);
    h.c.afterCommit(false);
    h.flushFrames();
    expect(h.springBacks).toEqual([]);
    expect(h.c.pending).toBe(false);
  });

  it("a caller that declines (member menu editor → menu) springs back on its next commit, with the velocity", () => {
    const h = harness(() => {
      /* setMode("menu") — visible stays true */
    });
    h.c.request(1800);
    expect(h.springBacks).toEqual([]); // nothing moves before the answer
    h.c.afterCommit(true);
    expect(h.springBacks).toEqual([1800]);
    // The frame fallback must not spring it a second time.
    h.flushFrames();
    expect(h.springBacks).toEqual([1800]);
  });

  it("an onClose that commits nothing still returns the card after the frame fallback", () => {
    const h = harness(() => {});
    h.c.request(900);
    expect(h.c.pending).toBe(true);
    h.flushFrames();
    expect(h.springBacks).toEqual([900]);
    expect(h.c.pending).toBe(false);
  });

  it("a scrim tap / back press carries no velocity: standard exit, or a rest spring when declined", () => {
    const closing = harness((s) => {
      s.visible = false;
    });
    closing.c.request(null);
    expect(closing.c.takeExitVelocity()).toBeNull();

    const declining = harness(() => {});
    declining.c.request(null);
    declining.c.afterCommit(true);
    expect(declining.springBacks).toEqual([0]);
  });

  it("commits with no request pending do nothing", () => {
    const h = harness(() => {});
    h.c.afterCommit(true);
    h.c.afterCommit(false);
    expect(h.springBacks).toEqual([]);
    expect(h.c.takeExitVelocity()).toBeNull();
  });
});
