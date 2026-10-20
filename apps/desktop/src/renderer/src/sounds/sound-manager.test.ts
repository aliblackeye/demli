import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cue arbiter + message-switch gating. `HTMLAudioElement` is stubbed (node env):
 * every `play()` is recorded by the element's src, so the test asserts which cue
 * actually reached the speaker.
 */
const played: string[] = [];

class FakeAudio {
  preload = "";
  volume = 1;
  currentTime = 0;
  constructor(public src: string) {}
  play(): Promise<void> {
    played.push(this.src);
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
  played.length = 0;
  vi.stubGlobal("Audio", FakeAudio);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load() {
  const mgr = await import("./sound-manager");
  const { useSoundSettings } = await import("./sound-settings");
  return { ...mgr, useSoundSettings };
}

const lastFile = () => played.at(-1)?.split("/").at(-1) ?? "";

describe("sound-manager arbiter", () => {
  it("drops call-ended right after peer-left-call (a peer hang-up is one cue)", async () => {
    const { playSound } = await load();
    playSound("peer-left-call");
    vi.advanceTimersByTime(600);
    playSound("call-ended");
    expect(played).toHaveLength(1);
    expect(lastFile()).toContain("peer-left-call");
  });

  it("plays call-ended on its own once the window has passed", async () => {
    const { playSound } = await load();
    playSound("peer-left-call");
    vi.advanceTimersByTime(3000);
    playSound("call-ended");
    expect(played).toHaveLength(2);
    expect(lastFile()).toContain("call-ended");
  });

  it("one gesture, one cue: unmute right after undeafen is dropped", async () => {
    const { playSound } = await load();
    playSound("undeafen");
    vi.advanceTimersByTime(50);
    playSound("unmute");
    expect(played).toHaveLength(1);
  });

  it("collapses a burst of errors into one cue", async () => {
    const { playSound } = await load();
    playSound("error");
    vi.advanceTimersByTime(500);
    playSound("error");
    expect(played).toHaveLength(1);
    vi.advanceTimersByTime(1600);
    playSound("error");
    expect(played).toHaveLength(2);
  });

  it("the message switch silences mentions too", async () => {
    const { playSound, useSoundSettings } = await load();
    useSoundSettings.getState().setMessageEnabled(false);
    playSound("mention");
    playSound("message");
    expect(played).toHaveLength(0);
    playSound("call-connected");
    expect(played).toHaveLength(1);
  });
});
