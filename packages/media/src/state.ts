/**
 * Voice/media lifecycle model (see CLAUDE.md §11).
 *
 * The voice lifecycle is a finite state machine — never scattered React
 * booleans. The LiveKit engine (`createVoiceEngine`) drives transitions
 * against this model; UI components only read from it.
 */

import type { UserId } from "@demli/types";

export type VoiceStatus =
  | "idle"
  | "joining"
  | "connected"
  | "reconnecting"
  | "error"
  | "leaving";

export interface VoiceParticipant {
  userId: UserId;
  identity: string;
  micEnabled: boolean;
  speaking: boolean;
  screenSharing: boolean;
  /**
   * Whether this participant's CAMERA is on (a separate track from screen share
   * — the two can be on at once). For the local user this mirrors
   * `VoiceState.cameraEnabled`; for remotes it is true exactly while we hold a
   * subscribed camera video track to render (kept in sync with the tile), the
   * same derivation as `screenSharing`.
   */
  cameraEnabled: boolean;
  /**
   * The LISTENER's personal playback volume for this participant, 0..2 (0=muted,
   * 1=100% default, 2=200% boost) — the listener's per-user level. Client-side
   * only: it scales this remote's own audio playout, never the sender or the SFU
   * (no media crosses the WebSocket gateway, §10/§35). ALWAYS 1 for the local user
   * (you cannot attenuate yourself). Re-applied when the participant (re)joins, so
   * a saved level survives a leave/rejoin. Orthogonal to deafen (a master mute):
   * this is the level undeafen restores each remote to.
   */
  volume: number;
  /**
   * Whether this participant has DEAFENED themselves (muted all voice/film audio
   * for their own ears — the headphone-off toggle). Deafen is a purely LISTENER-side
   * client state that LiveKit does NOT model or broadcast natively (§11), so it is
   * carried over a LiveKit participant ATTRIBUTE (`PARTICIPANT_ATTR.deafened`): the
   * local user re-asserts it on the wire whenever it changes (and on join/reconnect),
   * peers receive it through `ParticipantAttributesChanged`. For the LOCAL entry this
   * mirrors `VoiceState.deafened`; for a remote it is read from that remote's current
   * attributes. The UI shows a headphone-off badge next to the mic-muted one — a
   * deafened user is always mic-muted too — deafening also mutes the mic.
   */
  deafened: boolean;
  /** True for the local user's own entry. */
  isLocal: boolean;
}

/**
 * Coarse connection-quality level for the local user (task #55). Mirrors
 * livekit's `ConnectionQuality` (excellent/good/poor/lost/unknown) collapsed to
 * three meaningful buckets + `unknown`: livekit's `lost` folds into `poor` (we
 * only have a three-bar indicator), and `unknown` covers "not measured yet" and
 * "not in a room". The UI maps this to a bar count + colour:
 * excellent → 3 bars green, good → 2 bars amber, poor → 1 bar red.
 */
export type ConnectionQualityLevel = "excellent" | "good" | "poor" | "unknown";

/**
 * The local connection's quality summary surfaced to the ping indicator. `level`
 * drives the bar count/colour; `rttMs` is the round-trip time shown in the
 * tooltip (null when unavailable — e.g. before the first measurement or off a
 * platform that can't sample it, in which case the tooltip shows the level name).
 */
export interface VoiceConnectionQuality {
  level: ConnectionQualityLevel;
  /** Round-trip time in ms, or null when unavailable. */
  rttMs: number | null;
}

/**
 * The "no measurement" summary. A SHARED frozen reference so resetting to it is a
 * no-op for the engine's identity-based `setState` (it never spuriously notifies
 * subscribers when quality was already unknown).
 */
export const UNKNOWN_CONNECTION_QUALITY: VoiceConnectionQuality = Object.freeze({
  level: "unknown",
  rttMs: null,
});

