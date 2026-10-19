/**
 * The web adapter's live mic-DSP paths (livekit.ts): an in-place retune only counts
 * when the track REPORTS the new flags, and a re-acquire keeps the chosen device.
 *
 * Both behaviours come from measurements, not from the spec: on Electron 33.4.11
 * (Chromium 130) `applyConstraints({ echoCancellation: false, ... })` resolves while
 * `getSettings()` keeps reporting the old values, and livekit's `restartTrack` fills
 * a missing `deviceId` with `{ ideal: "default" }`. livekit-client is replaced with a
 * minimal fake so the adapter's own decisions are what is under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMsTrack {
  readyState: string;
  settings: Record<string, unknown>;
  applyConstraints: ReturnType<typeof vi.fn>;
  getSettings: () => Record<string, unknown>;
}

const mic: {
  mediaStreamTrack: FakeMsTrack;
  constraints: Record<string, unknown> | undefined;
  processor: unknown;
  restartTrack: ReturnType<typeof vi.fn>;
  getProcessor: () => unknown;
} = {
  mediaStreamTrack: makeMsTrack(),
  constraints: undefined,
  processor: undefined,
  restartTrack: vi.fn(async () => undefined),
  getProcessor: () => mic.processor,
};

function makeMsTrack(): FakeMsTrack {
  const track: FakeMsTrack = {
    readyState: "live",
    settings: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    applyConstraints: vi.fn(async () => undefined),
    getSettings: () => ({ ...track.settings }),
  };
  return track;
}

vi.mock("livekit-client", () => {
  class Room {
    localParticipant = {
      getTrackPublication: (source: string) =>
        source === "microphone" ? { audioTrack: mic } : undefined,
    };
    remoteParticipants = new Map();
    on(): this {
      return this;
    }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      AudioPlaybackStatusChanged: "audioPlaybackChanged",
    },
    Track: {
      Kind: { Audio: "audio", Video: "video" },
      Source: {
        Microphone: "microphone",
        Camera: "camera",
        ScreenShare: "screen_share",
        ScreenShareAudio: "screen_share_audio",
      },
    },
    VideoQuality: { LOW: 0, HIGH: 2 },
    createAudioAnalyser: () => ({ calculateVolume: () => 0, cleanup: () => undefined }),
  };
});

const { createLiveKitRoom, micDspSettingsMatch } = await import("../livekit.js");

type Adapter = Awaited<ReturnType<typeof createLiveKitRoom>> & {
  applyMicCaptureConstraints: (o: Record<string, unknown>) => Promise<boolean>;
  restartAudioTrack: (o: Record<string, unknown>) => Promise<void>;
};

const allOff = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

beforeEach(() => {
  mic.mediaStreamTrack = makeMsTrack();
  mic.constraints = undefined;
  mic.processor = undefined;
  mic.restartTrack.mockClear();
});

describe("micDspSettingsMatch", () => {
  it("needs every requested flag reported with the requested value", () => {
    expect(micDspSettingsMatch({ echoCancellation: false }, { echoCancellation: false })).toBe(true);
    expect(micDspSettingsMatch({ echoCancellation: true }, { echoCancellation: false })).toBe(false);
    expect(
      micDspSettingsMatch(
        { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
        allOff,
      ),
    ).toBe(false);
  });

  it("treats an unreported flag as not applied", () => {
    expect(micDspSettingsMatch({}, { echoCancellation: false })).toBe(false);
  });

  it("ignores flags that were not requested", () => {
    expect(micDspSettingsMatch({ echoCancellation: true }, { noiseSuppression: undefined })).toBe(
      true,
    );
  });
});

describe("applyMicCaptureConstraints", () => {
  it("returns false when applyConstraints resolves but the DSP did not move (Chromium 130)", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    await expect(room.applyMicCaptureConstraints(allOff)).resolves.toBe(false);
    expect(mic.mediaStreamTrack.applyConstraints).toHaveBeenCalledWith(allOff);
  });

  it("returns true when the track reports the requested flags afterwards", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    mic.mediaStreamTrack.applyConstraints.mockImplementation(async (c: Record<string, unknown>) => {
      Object.assign(mic.mediaStreamTrack.settings, c);
    });
    await expect(room.applyMicCaptureConstraints(allOff)).resolves.toBe(true);
  });

  it("returns false when the browser rejects the constraint", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    mic.mediaStreamTrack.applyConstraints.mockRejectedValue(new Error("OverconstrainedError"));
    await expect(room.applyMicCaptureConstraints(allOff)).resolves.toBe(false);
  });

  it("does not touch the track while a processor is attached", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    mic.processor = { name: "rnnoise" };
    await expect(room.applyMicCaptureConstraints(allOff)).resolves.toBe(false);
    expect(mic.mediaStreamTrack.applyConstraints).not.toHaveBeenCalled();
  });
});

describe("restartAudioTrack", () => {
  it("keeps the user's selected microphone", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    mic.constraints = { deviceId: { exact: "usb-mic-1" } };
    await room.restartAudioTrack({ ...allOff, sampleRate: 48_000, channelCount: 1 });
    expect(mic.restartTrack).toHaveBeenCalledWith({
      ...allOff,
      sampleRate: 48_000,
      channelCount: 1,
      deviceId: { exact: "usb-mic-1" },
    });
  });

  it("passes the options through when no device was ever chosen", async () => {
    const room = (await createLiveKitRoom()) as Adapter;
    await room.restartAudioTrack(allOff);
    expect(mic.restartTrack).toHaveBeenCalledWith(allOff);
  });
});
