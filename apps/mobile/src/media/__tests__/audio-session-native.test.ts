/**
 * The REAL room adapter, audio-mode guard and route store over a fake of the
 * native audio layer that keeps the timing that matters:
 *
 *  - `startAudioSession` / `stopAudioSession` are void bridge methods: JS resumes
 *    before the main looper has done anything;
 *  - `AudioSwitchManager.start()` checks `audioSwitch == null` on the calling
 *    thread and does NOTHING while a session is still alive;
 *  - `AudioSwitchManager.stop()` only posts the teardown (front of the main queue);
 *    the teardown restores the pre-call mode and drops the session;
 *  - the patched `getSelectedAudioOutput()` resolves from a main-looper post, so
 *    it lands after every audioswitch task queued before it.
 *
 * The main looper runs one task per macrotask, so back-to-back JS calls race it
 * the way the bridge does on a phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Task = { owner: "switch" | "module"; run: () => void };

const { native, rooms } = vi.hoisted(() => {
  const main: Task[] = [];
  let scheduled = false;
  const state = {
    session: null as null | { selected: string },
    mode: "NORMAL",
    savedMode: "NORMAL",
    speakerForced: false,
  };
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setImmediate(pump);
  }
  function pump(): void {
    scheduled = false;
    const task = main.shift();
    task?.run();
    if (main.length > 0) schedule();
  }
  function post(owner: Task["owner"], run: () => void): void {
    main.push({ owner, run });
    schedule();
  }
  function postAtFront(owner: Task["owner"], run: () => void): void {
    main.unshift({ owner, run });
    schedule();
  }
  function removeAll(owner: Task["owner"]): void {
    for (let i = main.length - 1; i >= 0; i--) if (main[i]!.owner === owner) main.splice(i, 1);
  }
  const audioSession = {
    configureAudio: async (_config: unknown) => undefined,
    startAudioSession: async () => {
      if (state.session === null) {
        removeAll("switch");
        postAtFront("switch", () => {
          state.session = { selected: "speaker" };
          state.savedMode = state.mode;
          state.mode = "IN_COMMUNICATION";
          state.speakerForced = false;
        });
      }
    },
    stopAudioSession: async () => {
      removeAll("switch");
      postAtFront("switch", () => {
        if (state.session) state.mode = state.savedMode;
        state.session = null;
      });
    },
    selectAudioOutput: async (id: string) => {
      post("switch", () => {
        if (state.session) state.session.selected = id;
      });
    },
  };
  const module = {
    getAudioOutputs: async () => (state.session ? ["earpiece", "speaker"] : []),
    getSelectedAudioOutput: () =>
      new Promise<string | null>((resolve) => {
        post("module", () => resolve(state.session?.selected ?? null));
      }),
    addListener: () => undefined,
    removeListeners: () => undefined,
  };
  /** Let pending JS continuations post their work, then run the looper dry. */
  async function drain(): Promise<void> {
    do {
      await new Promise<void>((r) => setImmediate(r));
    } while (main.length > 0 || scheduled);
  }
  function reset(): void {
    main.length = 0;
    state.session = null;
    state.mode = "NORMAL";
    state.savedMode = "NORMAL";
    state.speakerForced = false;
  }
  /** What expo-audio's setAudioModeAsync does to the device on Android. */
  function expoModeWrite(): void {
    state.mode = "NORMAL";
    state.speakerForced = true;
  }

  type Listener = (...args: unknown[]) => void;
  const rooms = {
    holdDisconnect: null as null | Promise<void>,
    cameraOn: false,
    listeners: [] as Map<string, Set<Listener>>[],
  };
  return {
    native: { state, audioSession, module, drain, reset, expoModeWrite },
    rooms,
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: { LivekitReactNativeModule: native.module },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
}));

vi.mock("@livekit/react-native", () => ({ AudioSession: native.audioSession }));