export interface VoiceState {
  roomId: string | null;
  status: VoiceStatus;
  micEnabled: boolean;
  deafened: boolean;
  screenShareEnabled: boolean;
  /**
   * True while the local screen share is publishing a system/loopback audio
   * track (the film's sound). Meaningful only while `screenShareEnabled` — lets
   * the UI show "sharing with/without audio" (loopback is Windows-only and can
   * fall back to video-only). Always false when not screen sharing.
   */
  screenShareHasAudio: boolean;
  /**
   * Whether the published film-audio track has been CONFIRMED to carry real
   * signal — the honest half of {@link screenShareHasAudio}, which only says "a
   * track is published" (§35: the UI must not claim viewers can hear the film
   * merely because a track object exists).
   *
   * WHY this is a separate axis. A film-audio source is armed at share START,
   * but the near-universal user flow is "start sharing, THEN press play", so at
   * t=0 there is nothing to hear and NO source can be validated. The old code
   * resolved the ladder once against that silence, published whatever it had,
   * and set `screenShareHasAudio: true` — on a virtual-mixer box (Voicemeeter)
   * that meant publishing a permanently-silent endpoint loopback while the panel
   * said "sistem sesiyle paylaşıyorsun". Viewers heard nothing, forever.
   *
   * So the platform supervisor watches the live track and reports here:
   *  - `false` = published but not yet proven audible ("film sesi bekleniyor").
   *  - `true`  = real signal observed; the film IS reaching viewers.
   * It can flip back to false only on a source swap. Always false when no film
   * audio is published.
   */
  screenShareAudioLive: boolean;
  /**
   * True while the LOCAL user is publishing their camera. A SEPARATE track from
   * the screen share (source `camera`, not `screen_share`) — camera and screen
   * share can be enabled at the same time, and neither depends on the other or
   * on the mic. Reset to false on leave/disconnect; preserved across reconnect
   * (livekit re-publishes the local track). Remote cameras are exposed
   * imperatively via the engine's camera snapshot, not here (a media track is
   * not React state — CLAUDE.md §27).
   */
  cameraEnabled: boolean;
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  /**
   * Preferred camera (videoinput) device id, or null for the platform default.
   * Mirrors `selectedInputDeviceId` for the mic: it survives across sessions and
   * is forwarded to the room (switchActiveDevice "videoinput") while connected.
   */
  selectedVideoDeviceId: string | null;
  participants: VoiceParticipant[];
  /**
   * "Kendini dinle" (Ayarlar → Ses) — the local mic is being played back to the
   * user through the SAME processing chain the publish uses, so the Gürültü
   * Engelleme tier can be judged by ear (see mic-monitor.ts).
   *
   * Legal in EVERY status: outside a room it is a plain settings preview; inside
   * one the engine force-mutes + deafens first (anti-feedback) and restores the
   * previous mic/deafen state when it is turned back off. It lives in the FSM —
   * not in a React boolean — precisely because that save/restore has to survive
   * mute, deafen, device switches, leave and reconnect (CLAUDE.md §11).
   *
   * Always false after a leave/disconnect/dispose: the monitor owns a live
   * capture track, and a monitor that outlives the session is a leak.
   */
  selfMonitoring: boolean;
  /**
   * Local connection quality for the ping/quality indicator (task #55).
   * Meaningful only while connected; `UNKNOWN_CONNECTION_QUALITY` when idle,
   * joining, reconnecting, leaving, or in error.
   */
  connectionQuality: VoiceConnectionQuality;
  /** Last user-facing error, cleared on next successful transition. */
  error: VoiceError | null;
  /**
   * Why the last voice session ENDED, when it ended for a non-error reason the UI
   * should announce (single-active-voice-session model). Set to `session_replaced`
   * when this device is evicted because the user joined voice from ANOTHER device
   * — the FSM has cleanly returned to `idle` (NOT `error`; this is a clean handoff,
   * not a failure), and the client shows the localized "you joined on another
   * device" notice off this flag. Null the rest of the time; cleared on the next
   * user-initiated join/leave. Distinct from `error` so eviction never surfaces as
   * the scary "voice server unavailable" message (§26).
   */
  endedReason: VoiceEndedReason | null;
  /**
   * Epoch ms at which the SERVER may eject us for being the last person in this
   * room — the client-side mirror of the alone-idle sweep (see alone-watch.ts and
   * `DEFAULT_ALONE_GRACE_MS` in apps/api/src/lib/dm-call-sweeper.ts).
   *
   * Set the moment we are alone in an EJECTABLE surface (a DM call room or a
   * group-DM voice channel — NEVER a server voice channel, where sitting alone is
   * legitimate and the server never acts). Cleared the instant anyone joins, we
   * leave, or the surface is not ejectable, which is what makes the UI warning
   * appear and disappear immediately.
   *
   * A TIMESTAMP, not a ticking counter, on purpose: the countdown ticks locally in
   * the one component that renders it, so becoming alone costs exactly one state
   * update instead of one per second for three minutes (§27).
   *
   * The client NEVER acts on it — the server is the only authority on who leaves a
   * room. Its second job is ATTRIBUTION: an eviction disconnect that lands after
   * this deadline is reported as `endedReason: "alone"` instead of the wrong (and
   * alarming) "you joined on another device".
   */
  aloneDeadlineAt: number | null;
}

