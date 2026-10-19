/**
 * Ordering between expo-audio's setAudioModeAsync and the LiveKit call session
 * (M16 · 1D). On Android a mode change rewrites AudioManager.mode + speakerphone,
 * so inside a call it would knock the session out of MODE_IN_COMMUNICATION. The
 * guard must refuse it during a call, make a connect wait for one in flight, and
 * re-assert the session when a slow change lands after the connect gave up waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCallAudio,
  isCallAudioActive,
  isVoiceSessionStatus,
  releaseCallAudio,
  resetAudioModeGuardForTests,
  runAudioModeChange,
  setVoiceSessionProbe,
} from "../audio-mode-guard";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("audio-mode-guard", () => {
  beforeEach(() => resetAudioModeGuardForTests());
  afterEach(() => vi.useRealTimers());

  it("treats joining / connected / reconnecting as a live session", () => {
    expect(isVoiceSessionStatus("joining")).toBe(true);
    expect(isVoiceSessionStatus("connected")).toBe(true);
    expect(isVoiceSessionStatus("reconnecting")).toBe(true);
    expect(isVoiceSessionStatus("idle")).toBe(false);
    expect(isVoiceSessionStatus("error")).toBe(false);
    expect(isVoiceSessionStatus("leaving")).toBe(false);
  });

  it("runs a mode change when no call is active", async () => {
    const change = vi.fn(async () => undefined);
    await expect(runAudioModeChange(change)).resolves.toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it.each(["joining", "connected", "reconnecting"])(
    "refuses a mode change while the voice status is %s",
    async (status) => {
      setVoiceSessionProbe(() => isVoiceSessionStatus(status));
      const change = vi.fn(async () => undefined);
      await expect(runAudioModeChange(change)).resolves.toBe(false);
      expect(change).not.toHaveBeenCalled();
    },
  );

  it("refuses while the room adapter owns the session, and allows it again after release", async () => {
    const lease = await acquireCallAudio(async () => undefined);
    expect(isCallAudioActive()).toBe(true);
    const change = vi.fn(async () => undefined);
    await expect(runAudioModeChange(change)).resolves.toBe(false);
    releaseCallAudio(lease);
    await expect(runAudioModeChange(change)).resolves.toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("an earlier call's late release does not unlock the call that replaced it", async () => {
    const oldCall = await acquireCallAudio(async () => undefined);
    const newCall = await acquireCallAudio(async () => undefined);
    releaseCallAudio(oldCall);
    expect(isCallAudioActive()).toBe(true);
    const change = vi.fn(async () => undefined);
    await expect(runAudioModeChange(change)).resolves.toBe(false);
    releaseCallAudio(newCall);
    expect(isCallAudioActive()).toBe(false);
  });

  it("a slow change that outlives one call re-asserts the call that owns the session when it lands", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const modeChange = runAudioModeChange(() => gate.promise);
    const oldReassert = vi.fn(async () => undefined);
    const newReassert = vi.fn(async () => undefined);
    const oldCall = acquireCallAudio(oldReassert, 100);
    await vi.advanceTimersByTimeAsync(100);
    releaseCallAudio(await oldCall);
    const newCall = acquireCallAudio(newReassert, 100);
    await vi.advanceTimersByTimeAsync(100);
    await newCall;
    gate.resolve();
    await modeChange;
    expect(oldReassert).not.toHaveBeenCalled();
    expect(newReassert).toHaveBeenCalledTimes(1);
  });

  it("makes a connect wait for an in-flight change so LiveKit writes last", async () => {
    const order: string[] = [];
    const gate = deferred();
    const modeChange = runAudioModeChange(async () => {
      order.push("mode:start");
      await gate.promise;
      order.push("mode:end");
    });
    const reassert = vi.fn(async () => undefined);
    const connect = acquireCallAudio(reassert, 10_000).then(() => order.push("livekit:configure"));

    await flush();
    expect(order).toEqual(["mode:start"]);
    gate.resolve();
    await Promise.all([modeChange, connect]);

    expect(order).toEqual(["mode:start", "mode:end", "livekit:configure"]);
    expect(reassert).not.toHaveBeenCalled();
  });

  it("re-asserts the call session when a slow change lands after the connect stopped waiting", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const gate = deferred();
    const modeChange = runAudioModeChange(async () => {
      order.push("mode:start");
      await gate.promise;
      order.push("mode:end");
    });
    const reassert = vi.fn(async () => {
      order.push("livekit:reassert");
    });
    const connect = acquireCallAudio(reassert, 1_500).then(() => order.push("livekit:configure"));

    await vi.advanceTimersByTimeAsync(1_500);
    await connect;
    expect(order).toEqual(["mode:start", "livekit:configure"]);

    gate.resolve();
    await modeChange;
    expect(order).toEqual(["mode:start", "livekit:configure", "mode:end", "livekit:reassert"]);
    expect(reassert).toHaveBeenCalledTimes(1);
  });

  it("does not re-assert when the call ended before the slow change landed", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const modeChange = runAudioModeChange(() => gate.promise);
    const reassert = vi.fn(async () => undefined);
    const connect = acquireCallAudio(reassert, 100);
    await vi.advanceTimersByTimeAsync(100);
    releaseCallAudio(await connect);
    gate.resolve();
    await modeChange;
    expect(reassert).not.toHaveBeenCalled();
  });

  it("propagates the change's own failure and still unblocks a waiting connect", async () => {
    const gate = deferred();
    const modeChange = runAudioModeChange(() => gate.promise);
    const connect = acquireCallAudio(async () => undefined, 10_000);
    gate.reject(new Error("native failure"));
    await expect(modeChange).rejects.toThrow("native failure");
    await expect(connect).resolves.toEqual({ reassert: expect.any(Function) });
  });
});
