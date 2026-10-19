/**
 * Echo canceller choice (M16 · 1D, founder symptom H2) — pure view model.
 *
 * On Android 10+ `@livekit/react-native` builds the audio device module with the
 * PLATFORM echo canceller and noise suppressor, and libwebrtc then switches its own
 * software AEC off. The phone vendor's canceller is tuned for that handset and is
 * usually the better one, but on some models it leaks on the loudspeaker and the
 * other side hears their own voice. The patched native module can instead build
 * the ADM WITHOUT the hardware effects, so WebRTC's software AEC/NS run.
 *
 *  - `device` — hardware AEC/NS (what every install has shipped with). DEFAULT.
 *  - `demli`  — hardware effects off; WebRTC's software AEC/NS clean the signal.
 *
 * Why `device` stays the default: it is the measured status quo on every existing
 * install, and on Android libwebrtc's software path is its MOBILE canceller
 * (AECM, chosen for Android builds in webrtc_voice_engine.cc — not verified against
 * the shipped 144.7559.04 binary), which is built for the handset and can be
 * weaker on the loudspeaker than a good vendor canceller. Which one wins is
 * device-specific, so the founder A/B (feature-parity.md, M16 1D) decides whether
 * the default flips. The ADM is built once per React instance, so a change
 * applies on the next app start; the view reports a pending restart honestly.
 */
import type { AudioProcessingInfo } from "./audio-route";

export const ECHO_CANCELLER_MODES = ["device", "demli"] as const;
export type EchoCancellerMode = (typeof ECHO_CANCELLER_MODES)[number];

export const DEFAULT_ECHO_CANCELLER: EchoCancellerMode = "device";

export type EchoCancellerView =
  /** Not an Android build with the patched module: render nothing. */
  | { kind: "hidden" }
  /** No hardware canceller to choose: WebRTC's software one always runs. */
  | { kind: "softwareOnly"; reason: "oldAndroid" | "noHardware" }
  | {
      kind: "choice";
      /** The persisted choice (what the next start uses). */
      selected: EchoCancellerMode;
      /** What the running audio module was built with. */
      active: EchoCancellerMode;
      /** The choice differs from what is running until the app restarts. */
      restartPending: boolean;
    };

export function modeForHardware(hardware: boolean): EchoCancellerMode {
  return hardware ? "device" : "demli";
}

export function hardwareForMode(mode: EchoCancellerMode): boolean {
  return mode === "device";
}

export function echoCancellerView(info: AudioProcessingInfo | null): EchoCancellerView {
  if (!info) return { kind: "hidden" };
  if (!info.hardwareSupported) return { kind: "softwareOnly", reason: "oldAndroid" };
  if (!info.aecAvailable) return { kind: "softwareOnly", reason: "noHardware" };
  const selected = modeForHardware(info.hardwarePreferred);
  const active = modeForHardware(info.hardwareActive);
  return { kind: "choice", selected, active, restartPending: selected !== active };
}