/**
 * A non-error reason a voice session ended, surfaced so the UI can announce it.
 * A closed union so the client localizes it; new clean-end reasons (e.g.
 * kicked-by-admin) can be added here later.
 *
 * - `session_replaced` — evicted because the user joined voice from another device
 *   (the single-active-session rule: one voice room per account, across all devices).
 * - `alone` — the server ended the session because we were the last person in a DM
 *   call / group-DM voice channel for the whole idle window (`voice.disconnected`
 *   with `reason: "alone"`, or an eviction disconnect landing after our own
 *   {@link VoiceState.aloneDeadlineAt}). Not a failure — the call simply had
 *   nobody left in it.
 */
export type VoiceEndedReason = "session_replaced" | "alone";

/**
 * Map the `reason` carried by a server `voice.disconnected` event to the engine's
 * own {@link VoiceEndedReason}, or null when this client has no handling for it.
 *
 * Takes a plain string (not the protocol enum) so `@demli/media` keeps zero
 * dependency on `@demli/protocol` and stays RN-safe.
 *
 * NULL IS THE IMPORTANT RETURN. `moderator` is a real server reason whose notice
 * belongs to the moderation surface, and a future server will send reasons this
 * build has never heard of. Both must fall through to the client's existing
 * behavior rather than be coerced into the nearest reason we happen to know —
 * telling a user the wrong story about their own disconnect is worse than telling
 * them the generic one.
 */
export function voiceEndedReasonFromEvent(reason: string): VoiceEndedReason | null {
  return reason === "alone" ? "alone" : null;
}

/**
 * Which piece of hardware/capture a media error is about. Every device-shaped
 * {@link VoiceError} carries one so the user-facing message can name the RIGHT
 * thing — the founder hit "kamerayı aç → 'Seçili ses aygıtı kullanılamıyor'",
 * which is what happens when a camera failure is reported with the microphone's
 * wording.
 */
export type MediaDeviceKind = "microphone" | "screen" | "camera";

export type VoiceError =
  | { kind: "permission_denied"; device: MediaDeviceKind }
  // `device` (added for the camera, task #18) is optional so existing
  // constructions — `{ kind: "device_not_found" }` for the mic — stay valid;
  // it distinguishes "no camera" from "no microphone" for the message.
  | { kind: "device_not_found"; device?: "microphone" | "camera" }
  /**
   * The device exists but could not be opened with the requested settings, and
   * we could not classify it further. `device` is optional ONLY for backwards
   * compatibility with pre-existing constructions; it defaults to the microphone
   * in the message, so every NEW call site must pass it explicitly.
   */
  | { kind: "device_unavailable"; deviceId: string; device?: MediaDeviceKind }
  /**
   * `NotReadableError` / `AbortError` — the OS handed the device to someone else.
   * On mobile browsers the camera is effectively exclusive, so this is what a
   * second acquire looks like while a preview still holds the first one.
   */
  | { kind: "device_in_use"; device: "microphone" | "camera" }
  /**
   * `OverconstrainedError` — the device is free but cannot do the requested
   * resolution/frame-rate (a 1440p60 desktop preference on a phone's front
   * camera). Distinct from `device_unavailable` because the fix is "lower the
   * quality", not "pick another device".
   */
  | { kind: "device_constraints"; device: "microphone" | "camera" }
  | { kind: "track_ended_unexpectedly"; track: "mic" | "screen" | "camera" }
  /** "Kendini dinle" is not supported on this build (no monitor implementation). */
  | { kind: "monitor_unavailable" }
  | { kind: "reconnect_failed" }
  | { kind: "server_unavailable" };

