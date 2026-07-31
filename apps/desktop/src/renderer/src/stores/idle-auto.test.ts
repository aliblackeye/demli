/**
 * Automatic "boşta" presence.
 *
 * The bug this pins: inactivity used to be measured with `window` listeners, so
 * a user working in ANOTHER app went away after five minutes and could not come
 * back without clicking Demli. On desktop the measurement now comes from the main
 * process (OS-wide), while the browser keeps the DOM fallback — and a manual
 * status pick must survive both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// zustand's `persist` middleware grabs `window.localStorage` the moment
// self-presence-store is imported, and the desktop tests run in the `node`
// environment. Install one BEFORE the imports below (hoisted) — each test then
// swaps `globalThis.window` for its own surface, but the store already holds a
// working storage reference, so nothing warns.
vi.hoisted(() => {
  const cell = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => cell.get(k) ?? null,
      setItem: (k: string, v: string) => void cell.set(k, v),
      removeItem: (k: string) => void cell.delete(k),
      clear: () => cell.clear(),
      key: () => null,
      length: 0,
    },
  };
});

// self-presence-store only needs "who am I"; the real auth-store would drag in
// the api client, the account vault and the secure-token bridge.
vi.mock("./auth-store", () => ({
  useAuthStore: { getState: () => ({ user: { id: "u1" } }) },
}));

import {
  IDLE_THRESHOLD_MS,
  startIdleAutoPresence,
  stopIdleAutoPresence,
} from "./idle-auto";
import { useSelfPresenceStore } from "./self-presence-store";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface IdleStateLike {
  idle: boolean;
  reason: string | null;
}

/** Stand-in for `window.demli.systemIdle` (the main-process watcher). */
function fakeSystemIdle(options: { initialIdle?: boolean; failStart?: boolean } = {}) {
  const listeners = new Set<(state: IdleStateLike) => void>();
  const systemIdle = {
    start: vi.fn(async (_opts: { thresholdMs: number }): Promise<IdleStateLike> => {
      if (options.failStart) throw new Error("powerMonitor unavailable");
      return { idle: options.initialIdle === true, reason: null };
    }),
    stop: vi.fn(async (): Promise<void> => undefined),
    onChanged: vi.fn((listener: (state: IdleStateLike) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
  };
  return {
    systemIdle,
    /** Main pushed a transition. */
    emit(idle: boolean, reason: string | null = idle ? "inactivity" : null): void {
      for (const listener of [...listeners]) listener({ idle, reason });
    },
    subscriberCount: (): number => listeners.size,
  };
}

/** Install a `globalThis.window` for the surface under test. */
function installWindow(platform: string, systemIdle?: unknown) {
  const domListeners = new Map<string, Set<() => void>>();
  const win = {
    demli: {
      appInfo: { platform, version: "0.0.0" },
      ...(systemIdle ? { systemIdle } : {}),
    },
    addEventListener: vi.fn((type: string, fn: () => void) => {
      const set = domListeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      domListeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      domListeners.get(type)?.delete(fn);
    }),
    setInterval: (fn: () => void, ms: number): number =>
      globalThis.setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number): void => {
      globalThis.clearInterval(id as unknown as NodeJS.Timeout);
    },
  };
  (globalThis as unknown as { window: unknown }).window = win;
  return {
    win,
    fire(type: string): void {
      for (const fn of [...(domListeners.get(type) ?? [])]) fn();
    },
    domListenerCount(): number {
      let total = 0;
      for (const set of domListeners.values()) total += set.size;
      return total;
    },
  };
}

/** Let the `systemIdle.start()` promise chain settle (no timers involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

const autoAway = (): boolean => useSelfPresenceStore.getState().autoAway;

beforeEach(() => {
  vi.useFakeTimers();
  useSelfPresenceStore.setState({ statusByUser: {}, autoAway: false });
});

afterEach(() => {
  stopIdleAutoPresence();
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

// ---------------------------------------------------------------------------
// Desktop: the OS-wide watcher in the main process
// ---------------------------------------------------------------------------

describe("desktop — inactivity is measured by the main process", () => {
  it("arms the main-process watcher with the single shared threshold", async () => {
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(vi.fn());
    await flush();

    expect(idle.systemIdle.start).toHaveBeenCalledWith({
      thresholdMs: IDLE_THRESHOLD_MS,
    });
  });

  it("does NOT fall back to window activity when the watcher is available", async () => {
    const idle = fakeSystemIdle();
    const dom = installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(vi.fn());
    await flush();

    // The whole point of the fix: activity in OTHER apps must count, so this
    // surface must not be listening to its own window at all.
    expect(dom.domListenerCount()).toBe(0);
    expect(idle.subscriberCount()).toBe(1);
  });

  it("goes away when main reports the machine idle, and back on activity", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();
    expect(push).not.toHaveBeenCalled();

    idle.emit(true);
    expect(autoAway()).toBe(true);
    expect(push).toHaveBeenLastCalledWith("idle");

    idle.emit(false);
    expect(autoAway()).toBe(false);
    expect(push).toHaveBeenLastCalledWith("online");
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("applies an already-idle machine at sign-in time", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle({ initialIdle: true });
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();

    expect(autoAway()).toBe(true);
    expect(push).toHaveBeenCalledWith("idle");
  });

  it("does not re-broadcast while the state holds", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();

    idle.emit(true);
    idle.emit(true);
    idle.emit(true);
    expect(push).toHaveBeenCalledTimes(1);

    idle.emit(false);
    idle.emit(false);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("treats lock and sleep exactly like inactivity, and wakes back up", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();

    idle.emit(true, "locked");
    expect(autoAway()).toBe(true);
    expect(push).toHaveBeenLastCalledWith("idle");

    // Still away while it sleeps — one transition, not two.
    idle.emit(true, "suspended");
    expect(push).toHaveBeenCalledTimes(1);

    idle.emit(false);
    expect(autoAway()).toBe(false);
    expect(push).toHaveBeenLastCalledWith("online");
  });

  it("stops the watcher and unsubscribes on logout, clearing the away flag", async () => {
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(vi.fn());
    await flush();
    idle.emit(true);
    expect(autoAway()).toBe(true);

    stopIdleAutoPresence();

    expect(idle.systemIdle.stop).toHaveBeenCalled();
    expect(idle.subscriberCount()).toBe(0);
    expect(autoAway()).toBe(false);
  });

  it("ignores a watcher event that arrives after teardown", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();
    stopIdleAutoPresence();

    idle.emit(true);
    expect(autoAway()).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("re-arms cleanly on a second sign-in without leaving the old source running", async () => {
    const first = fakeSystemIdle();
    installWindow("win32", first.systemIdle);
    startIdleAutoPresence(vi.fn());
    await flush();

    const push = vi.fn();
    startIdleAutoPresence(push);
    await flush();

    expect(first.subscriberCount()).toBe(1); // exactly one, not two
    first.emit(true);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A manual pick always wins
// ---------------------------------------------------------------------------

describe("manual status choice is authoritative", () => {
  it("never overwrites a manual dnd with the automatic idle", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    useSelfPresenceStore.getState().setStatus("u1", "dnd");
    startIdleAutoPresence(push);
    await flush();

    idle.emit(true);

    expect(push).not.toHaveBeenCalled();
    // The live away flag is still tracked (it is only a modifier on "online"),
    // but nothing is broadcast over the user's own pick.
    expect(autoAway()).toBe(true);
  });

  it("never overwrites a manual invisible on the way back either", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    useSelfPresenceStore.getState().setStatus("u1", "invisible");
    startIdleAutoPresence(push);
    await flush();

    idle.emit(true);
    idle.emit(false);

    expect(push).not.toHaveBeenCalled();
  });

  it("restores the user's own choice on return, instead of forcing online", async () => {
    const push = vi.fn();
    const idle = fakeSystemIdle();
    installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();

    idle.emit(true);
    expect(push).toHaveBeenLastCalledWith("idle");

    // The user picks Do Not Disturb WHILE away (e.g. from their phone / the
    // status menu). Coming back must not drag them to "online".
    useSelfPresenceStore.getState().setStatus("u1", "dnd");
    idle.emit(false);

    expect(push).toHaveBeenCalledTimes(1);
    expect(autoAway()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Web fallback (no powerMonitor in a browser)
// ---------------------------------------------------------------------------

describe("web — the DOM fallback still works", () => {
  it("uses window activity when the surface is the browser", () => {
    const dom = installWindow("web");
    startIdleAutoPresence(vi.fn());

    expect(dom.domListenerCount()).toBeGreaterThan(0);
  });

  it("goes away after the threshold and returns on the first mouse move", () => {
    const push = vi.fn();
    const dom = installWindow("web");
    startIdleAutoPresence(push);

    vi.advanceTimersByTime(IDLE_THRESHOLD_MS - 60_000);
    expect(push).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120_000);
    expect(autoAway()).toBe(true);
    expect(push).toHaveBeenLastCalledWith("idle");

    dom.fire("mousemove");
    expect(autoAway()).toBe(false);
    expect(push).toHaveBeenLastCalledWith("online");
  });

  it("keeps the session online while the tab keeps seeing activity", () => {
    const push = vi.fn();
    const dom = installWindow("web");
    startIdleAutoPresence(push);

    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(60_000);
      dom.fire("keydown");
    }

    expect(push).not.toHaveBeenCalled();
    expect(autoAway()).toBe(false);
  });

  it("detaches its listeners and interval on logout", () => {
    const push = vi.fn();
    const dom = installWindow("web");
    startIdleAutoPresence(push);
    expect(dom.domListenerCount()).toBeGreaterThan(0);

    stopIdleAutoPresence();

    expect(dom.domListenerCount()).toBe(0);
    vi.advanceTimersByTime(IDLE_THRESHOLD_MS * 2);
    expect(push).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("degradation", () => {
  it("falls back to window activity when the main-process watcher cannot arm", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const push = vi.fn();
    const idle = fakeSystemIdle({ failStart: true });
    const dom = installWindow("win32", idle.systemIdle);
    startIdleAutoPresence(push);
    await flush();

    expect(warn).toHaveBeenCalled(); // degrading is reported, never silent
    warn.mockRestore();

    expect(dom.domListenerCount()).toBeGreaterThan(0);
    expect(idle.subscriberCount()).toBe(0); // the failed source let go

    vi.advanceTimersByTime(IDLE_THRESHOLD_MS + 60_000);
    expect(push).toHaveBeenLastCalledWith("idle");
  });

  it("falls back when the bridge exists but lacks the namespace (older shell)", () => {
    const dom = installWindow("win32", undefined);
    startIdleAutoPresence(vi.fn());

    expect(dom.domListenerCount()).toBeGreaterThan(0);
  });
});
