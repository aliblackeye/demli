import type { VoiceError } from "@demli/media";
import type { AppTFunction } from "@/lib/i18n";

/**
 * Localized, user-facing message for a typed voice error (§26) — the mobile-side
 * i18n of the engine's `VoiceError`. `@demli/media` ships only English via
 * `voiceErrorMessage`; we map the typed error to `mobile.json` keys here instead
 * so the banner follows the app language (packages/media stays untouched). Covers
 * every `VoiceError` kind, including the camera variants added in task #18.
 * Returns null when there is no error (nothing to show).
 */
export function localizeVoiceError(
  error: VoiceError | null,
  t: AppTFunction,
): string | null {
  if (!error) return null;
  switch (error.kind) {
    case "permission_denied":
      switch (error.device) {
        case "microphone":
          return t("mobile:voice.errors.micPermission");
        case "camera":
          return t("mobile:voice.errors.cameraPermission");
        default:
          return t("mobile:voice.errors.screenPermission");
      }
    case "device_not_found":
      return error.device === "camera"
        ? t("mobile:voice.errors.noCamera")
        : t("mobile:voice.errors.noMic");
    // A device the engine could see but could not open. `device` distinguishes
    // the three surfaces, so a camera failure never renders as a microphone
    // message (the bug the founder hit on mobile web).
    case "device_unavailable":
      switch (error.device) {
        case "camera":
          return t("mobile:voice.errors.cameraUnavailable");
        case "screen":
          return t("mobile:voice.errors.screenUnavailable");
        default:
          return t("mobile:voice.errors.deviceUnavailable");
      }
    // Held by another app or tab — the common mobile-browser failure, where the
    // camera is exclusive. Actionable: close the other user and retry.
    case "device_in_use":
      return error.device === "camera"
        ? t("mobile:voice.errors.cameraInUse")
        : t("mobile:voice.errors.micInUse");
    // The device exists but cannot meet the requested quality (resolution/fps or
    // sample rate) — points at the settings, not at the hardware.
    case "device_constraints":
      return error.device === "camera"
        ? t("mobile:voice.errors.cameraConstraints")
        : t("mobile:voice.errors.micConstraints");
    // Self-monitoring needs an audio worklet + sink that React Native does not
    // provide; the toggle rejects rather than silently playing the RAW mic, which
    // would misrepresent the noise-suppression tier it exists to demonstrate.
    case "monitor_unavailable":
      return t("mobile:voice.errors.monitorUnavailable");
    case "track_ended_unexpectedly":
      switch (error.track) {
        case "mic":
          return t("mobile:voice.errors.micEnded");
        case "camera":
          return t("mobile:voice.errors.cameraEnded");
        default:
          return t("mobile:voice.errors.screenEnded");
      }
    case "reconnect_failed":
      return t("mobile:voice.errors.reconnectFailed");
    case "server_unavailable":
      return t("mobile:voice.errors.serverUnavailable");
  }
}
