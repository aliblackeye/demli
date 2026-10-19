import { describe, expect, it } from "vitest";
import type { ChannelId } from "@demli/types";
import { createVoiceAnnouncer } from "../voice-announcer.js";

const LOBBY = "lobby" as ChannelId;
const GROUP_VOICE = "group-voice" as ChannelId;

/** A manual clock: timers fire only when the test advances it. */
function harness(delays: number[] = [100, 200, 400]) {
  const frames: string[] = [];
  let desired: ChannelId | null = null;
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const announcer = createVoiceAnnouncer({
    join: (id) => frames.push(`join:${id}`),
    leave: (id) => frames.push(`leave:${id}`),
    desired: () => desired,
    retryDelaysMs: delays,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
  });
  return {
    announcer,
    frames,
    setDesired(id: ChannelId | null) {
      desired = id;
      announcer.sync();
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.fn();
        }
      }
    },
    pendingTimers: () => timers.filter((t) => t.live).length,
  };
}

describe("createVoiceAnnouncer", () => {
  it("announces room changes once and is a no-op on unchanged ticks", () => {
    const h = harness();
    h.setDesired(LOBBY);
    h.announcer.sync();
    h.announcer.sync();
    h.setDesired(GROUP_VOICE);
    h.setDesired(null);
    expect(h.frames).toEqual([
      "join:lobby",
      "leave:lobby",
      "join:group-voice",
      "leave:group-voice",
    ]);
  });

  it("retries a refused join after a backoff instead of giving up until reconnect", () => {
    const h = harness();
    h.setDesired(GROUP_VOICE);
    expect(h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER")).toBe(true);
    expect(h.announcer.announced()).toBeNull();

    // Store ticks during the backoff must not re-send it in a tight loop.
    h.announcer.sync();
    h.announcer.sync();
    expect(h.frames).toEqual(["join:group-voice"]);

    h.advance(100);
    expect(h.frames).toEqual(["join:group-voice", "join:group-voice"]);
    expect(h.announcer.announced()).toBe(GROUP_VOICE);
  });

  it("backs off further on each refusal and stops after the last attempt", () => {
    const h = harness([100, 200]);
    h.setDesired(GROUP_VOICE);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.advance(100);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.advance(100);
    expect(h.frames).toHaveLength(2);
    h.advance(100);
    expect(h.frames).toHaveLength(3);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.advance(10_000);
    h.announcer.sync();
    expect(h.frames).toHaveLength(3);
    expect(h.pendingTimers()).toBe(0);
  });

  it("does not retry a refusal that waiting cannot fix", () => {
    const h = harness();
    h.setDesired(LOBBY);
    expect(h.announcer.refused(LOBBY, "INVALID_CHANNEL")).toBe(true);
    h.advance(10_000);
    h.announcer.sync();
    expect(h.frames).toEqual(["join:lobby"]);
  });

  it("ignores a refusal for a channel it did not announce", () => {
    const h = harness();
    h.setDesired(LOBBY);
    expect(h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER")).toBe(false);
    expect(h.announcer.announced()).toBe(LOBBY);
    expect(h.pendingTimers()).toBe(0);
  });

  it("moving to another room cancels the pending retry and announces the new room", () => {
    const h = harness();
    h.setDesired(GROUP_VOICE);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.setDesired(LOBBY);
    h.advance(10_000);
    expect(h.frames).toEqual(["join:group-voice", "join:lobby"]);
    expect(h.pendingTimers()).toBe(0);
  });

  it("a fresh socket re-announces even a room that was given up on", () => {
    const h = harness([100]);
    h.setDesired(GROUP_VOICE);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.advance(100);
    h.announcer.refused(GROUP_VOICE, "NOT_A_MEMBER");
    h.announcer.reset();
    expect(h.frames).toEqual(["join:group-voice", "join:group-voice", "join:group-voice"]);
    expect(h.announcer.announced()).toBe(GROUP_VOICE);
  });

  it("forget() drops the record without sending anything", () => {
    const h = harness();
    h.setDesired(LOBBY);
    h.announcer.forget();
    expect(h.announcer.announced()).toBeNull();
    expect(h.frames).toEqual(["join:lobby"]);
  });
});
