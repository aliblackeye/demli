/**
 * P0 regression guard (engine JS-thread saturation): the RN on-device mic meter
 * must NOT open the native plain `VolumeProcessor`. That processor emits
 * `LK_VOLUME_PROCESSED` on every ~10ms audio frame (~100 Hz), unthrottled, for the
 * whole capturing session — a constant native→JS bridge storm that pegged the RN
 * JS thread and froze active calls. While disabled, `createRNLocalAudioMeter`
 * returns null so the shared engine falls back to server-driven local speaking.
 *
 * Mocks `react-native` + `livekit-client` because the module imports them at load
 * time and this suite runs in the node env (no native runtime).
 */
import { describe, expect, it, vi } from "vitest";

const { createVolumeProcessor, deleteVolumeProcessor } = vi.hoisted(() => ({
  createVolumeProcessor: vi.fn(() => 1),
  deleteVolumeProcessor: vi.fn(),
}));

vi.mock("react-native", () => ({
  NativeModules: {
    LivekitReactNativeModule: {
      createVolumeProcessor,
      deleteVolumeProcessor,
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    },
  },
  // Constructed only on the (currently disabled) enabled path — a stub is enough.
  NativeEventEmitter: class {
    addListener(): { remove: () => void } {
      return { remove: vi.fn() };
    }
  },
}));

vi.mock("livekit-client", () => ({
  Track: { Source: { Microphone: "microphone" } },
}));

import { createRNLocalAudioMeter } from "./local-audio-meter";
import type { Room } from "livekit-client";

/**
 * A room whose local mic publication looks fully LIVE — so if the meter were
 * enabled it WOULD open a native volume processor. This proves it is the disable
 * that stops the storm, not a happened-to-be-missing mic track.
 */
function roomWithLiveMic(): Room {
  return {
    localParticipant: {
      getTrackPublication: () => ({
        audioTrack: { mediaStreamTrack: { id: "mic-track", _peerConnectionId: 7 } },
      }),
    },
  } as unknown as Room;
}

describe("createRNLocalAudioMeter — P0 JS-thread saturation guard", () => {
  it("returns null (engine → server-driven local speaking) instead of a meter", () => {
    expect(createRNLocalAudioMeter(roomWithLiveMic())).toBeNull();
  });

  it("never opens the native volume processor — no ~100 Hz LK_VOLUME_PROCESSED bridge storm", () => {
    createRNLocalAudioMeter(roomWithLiveMic());
    createRNLocalAudioMeter(roomWithLiveMic());
    expect(createVolumeProcessor).not.toHaveBeenCalled();
    expect(deleteVolumeProcessor).not.toHaveBeenCalled();
  });
});
