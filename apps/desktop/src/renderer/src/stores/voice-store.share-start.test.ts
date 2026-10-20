/**
 * Screen-share double-start guard (pre-release audit, MED).
 *
 * Acquisition can take seconds ("app" sound warms up a process capture) while
 * the engine still reports `screenShareEnabled: false`. A second start in that
 * window used to bump the share token, drop the first share's audio status /
 * watcher / self-preview, and ask the engine to publish again. The store now
 * exposes `screenShareStarting` and refuses a start while it is set.
 *
 * The real store runs against a scripted fake engine: `startScreenShare` on the
 * fake resolves only when the test says so, which is exactly the slow-acquire
 * window the bug lived in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MediaModule from "@demli/media";

const engineStart = vi.fn<(acquire: unknown, options: unknown) => Promise<void>>();

vi.mock("@demli/media", async (importOriginal) => {
  const actual = await importOriginal<typeof MediaModule>();
  let state = { ...actual.initialVoiceState, status: "connected" as const };
  const listeners = new Set<(s: typeof state) => void>();
  const known: Record<string, unknown> = {
    getState: () => state,
    subscribe: (l: (s: typeof state) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    startScreenShare: (acquire: unknown, options: unknown) => engineStart(acquire, options),
    getLocalScreenShareAudioTrack: () => null,
    __setState: (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
      for (const l of listeners) l(state);
    },
  };
  const engine = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => undefined),
  });
  return { ...actual, createVoiceEngine: () => engine, __engine: engine };
});
vi.mock("@demli/media/web", () => ({
  createLiveKitRoom: () => ({}),
  createWebMicMonitor: () => ({}),
}));
vi.mock("../lib/noise-filter", () => ({ createRnnoiseFilter: () => null }));
vi.mock("../lib/api-client", () => ({ api: {} }));
vi.mock("../lib/voice-surface", () => ({ resolveVoiceSurfaceKind: () => "channel" }));
vi.mock("../lib/screen-share", () => ({
  captureSystemShareAudio: vi.fn(async () => null),
  loadScreenSharePrefs: () => ({}),
  makeScreenShareAcquire: () => async () => ({ video: {}, audio: null }),
  releaseShareCapture: vi.fn(),
  startOptionsFor: () => ({ quality: "1080p30", audioMode: "none" }),
  superviseFilmAudio: () => () => undefined,
}));

afterEach(() => {
  engineStart.mockReset();
});

describe("voice store: one screen share start at a time", () => {
  it("a second start while the first is still acquiring is ignored", async () => {
    const { useVoiceStore } = await import("./voice-store");
    let release: () => void = () => {};
    engineStart.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

    useVoiceStore.getState().startScreenShare("screen:0:0");
    expect(useVoiceStore.getState().screenShareStarting).toBe(true);

    useVoiceStore.getState().startScreenShare("window:1:0");
    expect(engineStart).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(useVoiceStore.getState().screenShareStarting).toBe(false));
  });

  it("clears the starting flag when the start fails, so the user can retry", async () => {
    const { useVoiceStore } = await import("./voice-store");
    engineStart.mockImplementationOnce(() => Promise.reject(new Error("picker failed")));
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);

    useVoiceStore.getState().startScreenShare("screen:0:0");
    await vi.waitFor(() => expect(useVoiceStore.getState().screenShareStarting).toBe(false));

    engineStart.mockImplementationOnce(() => Promise.resolve());
    useVoiceStore.getState().startScreenShare("screen:0:0");
    expect(engineStart).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(useVoiceStore.getState().screenShareStarting).toBe(false));
    warn.mockRestore();
  });

  it("tells main the share is over only when a LIVE share ends, never during acquisition", async () => {
    const media = (await import("@demli/media")) as unknown as {
      __engine: { __setState: (p: object) => void };
    };
    const screenShare = await import("../lib/screen-share");
    const release = vi.mocked(screenShare.releaseShareCapture);
    release.mockClear();
    await import("./voice-store");

    // Engine notifies while the share is still coming up (flag false): no release.
    media.__engine.__setState({ micEnabled: false });
    expect(release).not.toHaveBeenCalled();
    media.__engine.__setState({ screenShareEnabled: true });
    expect(release).not.toHaveBeenCalled();
    media.__engine.__setState({ screenShareEnabled: false });
    expect(release).toHaveBeenCalledTimes(1);
    media.__engine.__setState({ micEnabled: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a start while a share is already live is ignored", async () => {
    const media = (await import("@demli/media")) as unknown as {
      __engine: { __setState: (p: object) => void };
    };
    const { useVoiceStore } = await import("./voice-store");
    media.__engine.__setState({ screenShareEnabled: true });

    useVoiceStore.getState().startScreenShare("screen:0:0");
    expect(engineStart).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().screenShareStarting).toBe(false);
    media.__engine.__setState({ screenShareEnabled: false });
  });
});
