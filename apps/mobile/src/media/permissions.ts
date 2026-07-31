/**
 * RN permission + media-error normalization for the voice adapter.
 *
 * The shared voice engine (`@demli/media`) classifies media failures by
 * `Error.name` (its private `mapAcquisitionError` switches on the DOMException
 * names `NotAllowedError` / `PermissionDeniedError` / `SecurityError` →
 * permission_denied, `NotFoundError` / `DevicesNotFoundError` → device_not_found,
 * everything else → device_unavailable). On the web those names come for free
 * from the browser's getUserMedia. On React Native they DON'T: Android needs an
 * explicit runtime permission request, and `@livekit/react-native-webrtc`'s
 * getUserMedia rejects with differently-shaped errors.
 *
 * So the ADAPTER is where the "RN permission → VoiceError" mapping lives: it
 * requests the native mic permission up front and re-throws denials/failures as
 * DOMException-named errors, letting the UNCHANGED engine produce the correct
 * user-facing §26 messages. (We do NOT edit `@demli/media`.)
 */
import { PermissionsAndroid } from "react-native";

type DomLikeErrorName =
  | "NotAllowedError"
  | "NotFoundError"
  | "PermissionDeniedError"
  | "SecurityError"
  | "DevicesNotFoundError";

/** Build an Error whose `.name` the engine's mapAcquisitionError understands. */
export function mediaError(name: DomLikeErrorName, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

const KNOWN_MEDIA_ERROR_NAMES = new Set<string>([
  "NotAllowedError",
  "PermissionDeniedError",
  "SecurityError",
  "NotFoundError",
  "DevicesNotFoundError",
]);

/**
 * Ensure the OS microphone permission is granted before we try to publish a mic
 * track. On Android this shows the runtime prompt (react-native-webrtc does NOT
 * request it for us); a denial becomes a `NotAllowedError` so the engine surfaces
 * `permission_denied`. On iOS the getUserMedia call itself triggers the system
 * prompt, so we simply let `setMicrophoneEnabled` proceed and normalize any
 * rejection in {@link normalizeMediaError}.
 */
export async function ensureMicPermission(): Promise<void> {
  if (process.env.EXPO_OS !== "android") return;
  let granted: string;
  try {
    granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: "Microphone access",
        message: "Demli needs your microphone so you can talk in voice.",
        buttonPositive: "Allow",
        buttonNegative: "Deny",
      },
    );
  } catch (err) {
    throw mediaError(
      "NotAllowedError",
      err instanceof Error ? err.message : "Microphone permission request failed.",
    );
  }
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw mediaError("NotAllowedError", "Microphone permission was denied.");
  }
}

/**
 * Ensure the OS camera permission before livekit acquires the camera track
 * (task #18) — the exact camera counterpart of {@link ensureMicPermission}. On
 * Android this shows the runtime prompt (react-native-webrtc does NOT request it
 * for us); a denial becomes a `NotAllowedError` so the engine surfaces
 * `permission_denied(camera)`. On iOS the getUserMedia call triggers the system
 * prompt itself, so we let `setCameraEnabled` proceed and normalize any rejection
 * in {@link normalizeMediaError}. The Android `CAMERA` permission and the iOS
 * `NSCameraUsageDescription` are already declared in app.json — no new native
 * capability, so this ships over-the-air. The rationale copy shown by the OS is
 * intentionally not i18n (it precedes the RN i18n context, like the mic prompt);
 * the in-app error banner IS localized.
 */
export async function ensureCameraPermission(): Promise<void> {
  if (process.env.EXPO_OS !== "android") return;
  let granted: string;
  try {
    granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: "Camera access",
        message: "Demli needs your camera so you can turn on video in voice.",
        buttonPositive: "Allow",
        buttonNegative: "Deny",
      },
    );
  } catch (err) {
    throw mediaError(
      "NotAllowedError",
      err instanceof Error ? err.message : "Camera permission request failed.",
    );
  }
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
    throw mediaError("NotAllowedError", "Camera permission was denied.");
  }
}

/**
 * Map a raw RN getUserMedia/device failure onto a DOMException-named error the
 * engine can classify. Errors that already carry a known name pass through
 * untouched; otherwise we sniff the message for permission / no-device wording.
 */
export function normalizeMediaError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (KNOWN_MEDIA_ERROR_NAMES.has(err.name)) return err;

  const msg = err.message.toLowerCase();
  if (
    msg.includes("permission") ||
    msg.includes("denied") ||
    msg.includes("not allowed") ||
    msg.includes("notallowed")
  ) {
    return mediaError("NotAllowedError", err.message);
  }
  if (
    msg.includes("not found") ||
    msg.includes("notfound") ||
    msg.includes("no device") ||
    msg.includes("no audio")
  ) {
    return mediaError("NotFoundError", err.message);
  }
  // Unknown → let the engine treat it as device_unavailable.
  return err;
}