vi.mock("livekit-client", () => {
  type Listener = (...args: unknown[]) => void;
  class FakeRoom {
    private readonly handlers = new Map<string, Set<Listener>>();
    localParticipant = {
      getTrackPublication: (source: string) =>
        source === "Camera" && rooms.cameraOn ? { source: "Camera", isMuted: false } : undefined,
    };
    remoteParticipants = new Map();
    constructor() {
      rooms.listeners.push(this.handlers);
    }
    on(event: string, listener: Listener) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(listener);
      return this;
    }
    off(event: string, listener: Listener) {
      this.handlers.get(event)?.delete(listener);
      return this;
    }
    async connect() {}
    async disconnect() {
      const hold = rooms.holdDisconnect;
      if (hold) await hold;
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: new Proxy({}, { get: (_t, k) => String(k) }),
    Track: { Source: new Proxy({}, { get: (_t, k) => String(k) }), Kind: { Audio: "audio" } },
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
});

vi.mock("../livekit-globals", () => ({ ensureLiveKitGlobals: vi.fn() }));
vi.mock("../audio-profile", () => ({
  androidAudioTypeOptionsFor: vi.fn(() => ({})),
  getActiveAudioProfile: vi.fn(() => "communication"),
}));
vi.mock("../local-audio-meter", () => ({ createRNLocalAudioMeter: vi.fn() }));
vi.mock("../permissions", () => ({
  normalizeMediaError: vi.fn((e: unknown) => e),
  ensureMicPermission: vi.fn(),
  ensureCameraPermission: vi.fn(),
}));

import * as guard from "../../sounds/audio-mode-guard";
import { getAudioRouteSnapshot, noteUserAudioRoutePick } from "../audio-route";
import { createMobileVoiceRoom } from "../livekit-room";

const URL = "wss://example.invalid";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function emitLocalCamera(roomIndex: number): void {
  rooms.cameraOn = true;
  const handlers = rooms.listeners[roomIndex]!.get("LocalTrackPublished");
  for (const handler of handlers ?? []) handler({ source: "Camera" });
}

describe("LiveKit audio session over the native audioswitch timing", () => {
  beforeEach(() => {
    native.reset();
    guard.resetAudioModeGuardForTests();
    rooms.holdDisconnect = null;
    rooms.cameraOn = false;
    rooms.listeners.length = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await native.drain();
  });

  it("a call left just before the next connect does not tear the new session down", async () => {
    const a = createMobileVoiceRoom();
    await a.connect(URL, "a");
    await native.drain();
    expect(native.state.session).not.toBeNull();

    await a.disconnect();
    const b = createMobileVoiceRoom();
    await b.connect(URL, "b");
    await native.drain();

    expect(native.state.session).not.toBeNull();
    expect(native.state.mode).toBe("IN_COMMUNICATION");
    expect(guard.isCallAudioActive()).toBe(true);
    await b.disconnect();
  });

  it("an old room whose disconnect settles after the next connect leaves the new call alone", async () => {
    const a = createMobileVoiceRoom();
    await a.connect(URL, "a");
    await native.drain();

    const late = deferred();
    rooms.holdDisconnect = late.promise;
    const aLeaving = a.disconnect();

    rooms.holdDisconnect = null;
    const b = createMobileVoiceRoom();
    await b.connect(URL, "b");
    await native.drain();
    expect(native.state.session).not.toBeNull();

    late.resolve();
    await aLeaving;
    await native.drain();

    expect(native.state.session).not.toBeNull();
    expect(native.state.mode).toBe("IN_COMMUNICATION");
    expect(guard.isCallAudioActive()).toBe(true);
    await expect(guard.runAudioModeChange(async () => undefined)).resolves.toBe(false);
    expect(getAudioRouteSnapshot().available).toEqual(["speaker", "earpiece"]);

    await b.disconnect();
    await native.drain();
    expect(native.state.session).toBeNull();
    expect(native.state.mode).toBe("NORMAL");
    expect(guard.isCallAudioActive()).toBe(false);
    expect(getAudioRouteSnapshot().available).toEqual([]);
  });

  it("re-asserts a session hit by a late expo-audio write and keeps the picked route", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const expo = deferred();
    const modeChange = guard.runAudioModeChange(async () => {
      await expo.promise;
      native.expoModeWrite();
    });

    const room = createMobileVoiceRoom();
    const connecting = room.connect(URL, "t");
    await vi.advanceTimersByTimeAsync(guard.ACQUIRE_WAIT_MS);
    await connecting;
    await native.drain();
    await room.switchActiveDevice("audiooutput", "earpiece");
    await native.drain();
    expect(native.state.session?.selected).toBe("earpiece");

    expo.resolve();
    await modeChange;
    await native.drain();

    expect(native.state.session).not.toBeNull();
    expect(native.state.mode).toBe("IN_COMMUNICATION");
    expect(native.state.speakerForced).toBe(false);
    expect(native.state.session?.selected).toBe("earpiece");
    await room.disconnect();
  });

  it("moves a carried-over earpiece route to the speaker when the camera goes live", async () => {
    const room = createMobileVoiceRoom();
    await room.connect(URL, "t");
    await native.drain();
    await room.switchActiveDevice("audiooutput", "earpiece");
    await native.drain();

    emitLocalCamera(0);
    await native.drain();
    expect(native.state.session?.selected).toBe("speaker");
    await room.disconnect();
  });

  it("keeps an earpiece route the user picked during this call when the camera goes live", async () => {
    const room = createMobileVoiceRoom();
    await room.connect(URL, "t");
    await native.drain();
    noteUserAudioRoutePick("earpiece");
    await room.switchActiveDevice("audiooutput", "earpiece");
    await native.drain();

    emitLocalCamera(0);
    await native.drain();
    expect(native.state.session?.selected).toBe("earpiece");
    await room.disconnect();
  });
});
