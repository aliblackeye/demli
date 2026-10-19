/**
 * Live audio route snapshot over the patched LiveKit native module: the pill must
 * show the route audioswitch is ACTUALLY on, and follow its change event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown) => void;
const { handlers, native } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  native: {
    getAudioOutputs: vi.fn(async () => ["earpiece", "speaker"]),
    getSelectedAudioOutput: vi.fn(async (): Promise<string | null> => "speaker"),
    getAudioProcessingInfo: vi.fn(),
    setHardwareAudioProcessingPreferred: vi.fn(async () => undefined),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: { LivekitReactNativeModule: native },
  NativeEventEmitter: class {
    addListener(name: string, handler: Handler) {
      handlers.set(name, handler);
      return { remove: () => handlers.delete(name) };
    }
  },
}));

import {
  clearAudioRoute,
  getAudioRouteSnapshot,
  normalizeRoutes,
  refreshAudioRoute,
  setHardwareAudioProcessingPreferred,
  subscribeAudioRoute,
} from "../audio-route";

describe("audio route snapshot", () => {
  beforeEach(() => clearAudioRoute());

  it("keeps known routes only, de-duplicated, in a stable order", () => {
    expect(normalizeRoutes(["bluetooth", "speaker", "speaker", "hdmi", 3])).toEqual(["speaker", "bluetooth"]);
    expect(normalizeRoutes(null)).toEqual([]);
  });

  it("reads the active route from native, not the last pick", async () => {
    const snap = await refreshAudioRoute();
    expect(snap).toEqual({ selected: "speaker", available: ["speaker", "earpiece"] });
  });

  it("follows audioswitch's change event and notifies subscribers once per change", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAudioRoute(listener);
    const emit = handlers.get("LK_AUDIO_OUTPUT_CHANGED");
    expect(emit).toBeDefined();

    emit?.({ selected: "headset", available: ["speaker", "headset", "earpiece"] });
    expect(getAudioRouteSnapshot()).toEqual({ selected: "headset", available: ["speaker", "earpiece", "headset"] });
    emit?.({ selected: "headset", available: ["headset", "speaker", "earpiece"] });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("treats an unknown native route as unknown rather than guessing", async () => {
    native.getSelectedAudioOutput.mockResolvedValueOnce("telepathy");
    const snap = await refreshAudioRoute();
    expect(snap.selected).toBeNull();
  });

  it("persists the echo-canceller choice through the native module", async () => {
    await expect(setHardwareAudioProcessingPreferred(false)).resolves.toBe(true);
    expect(native.setHardwareAudioProcessingPreferred).toHaveBeenCalledWith(false);
  });
});
