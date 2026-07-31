/**
 * Pure helpers for the mobile camera-preview sheet (#101). Kept framework-free so
 * the front/back classification is unit-testable without React Native or a live
 * camera. The sheet does the getUserMedia / RTCView / engine wiring; this module
 * only reasons about the enumerated device list.
 */

export type FacingMode = "user" | "environment";

/** The subset of a react-native-webrtc `MediaDeviceInfo` we classify on. */
export interface EnumeratedCamera {
  deviceId: string;
  kind?: string;
  label?: string;
  /** react-native-webrtc populates this for videoinput: "front" | "environment". */
  facing?: string;
}

export interface FacingCameras {
  /** Distinct videoinput cameras — drives whether the front/back toggle is shown. */
  count: number;
  /** Best-effort deviceId for the front (selfie) camera, or null if unknown. */
  front: string | null;
  /** Best-effort deviceId for the back (environment) camera, or null if unknown. */
  back: string | null;
}

const FRONT_RE = /front|user|selfie|ön/i;
const BACK_RE = /back|rear|environment|world|arka/i;

/** True for the kinds we treat as a camera (undefined kind = already filtered list). */
function isCamera(d: EnumeratedCamera): boolean {
  return !!d.deviceId && d.kind !== "audioinput" && d.kind !== "audiooutput";
}

/**
 * Classify enumerated devices into front/back camera deviceIds. Prefers the
 * explicit `facing` field react-native-webrtc provides, then falls back to label
 * wording (EN + TR). First match wins so selection is deterministic. `count` is
 * the number of distinct cameras — the sheet shows the front/back toggle only
 * when at least two exist, so a single-camera device never gets a dead switch.
 */
export function classifyCameras(devices: readonly EnumeratedCamera[]): FacingCameras {
  const cams = devices.filter(isCamera);
  const front =
    cams.find((d) => d.facing === "front")?.deviceId ??
    cams.find((d) => d.label != null && FRONT_RE.test(d.label))?.deviceId ??
    null;
  const back =
    cams.find((d) => d.facing === "environment" || d.facing === "back")?.deviceId ??
    cams.find((d) => d.label != null && BACK_RE.test(d.label))?.deviceId ??
    null;
  return { count: cams.length, front, back };
}

/** The livekit/getUserMedia `facingMode` string for a front/back choice. */
export function facingModeFor(front: boolean): FacingMode {
  return front ? "user" : "environment";
}
