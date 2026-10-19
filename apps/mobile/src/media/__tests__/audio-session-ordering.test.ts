/**
 * The REAL room adapter + the REAL audio-mode guard: a connect must not configure
 * the LiveKit audio session while an expo-audio mode change is still running, and
 * after disconnect the guard must let mode changes through again. Only the native
 * SDK surfaces are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioSession } from "@livekit/react-native";
import * as guard from "../../sounds/audio-mode-guard";
import { createMobileVoiceRoom } from "../livekit-room";

const calls: string[] = [];

vi.mock("@livekit/react-native", () => ({
  AudioSession: {
    configureAudio: vi.fn(async () => {
      calls.push("configureAudio");
    }),
    startAudioSession: vi.fn(async () => {
      calls.push("startAudioSession");
    }),
    stopAudioSession: vi.fn(async () => {
      calls.push("stopAudioSession");
    }),
    selectAudioOutput: vi.fn(async (id: string) => {
      calls.push(`selectAudioOutput:${id}`);
    }),
  },
}));

vi.mock("livekit-client", () => {
  class FakeRoom {
    localParticipant = { getTrackPublication: () => undefined };
    remoteParticipants = new Map();
    on() {
      return this;
    }
    off() {
      return this;
    }
    async connect() {
      calls.push("room.connect");
    }
    async disconnect() {
      calls.push("room.disconnect");
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
vi.mock("../audio-route", () => ({
  clearAudioRoute: vi.fn(),
  getAudioRouteSnapshot: vi.fn(() => ({ selected: null, available: [] })),
  refreshAudioRoute: vi.fn(async () => ({ selected: null, available: [] })),
}));
vi.mock("../local-audio-meter", () => ({ createRNLocalAudioMeter: vi.fn() }));
vi.mock("../permissions", () => ({
  normalizeMediaError: vi.fn((e: unknown) => e),
  ensureMicPermission: vi.fn(),
  ensureCameraPermission: vi.fn(),
}));

describe("LiveKit audio session vs expo-audio mode changes", () => {
  beforeEach(() => {
    calls.length = 0;
    guard.resetAudioModeGuardForTests();
  });

  it("configures LiveKit only after an in-flight mode change has finished", async () => {

    let release!: () => void;
    const modeChange = guard.runAudioModeChange(
      () =>
        new Promise<void>((resolve) => {
          calls.push("setAudioModeAsync:start");
          release = () => {
            calls.push("setAudioModeAsync:end");
            resolve();
          };
        }),
    );

    const room = createMobileVoiceRoom();
    const connecting = room.connect("wss://example.invalid", "token");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["setAudioModeAsync:start"]);

    release();
    await Promise.all([modeChange, connecting]);
    expect(calls).toEqual([
      "setAudioModeAsync:start",
      "setAudioModeAsync:end",
      "configureAudio",
      "startAudioSession",
      "room.connect",
    ]);
  });

  it("refuses a mode change while connected and allows it again after disconnect", async () => {
    const room = createMobileVoiceRoom();
    await room.connect("wss://example.invalid", "token");

    const change = vi.fn(async () => undefined);
    await expect(guard.runAudioModeChange(change)).resolves.toBe(false);

    await room.disconnect();
    expect(calls.slice(-1)).toEqual(["stopAudioSession"]);
    await expect(guard.runAudioModeChange(change)).resolves.toBe(true);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("releases the guard when the audio session fails to start", async () => {
    vi.mocked(AudioSession.startAudioSession).mockRejectedValueOnce(new Error("no audio"));
    const room = createMobileVoiceRoom();
    await expect(room.connect("wss://example.invalid", "token")).rejects.toThrow("no audio");
    expect(guard.isCallAudioActive()).toBe(false);
  });
});
