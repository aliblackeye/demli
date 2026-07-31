/**
 * @demli/media/web — the web/Electron-renderer entry.
 *
 * `livekit-client` (DOM + WebRTC; browser and Electron renderer only) is
 * reachable ONLY through this entry, never through the package root
 * (`@demli/media`). React Native imports the root, supplies its own
 * `VoiceRoomAdapter` via the engine's injected `createRoom`, and so never pulls
 * livekit-client into its bundle.
 *
 * Desktop imports `createLiveKitRoom` from here and passes it as
 * `createVoiceEngine({ ..., createRoom: createLiveKitRoom })`.
 *
 * The self-monitoring ("Kendini dinle") playback lives here for the same reason:
 * it needs getUserMedia + AudioContext + an <audio> sink. Desktop/web pass it as
 * `createVoiceEngine({ ..., createMicMonitor: createWebMicMonitor })`.
 */

export { createLiveKitRoom } from "./livekit.js";
export { createWebMicMonitor } from "./mic-monitor-web.js";
