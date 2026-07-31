/**
 * The tray bridge is only allowed to fire on a real CHANGE. Both of its sources
 * tick constantly — the chat store on every message/presence update, the voice
 * store on every speaking and connection-quality tick of a live call — so an
 * un-deduped push would be a native tray repaint per tick (CLAUDE.md §27).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTraySync, type TraySyncTarget, type TrayVoiceStatus } from "./tray-sync";

function spyTarget(): TraySyncTarget & {
  setUnreadBadge: ReturnType<typeof vi.fn>;
  setVoiceStatus: ReturnType<typeof vi.fn>;
} {
  return {
    setUnreadBadge: vi.fn(async () => undefined),
    setVoiceStatus: vi.fn(async () => undefined),
  };
}

const voice = (overrides: Partial<TrayVoiceStatus> = {}): TrayVoiceStatus => ({
  inVoiceSession: true,
  micEnabled: true,
  deafened: false,
  ...overrides,
});

describe("pushUnread", () => {
  let target: ReturnType<typeof spyTarget>;
  let sync: ReturnType<typeof createTraySync>;

  beforeEach(() => {
    target = spyTarget();
    sync = createTraySync(() => target);
  });

  it("sends the first value even when it is the neutral one", () => {
    // Main may still be showing a previous session's tray, so the first report
    // is not assumed to match.
    sync.pushUnread(false);
    expect(target.setUnreadBadge).toHaveBeenCalledTimes(1);
    expect(target.setUnreadBadge).toHaveBeenCalledWith(false);
  });

  it("does NOT send when the value is unchanged", () => {
    sync.pushUnread(true);
    sync.pushUnread(true);
    sync.pushUnread(true);
    expect(target.setUnreadBadge).toHaveBeenCalledTimes(1);
  });

  it("sends on every real transition", () => {
    sync.pushUnread(true);
    sync.pushUnread(false);
    sync.pushUnread(true);
    expect(target.setUnreadBadge).toHaveBeenCalledTimes(3);
    expect(target.setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe("pushVoice", () => {
  let target: ReturnType<typeof spyTarget>;
  let sync: ReturnType<typeof createTraySync>;

  beforeEach(() => {
    target = spyTarget();
    sync = createTraySync(() => target);
  });

  it("does NOT send when every field matches, even from a new object", () => {
    sync.pushVoice(voice());
    sync.pushVoice(voice());
    sync.pushVoice({ inVoiceSession: true, micEnabled: true, deafened: false });
    expect(target.setVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it("sends when the mic is muted", () => {
    sync.pushVoice(voice());
    sync.pushVoice(voice({ micEnabled: false }));
    expect(target.setVoiceStatus).toHaveBeenCalledTimes(2);
    expect(target.setVoiceStatus).toHaveBeenLastCalledWith({
      inVoiceSession: true,
      micEnabled: false,
      deafened: false,
    });
  });

  it("sends when deafening flips", () => {
    sync.pushVoice(voice({ micEnabled: false }));
    sync.pushVoice(voice({ micEnabled: false, deafened: true }));
    expect(target.setVoiceStatus).toHaveBeenCalledTimes(2);
    expect(target.setVoiceStatus).toHaveBeenLastCalledWith({
      inVoiceSession: true,
      micEnabled: false,
      deafened: true,
    });
  });

  it("sends when the session ends", () => {
    sync.pushVoice(voice());
    sync.pushVoice(voice({ inVoiceSession: false }));
    expect(target.setVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("copies the payload so a mutated source cannot poison the comparison", () => {
    const live = voice();
    sync.pushVoice(live);
    // Simulate a store slice being mutated in place after we were handed it.
    live.micEnabled = false;
    sync.pushVoice(voice());
    expect(target.setVoiceStatus).toHaveBeenCalledTimes(1);
    expect(target.setVoiceStatus).toHaveBeenCalledWith({
      inVoiceSession: true,
      micEnabled: true,
      deafened: false,
    });
  });

  it("forwards only the three declared fields", () => {
    // Main's schema is strict; an extra key must not reach it.
    sync.pushVoice({ ...voice(), roomId: "abc" } as TrayVoiceStatus);
    expect(target.setVoiceStatus).toHaveBeenCalledWith({
      inVoiceSession: true,
      micEnabled: true,
      deafened: false,
    });
  });
});

describe("reset", () => {
  it("returns the tray to neutral and re-sends afterwards", () => {
    const target = spyTarget();
    const sync = createTraySync(() => target);

    sync.pushUnread(true);
    sync.pushVoice(voice({ micEnabled: false }));
    sync.reset();

    expect(target.setUnreadBadge).toHaveBeenLastCalledWith(false);
    expect(target.setVoiceStatus).toHaveBeenLastCalledWith({
      inVoiceSession: false,
      micEnabled: true,
      deafened: false,
    });

    // The memo is cleared too, so the next session's first report is not
    // swallowed as "unchanged".
    sync.pushUnread(false);
    expect(target.setUnreadBadge).toHaveBeenCalledTimes(3);
  });
});

describe("no bridge (web build)", () => {
  it("never throws and re-sends once a bridge appears", () => {
    let target: TraySyncTarget | null = null;
    const sync = createTraySync(() => target);

    expect(() => sync.pushUnread(true)).not.toThrow();
    expect(() => sync.pushVoice(voice())).not.toThrow();

    // Nothing was delivered, so nothing may be remembered as delivered.
    const real = spyTarget();
    target = real;
    sync.pushUnread(true);
    sync.pushVoice(voice());
    expect(real.setUnreadBadge).toHaveBeenCalledWith(true);
    expect(real.setVoiceStatus).toHaveBeenCalledTimes(1);
  });
});

describe("bridge failure", () => {
  it("swallows a rejected call instead of raising an unhandled rejection", async () => {
    const target: TraySyncTarget = {
      setUnreadBadge: vi.fn(async () => {
        throw new Error("system: invalid unread badge value");
      }),
      setVoiceStatus: vi.fn(async () => {
        throw new Error("system: invalid voice status payload");
      }),
    };
    const sync = createTraySync(() => target);

    expect(() => sync.pushUnread(true)).not.toThrow();
    expect(() => sync.pushVoice(voice())).not.toThrow();
    await Promise.resolve();
    expect(target.setUnreadBadge).toHaveBeenCalledTimes(1);
  });
});