export type VoiceCommand =
  | { type: "JOIN"; roomId: string }
  | { type: "LEAVE" }
  | { type: "SET_MIC"; enabled: boolean }
  | { type: "SET_DEAFENED"; deafened: boolean }
  | { type: "SET_INPUT_DEVICE"; deviceId: string }
  | { type: "SET_OUTPUT_DEVICE"; deviceId: string }
  | { type: "SET_VIDEO_DEVICE"; deviceId: string }
  | { type: "START_SCREEN_SHARE"; sourceId: string }
  | { type: "STOP_SCREEN_SHARE" }
  | { type: "SET_CAMERA"; enabled: boolean }
  | { type: "SET_PARTICIPANT_VOLUME"; identity: string; volume: number }
  | { type: "SET_SELF_MONITORING"; enabled: boolean };

export const initialVoiceState: VoiceState = {
  roomId: null,
  status: "idle",
  micEnabled: true,
  deafened: false,
  screenShareEnabled: false,
  screenShareHasAudio: false,
  screenShareAudioLive: false,
  cameraEnabled: false,
  selectedInputDeviceId: null,
  selectedOutputDeviceId: null,
  selectedVideoDeviceId: null,
  participants: [],
  selfMonitoring: false,
  connectionQuality: UNKNOWN_CONNECTION_QUALITY,
  error: null,
  endedReason: null,
  aloneDeadlineAt: null,
};

/**
 * Map a raw livekit `ConnectionQuality` value (a string enum whose values are
 * "excellent"/"good"/"poor"/"lost"/"unknown") to our coarse {@link
 * ConnectionQualityLevel}. Takes a plain string so this module — and the RN-safe
 * package root — stays livekit-free; both the web and RN room adapters share this
 * one mapping (and it unit-tests without the SDK). `lost` collapses to `poor`.
 */
export function connectionQualityLevelFromLiveKit(raw: string): ConnectionQualityLevel {
  switch (raw) {
    case "excellent":
      return "excellent";
    case "good":
      return "good";
    case "poor":
    case "lost":
      return "poor";
    default:
      return "unknown";
  }
}

/**
 * User-friendly message for each media failure (CLAUDE.md §26).
 * UIs render these — never raw exceptions or stack traces.
 */
export function voiceErrorMessage(error: VoiceError): string {
  switch (error.kind) {
    case "permission_denied":
      switch (error.device) {
        case "microphone":
          return "Microphone access was denied. Allow it in your system settings to talk.";
        case "camera":
          return "Camera access was denied. Allow it in your system settings to turn your camera on.";
        default:
          return "Screen share permission was denied.";
      }
    case "device_not_found":
      return error.device === "camera"
        ? "No camera was found. Connect one and try again."
        : "No microphone was found. Plug one in and try again.";
    case "device_unavailable":
      switch (error.device) {
        case "camera":
          return "The selected camera is unavailable. Pick another one in settings.";
        case "screen":
          return "The screen could not be captured. Try sharing again.";
        default:
          return "The selected audio device is unavailable. Pick another one in settings.";
      }
    case "device_in_use":
      return error.device === "camera"
        ? "Your camera is already in use by another app or tab. Close it and try again."
        : "Your microphone is already in use by another app. Close it and try again.";
    case "device_constraints":
      return error.device === "camera"
        ? "Your camera does not support the selected quality. Lower it in settings and try again."
        : "Your microphone does not support the selected audio quality. Lower it in settings and try again.";
    case "monitor_unavailable":
      return "Listening to yourself is not available on this device.";
    case "track_ended_unexpectedly":
      switch (error.track) {
        case "mic":
          return "Your microphone stopped unexpectedly. Check the device and unmute to retry.";
        case "camera":
          return "Your camera stopped unexpectedly. Check the device and turn it back on.";
        default:
          return "Screen share ended unexpectedly.";
      }
    case "reconnect_failed":
      return "Reconnecting to the voice room failed. Check your connection and rejoin.";
    case "server_unavailable":
      return "The voice server is unavailable right now. Try again shortly.";
  }
}
