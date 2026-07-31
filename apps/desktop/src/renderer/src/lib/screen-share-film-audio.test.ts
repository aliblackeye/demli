/**
 * Regression tests for the FILM-AUDIO chain on the desktop publisher side —
 * the "yayın/film sesi gitmiyor" bug, reported three releases running.
 *
 * The proven root cause (measured on the founder's machine with the vendored
 * `ApplicationLoopback.exe`):
 *
 *  1. The helper emits NOTHING — not even silence padding — while the target
 *     process has no ACTIVE WASAPI render stream. `explorer.exe` → 0 bytes
 *     forever; a player that starts 5s late → 0 bytes, then full signal at 5.6s.
 *  2. So "0 bytes during the startup grace" means "the user has not pressed play
 *     YET" — the single most common way a share begins — NOT "this source is
 *     dead". The old code tore the capture down there, discarding the one
 *     definitionally-correct source, and fell through to a Voicemeeter endpoint
 *     loopback that is permanently silent on that box.
 *  3. It then published that silent track and reported success, so the panel
 *     said "sistem sesiyle paylaşıyorsun" while viewers heard nothing forever.
 *
 * These tests pin the fixed contract: a silent-but-alive capture is KEPT, a dead
 * one is rejected, and audibility is never claimed at acquisition time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DOM/Electron stubs (vitest runs these in the `node` environment)
// ---------------------------------------------------------------------------

class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  private listeners = new Set<() => void>();
  constructor(readonly kind: "video" | "audio" = "audio") {}
  addEventListener(type: string, l: () => void): void {
    if (type === "ended") this.listeners.add(l);
  }
  removeEventListener(type: string, l: () => void): void {
    this.listeners.delete(l);
  }
  stop(): void {
    this.stopped = true;
  }
}

/** Records what the process-audio bridge was asked to do. */
interface BridgeState {
  started: string[];
  stopped: number[];
  /** Emit a PCM chunk to the live listener (simulates the user pressing play). */
  emit: (captureId: number, bytes: number) => void;
  /** Simulate the helper process exiting (dead capture). */
  end: (captureId: number) => void;
}

function installGlobals(opts: {
  /** false → `processAudio.start` reports the capture impossible. */
  processStartOk?: boolean;
  /** Audio tracks getDisplayMedia should return (loopback tier). */
  displayAudio?: FakeTrack[];
}): BridgeState {
  const dataListeners = new Set<(p: { captureId: number; chunk: Uint8Array }) => void>();
  const endedListeners = new Set<(e: { captureId: number; reason: string }) => void>();
  const state: BridgeState = {
    started: [],
    stopped: [],
    emit: (captureId, bytes) => {
      for (const l of dataListeners) l({ captureId, chunk: new Uint8Array(bytes) });
    },
    end: (captureId) => {
      for (const l of endedListeners) l({ captureId, reason: "exit" });
    },
  };

  const audioCtx = {
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamDestination: () => ({
      stream: {
        getAudioTracks: () => [new FakeTrack("audio")],
        getTracks: () => [] as FakeTrack[],
      },
    }),
    createScriptProcessor: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }),
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createAnalyser: () => ({
      fftSize: 2048,
      connect: vi.fn(),
      getFloatTimeDomainData: (b: Float32Array) => b.fill(0),
    }),
  };

  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => audioCtx),
  );
  vi.stubGlobal("MediaStream", vi.fn(() => ({})));
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });

  const demli = {
    appInfo: { platform: "win32" },
    capture: {
      listSources: vi.fn(async () => [
        { id: "screen:0:0", name: "Screen 1", kind: "screen", thumbnailDataUrl: "" },
        { id: "window:123:0", name: "Player", kind: "window", thumbnailDataUrl: "" },
      ]),
      selectSource: vi.fn(async ({ audio }: { sourceId: string; audio: boolean }) => ({
        ok: true,
        sourceId: "window:123:0",
        audio: audio ? "loopback" : "none",
        loopbackSupported: true,
      })),
      clearSelection: vi.fn(async () => undefined),
    },
    processAudio: {
      start: vi.fn(async ({ sourceId }: { sourceId: string }) => {
        state.started.push(sourceId);
        return opts.processStartOk === false
          ? { ok: false, reason: "pid_unresolved" }
          : {
              ok: true,
              captureId: state.started.length,
              format: { sampleRate: 48000, channels: 2, bitDepth: 16 },
            };
      }),
      stop: vi.fn(async (id: number) => {
        state.stopped.push(id);
      }),
      onData: (l: (p: { captureId: number; chunk: Uint8Array }) => void) => {
        dataListeners.add(l);
        return () => dataListeners.delete(l);
      },
      onEnded: (l: (e: { captureId: number; reason: string }) => void) => {
        endedListeners.add(l);
        return () => endedListeners.delete(l);
      },
    },
  };

  vi.stubGlobal("window", { demli, localStorage: globalThis.localStorage });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getDisplayMedia: vi.fn(async () => ({
        getVideoTracks: () => [new FakeTrack("video")],
        getAudioTracks: () => opts.displayAudio ?? [],
        getTracks: () => [] as FakeTrack[],
      })),
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(async () => {
        throw new Error("no mix input");
      }),
    },
  });
  vi.stubGlobal("performance", { now: () => Date.now() });

  return state;
}

