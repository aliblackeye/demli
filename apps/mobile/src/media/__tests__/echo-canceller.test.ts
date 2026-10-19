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
    expect(echoCancellerView(null, true)).toEqual({ kind: "hidden" });
  });

  it("offers no choice below Android 10, where LiveKit never enables hardware processing", () => {
    expect(echoCancellerView({ ...base, hardwareSupported: false }, true)).toEqual({
      kind: "softwareOnly",
      reason: "oldAndroid",
      aecOff: false,
    });
  });

  it("offers no choice on a device without a platform echo canceller", () => {
    expect(echoCancellerView({ ...base, aecAvailable: false }, true)).toEqual({
      kind: "softwareOnly",
      reason: "noHardware",
      aecOff: false,
    });
  });

  it("reports a pending restart until the running module matches the saved choice", () => {
    expect(echoCancellerView({ ...base, hardwarePreferred: false }, true)).toEqual({
      kind: "choice",
      aecOff: false,
      selected: "demli",
      active: "device",
      restartPending: true,
    });
    expect(
      echoCancellerView({ ...base, hardwarePreferred: false, hardwareActive: false }, true),
    ).toEqual({
      kind: "choice",
      aecOff: false,
      selected: "demli",
      active: "demli",
      restartPending: false,
    });
  });

  it("says nothing cancels echo while the mic's echo cancellation is off", () => {
    expect(echoCancellerView(base, false)).toMatchObject({ kind: "choice", aecOff: true });
    expect(echoCancellerView({ ...base, aecAvailable: false }, false)).toEqual({
      kind: "softwareOnly",
      reason: "noHardware",
      aecOff: true,
    });
  });
});
