import { describe, expect, it } from "vitest";
import { createCueGate } from "../cue-gate.js";

describe("createCueGate", () => {
  it("throttles the same cue inside 100 ms, admits it after", () => {
    const gate = createCueGate();
    expect(gate.admit("message", 0)).toBe(true);
    expect(gate.admit("message", 50)).toBe(false);
    expect(gate.admit("message", 150)).toBe(true);
  });

  it("drops call-ended right after peer-left-call — a peer hang-up is one cue", () => {
    const gate = createCueGate();
    expect(gate.admit("peer-left-call", 0)).toBe(true);
    expect(gate.admit("call-ended", 600)).toBe(false);
  });

  it("admits call-ended on its own (we hung up) and once the window passed", () => {
    expect(createCueGate().admit("call-ended", 0)).toBe(true);
    const gate = createCueGate();
    gate.admit("peer-left-call", 0);
    expect(gate.admit("call-ended", 3000)).toBe(true);
  });

  it("one gesture, one cue: unmute after undeafen and mute after deafen are dropped", () => {
    const gate = createCueGate();
    gate.admit("undeafen", 0);
    expect(gate.admit("unmute", 30)).toBe(false);
    gate.admit("deafen", 1000);
    expect(gate.admit("mute", 1030)).toBe(false);
    expect(gate.admit("mute", 2000)).toBe(true);
  });

  it("collapses an error burst into one cue", () => {
    const gate = createCueGate();
    expect(gate.admit("error", 0)).toBe(true);
    expect(gate.admit("error", 500)).toBe(false);
    expect(gate.admit("error", 1600)).toBe(true);
  });

  it("a suppressed cue is NOT recorded, so it cannot suppress others", () => {
    const gate = createCueGate({
      b: { after: ["a"], windowMs: 1000 },
      c: { after: ["b"], windowMs: 1000 },
    });
    gate.admit("a", 0);
    expect(gate.admit("b", 10)).toBe(false);
    expect(gate.admit("c", 20)).toBe(true);
  });
});
