/**
 * LiveKit React Native global registration.
 *
 * `@livekit/react-native` runs the platform-agnostic `livekit-client` engine on
 * top of the native WebRTC implementation from `@livekit/react-native-webrtc`.
 * Before ANY `Room` is constructed, `registerGlobals()` must install those
 * WebRTC globals (RTCPeerConnection, navigator.mediaDevices, MediaStream, the
 * URL/streams/crypto polyfills, native event bridge, …). This is the mobile
 * analog of "the browser already provides WebRTC" on desktop.
 *
 * We expose an idempotent guard rather than a bare import side-effect so the
 * ordering is explicit: the app entry (`app/_layout.tsx`) calls it at boot, and
 * the room factory calls it again defensively right before `new Room()`. The
 * second call is a no-op.
 */
import { registerGlobals } from "@livekit/react-native";

let registered = false;

/** Register LiveKit's RN WebRTC globals exactly once. Safe to call repeatedly. */
export function ensureLiveKitGlobals(): void {
  if (registered) return;
  registered = true;
  registerGlobals();
}