/**
 * Budget, not a guess. `acquireScreenShare` sits through REAL sleeps that belong
 * to production, not to the test: a 450 ms helper-startup grace plus a 200 ms
 * settle (screen-share.ts). ~700 ms of genuine waiting per case, and these cases
 * do not care about those delays — they assert what survives them.
 *
 * The default 5 s was 7x that and still timed out once in a full-workspace run
 * on a loaded machine: vitest counts transform/collect against the same clock,
 * and that run spent 144 s collecting. So the failure was starvation, not a slow
 * assertion — the test passes alone every time.
 *
 * 20 s keeps roughly 25x headroom over the real sleeps while staying far below
 * "a hung test looks like a slow one". If this ever times out again, something
 * genuinely stopped resolving; do not raise it further without finding out what.
 */
const FILM_AUDIO_TIMEOUT_MS = 20_000;

describe("desktop film-audio acquisition", { timeout: FILM_AUDIO_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("KEEPS a process capture that has produced no bytes yet (film not started)", async () => {
    // THE root-cause regression. The helper is alive but the shared app has not
    // played anything, so zero PCM has flowed. That is the normal "share first,
    // press play second" flow — the capture must be kept, because it starts
    // carrying audio the instant playback begins (measured: 0 bytes → signal at
    // 5.6s on the same capture).
    const bridge = installGlobals({});
    const { acquireScreenShare } = await import("./screen-share");

    const acquired = await acquireScreenShare("window:123:0", {
      quality: "1080p30",
      systemAudio: true,
    });

    expect(bridge.started).toEqual(["window:123:0"]);
    // The capture was NOT torn down...
    expect(bridge.stopped).toEqual([]);
    // ...and it is the published film-audio source.
    expect(acquired.filmAudioSource).toBe("process");
    expect(acquired.audio).not.toBeNull();
    expect(acquired.hasSystemAudio).toBe(true);
    // Acquisition never claims the sound is REACHING anyone — nothing has been
    // heard yet, and it is the supervisor's job to confirm that later.
    expect(acquired.systemAudioUnavailable).toBe(false);
  });

  it("rejects a process capture whose helper EXITED (genuinely dead → falls back)", async () => {
    // The one legitimately fatal case: bad PID / target closed / activation
    // refused. Here we must NOT keep the capture, so the endpoint ladder runs.
    const loopback = new FakeTrack("audio");
    const bridge = installGlobals({ displayAudio: [loopback] });
    const { acquireScreenShare } = await import("./screen-share");

    // End the helper as soon as it starts, before the grace elapses.
    const originalEmit = bridge.end;
    setTimeout(() => originalEmit(1), 10);

    const acquired = await acquireScreenShare("window:123:0", {
      quality: "1080p30",
      systemAudio: true,
    });

    expect(bridge.started).toEqual(["window:123:0"]);
    // It fell through to the endpoint loopback tier instead of publishing a
    // corpse as "process".
    expect(acquired.filmAudioSource).not.toBe("process");
  });

  it("does not attempt process capture at all when the user shared without system audio", async () => {
    const bridge = installGlobals({});
    const { acquireScreenShare } = await import("./screen-share");

    const acquired = await acquireScreenShare("window:123:0", {
      quality: "1080p30",
      systemAudio: false,
    });

    expect(bridge.started).toEqual([]);
    expect(acquired.audio).toBeNull();
    expect(acquired.hasSystemAudio).toBe(false);
    // Deliberately silent is NOT a failure — it must never raise the warning.
    expect(acquired.systemAudioUnavailable).toBe(false);
  });

  it("reports systemAudioUnavailable when NO film-audio source could be captured", async () => {
    // Process capture impossible AND the endpoint yields no track → the share is
    // genuinely video-only and the sharer must be told so up front (§35).
    installGlobals({ processStartOk: false, displayAudio: [] });
    const { acquireScreenShare } = await import("./screen-share");

    const acquired = await acquireScreenShare("window:123:0", {
      quality: "1080p30",
      systemAudio: true,
    });

    expect(acquired.audio).toBeNull();
    expect(acquired.hasSystemAudio).toBe(false);
    expect(acquired.systemAudioUnavailable).toBe(true);
    expect(acquired.filmAudioSource).toBeNull();
  });
});

describe("film-audio supervisor", { timeout: FILM_AUDIO_TIMEOUT_MS }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("reports 'unavailable' immediately when there is no film-audio track", async () => {
    installGlobals({});
    const { superviseFilmAudio } = await import("./screen-share");
    const updates: string[] = [];

    const stop = superviseFilmAudio({
      initialTrack: null,
      initialSource: null,
      replaceAudio: async () => false,
      onUpdate: ({ status }) => updates.push(status),
    });
    stop();

    // Viewers definitely hear nothing — say so, don't pretend to search.
    expect(updates).toEqual(["unavailable"]);
  });

  it("starts in 'searching' — a published track is NOT yet proof of sound", async () => {
    installGlobals({});
    const { superviseFilmAudio } = await import("./screen-share");
    const updates: string[] = [];

    const stop = superviseFilmAudio({
      initialTrack: new FakeTrack("audio") as unknown as MediaStreamTrack,
      initialSource: "process",
      replaceAudio: async () => false,
      onUpdate: ({ status }) => updates.push(status),
    });
    stop();

    // This is the honest state right after a share starts: the track is live but
    // the user has not pressed play, so nothing has been heard.
    expect(updates[0]).toBe("searching");
    expect(updates).not.toContain("live");
  });

  it("stops cleanly without leaking its watcher", async () => {
    installGlobals({});
    const { superviseFilmAudio } = await import("./screen-share");
    const track = new FakeTrack("audio");

    const stop = superviseFilmAudio({
      initialTrack: track as unknown as MediaStreamTrack,
      initialSource: "loopback",
      replaceAudio: async () => false,
      onUpdate: () => undefined,
    });
    // Idempotent teardown — the store calls this on every share-end path.
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});
