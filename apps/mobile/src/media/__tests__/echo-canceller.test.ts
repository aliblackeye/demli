import { describe, expect, it } from "vitest";
import type { AudioProcessingInfo } from "../audio-route";
import {
  DEFAULT_ECHO_CANCELLER,
  echoCancellerView,
  hardwareForMode,
  modeForHardware,
} from "../echo-canceller";

const base: AudioProcessingInfo = {
  hardwareActive: true,
  hardwarePreferred: true,
  hardwareSupported: true,
  aecAvailable: true,
  nsAvailable: true,
};

describe("echo canceller view", () => {
  it("defaults to the device canceller, matching the native default (preference absent = hardware)", () => {
    expect(DEFAULT_ECHO_CANCELLER).toBe("device");
    expect(hardwareForMode(DEFAULT_ECHO_CANCELLER)).toBe(true);
  });

  it("maps modes to the native hardware flag both ways", () => {
    expect(modeForHardware(true)).toBe("device");
    expect(modeForHardware(false)).toBe("demli");
    expect(hardwareForMode("demli")).toBe(false);
  });

  it("is hidden without the patched native module (iOS / older binary)", () => {
    expect(echoCancellerView(null)).toEqual({ kind: "hidden" });
  });

  it("offers no choice below Android 10, where LiveKit never enables hardware processing", () => {
    expect(echoCancellerView({ ...base, hardwareSupported: false })).toEqual({
      kind: "softwareOnly",
      reason: "oldAndroid",
    });
  });

  it("offers no choice on a device without a platform echo canceller", () => {
    expect(echoCancellerView({ ...base, aecAvailable: false })).toEqual({
      kind: "softwareOnly",
      reason: "noHardware",
    });
  });

  it("reports a pending restart until the running module matches the saved choice", () => {
    expect(echoCancellerView({ ...base, hardwarePreferred: false })).toEqual({
      kind: "choice",
      selected: "demli",
      active: "device",
      restartPending: true,
    });
    expect(echoCancellerView({ ...base, hardwarePreferred: false, hardwareActive: false })).toEqual({
      kind: "choice",
      selected: "demli",
      active: "demli",
      restartPending: false,
    });
  });
});
