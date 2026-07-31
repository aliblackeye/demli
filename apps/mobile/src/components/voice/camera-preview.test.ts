import { describe, expect, it } from "vitest";
import { classifyCameras, facingModeFor } from "./camera-preview";

/**
 * The camera-preview sheet (#101) shows a front/back toggle ONLY when the device
 * has two cameras, and must map each side to a stable deviceId so what the user
 * previews is what publishes. These pin the classification against the shapes
 * react-native-webrtc actually returns (explicit `facing`, or label-only).
 */
describe("classifyCameras", () => {
  it("classifies by the explicit facing field", () => {
    const r = classifyCameras([
      { deviceId: "1", kind: "videoinput", facing: "front", label: "camera 1" },
      { deviceId: "2", kind: "videoinput", facing: "environment", label: "camera 2" },
    ]);
    expect(r).toEqual({ count: 2, front: "1", back: "2" });
  });

  it("falls back to label wording (EN + TR) when facing is absent", () => {
    const r = classifyCameras([
      { deviceId: "a", kind: "videoinput", label: "Arka Kamera" },
      { deviceId: "b", kind: "videoinput", label: "Front Camera" },
    ]);
    expect(r.front).toBe("b");
    expect(r.back).toBe("a");
    expect(r.count).toBe(2);
  });

  it("ignores audio devices in the count and mapping", () => {
    const r = classifyCameras([
      { deviceId: "mic", kind: "audioinput", label: "Microphone" },
      { deviceId: "spk", kind: "audiooutput", label: "Speaker" },
      { deviceId: "cam", kind: "videoinput", facing: "front" },
    ]);
    expect(r.count).toBe(1);
    expect(r.front).toBe("cam");
    expect(r.back).toBeNull();
  });

  it("returns nulls (but a real count) when it cannot classify", () => {
    const r = classifyCameras([
      { deviceId: "x", kind: "videoinput", label: "" },
      { deviceId: "y", kind: "videoinput", label: "" },
    ]);
    expect(r.count).toBe(2);
    expect(r.front).toBeNull();
    expect(r.back).toBeNull();
  });

  it("treats an already-filtered list (no kind) as cameras", () => {
    const r = classifyCameras([{ deviceId: "solo", facing: "front" }]);
    expect(r.count).toBe(1);
    expect(r.front).toBe("solo");
  });
});

describe("facingModeFor", () => {
  it("maps the front/back choice to a getUserMedia facingMode", () => {
    expect(facingModeFor(true)).toBe("user");
    expect(facingModeFor(false)).toBe("environment");
  });
});
