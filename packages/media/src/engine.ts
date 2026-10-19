/**
 * Voice engine — the single owner of the voice FSM (CLAUDE.md §11).
 * Framework- AND livekit-free: it drives a `VoiceRoomAdapter` supplied by the
 * caller's injected `createRoom` (web/desktop pass `createLiveKitRoom` from
 * `@demli/media/web`), so this file — and the package root — never import
 * livekit-client and stay RN-safe. The renderer consumes `getState()` +
 * `subscribe()` (useSyncExternalStore-compatible) and the command methods below.
 *
 * FSM transition table
 * ────────────────────────────────────────────────────────────────────────
 *  idle          --JOIN-------------------------> joining
 *  joining       --token+connect ok------------> connected
 *  joining       --fetchToken fails------------> error(server_unavailable)
 *  joining       --connect fails---------------> error(server_unavailable)
 *  joining       --LEAVE-----------------------> leaving → idle
 *  connected     --livekit Reconnecting--------> reconnecting
 *  reconnecting  --livekit Reconnected---------> connected (tracks re-applied)
 *  reconnecting  --livekit Disconnected--------> error(reconnect_failed)
 *  connected     --livekit Disconnected--------> error(server_unavailable)
 *  connected/reconnecting/joining --LEAVE------> leaving → idle
 *  error         --JOIN------------------------> joining   (retry)
 *  error         --LEAVE-----------------------> leaving → idle (clears error)
 *
 * JOIN has TWO credential paths that share ONE FSM (ADR 0012 §2 — DM calls):
 *  - default: the engine mints via the injected `fetchToken` (POST /media/token,
 *    group voice channels). Byte-for-byte the pre-existing path.
 *  - pre-minted: JOIN's optional 2nd arg carries a `{ url, token }` the caller
 *    already got from POST /dm-calls; the engine SKIPS `fetchToken` and connects
 *    with it. roomId = the call's LiveKit room (`dmcall:<callId>`). Everything
 *    downstream (connect/device/mic/reconnect/eviction) is identical — a call
 *    room is a voice room.
 *
 * Seamless DM→group upgrade (ADR 0012 §6) — NO FSM transition, by design: when a
 * third person is added the two originals STAY on the same LiveKit room (the new
 * group's voice channel resolves `livekit_room = dmcall:<callId>`), so the engine
 * neither disconnects nor re-joins — zero reconnect, zero media gap. The client
 * only re-points its OWN occupancy/UI to the group voice channel and sends a
 * signalling-only `voice.join`; it MUST NOT call leave()/join() on `call.upgraded`
 * (that would tear media down). roomId therefore stays `dmcall:<callId>` so a
 * later `voice.session_replaced` still keys correctly. The third person is an
 * ordinary voice join → surfaces here as a plain ParticipantConnected.
 *
 * Single-active-voice-session eviction (one voice room per account, across all devices):
 *  connected/reconnecting --livekit Disconnected(DUPLICATE_IDENTITY /
 *                           PARTICIPANT_REMOVED)-> idle (endedReason=session_replaced)
 *  connected/joining/reconnecting/error --SESSION_REPLACED(evicted room)-------->
 *                           idle (endedReason=session_replaced) via the leave path
 *  A SESSION_REPLACED whose room ≠ our current room is IGNORED — that is the
 *  device that just joined elsewhere (or a stale signal), never the evicted one.
 *  These end the session CLEANLY (idle, not error): eviction is a handoff, never
 *  the "voice server unavailable" message. A normal network drop / failed
 *  reconnect keeps its existing error mapping — only the two eviction disconnect
 *  reasons divert. endedReason is cleared on the next user-initiated join/leave.
 *
 * Alone-idle eviction (the server's alone sweep, mirrored so the UI can warn):
 *  connected/reconnecting, alone in an EJECTABLE surface -> aloneDeadlineAt set
 *                           (cleared the instant anyone joins — the window then
 *                           restarts from scratch if they leave again)
 *  connected/reconnecting --FORCED_DISCONNECT(reason)---> idle (endedReason=reason)
 *  An eviction disconnect landing AFTER aloneDeadlineAt is attributed to `alone`
 *  rather than `session_replaced` — the two are indistinguishable on the wire, and
 *  a 1-1 DM call gets no `voice.disconnected` at all, so the local deadline is the
 *  only evidence there. The client NEVER leaves on the deadline itself: the server
 *  decides who leaves a room (see alone-watch.ts).
 *
 * Flags (never separate statuses): micEnabled, deafened, screenShareEnabled,
 * cameraEnabled.
 *  - mic permission denied / no device on join → stays `connected`, mic off,
 *    typed error surfaced (you can still listen).
 *  - deafen mutes all remote playback AND the mic;
 *    undeafen restores the previous mic preference. setMic(true) while
 *    deafened undeafens first.
 *  - local mic track ending unexpectedly (device unplugged) → mic off +
 *    error(track_ended_unexpectedly), connection stays up.
 *  - camera (task #18) is an INDEPENDENT flag: it can be on with the mic muted,
 *    with a screen share, or both. Enabled only while `connected` via livekit's
 *    setCameraEnabled (the SDK acquires+publishes the track; unlike screen share
 *    the engine holds no raw track). Camera permission denied / no device → stays
 *    connected, camera off, typed error. Camera track ending unexpectedly (device
 *    unplugged) → camera off + error(track_ended_unexpectedly, "camera"),
 *    connection stays up. Reset on leave/disconnect; preserved across reconnect.
 *  - `error` field is cleared by the next successful command/transition.
 */

import type {
  ConnectionQualityLevel,
  MediaDeviceKind,
  VoiceCommand,
  VoiceConnectionQuality,
  VoiceEndedReason,
  VoiceError,
  VoiceParticipant,
  VoiceState,
  VoiceStatus,
} from "./state.js";
import {
  initialVoiceState,
  UNKNOWN_CONNECTION_QUALITY,
  voiceErrorMessage,
} from "./state.js";
import type { VoiceSurfaceKind } from "./alone-watch.js";
import { ALONE_GRACE_MS, isAloneEjectableSurface } from "./alone-watch.js";
import type {
  AudioCaptureOptionsLike,
  AudioTrackProcessorLike,
  ConnectionQualityProbe,
  LocalAudioMeter,
  MicPublishOptionsLike,
  ParticipantLike,
  RemoteAudioSourceLike,
  RemoteParticipantLike,
  RemoteTrackLike,
  RemoteTrackPublicationLike,
  RoomEventName,
  RoomListener,
  TrackPublicationLike,
  TrackPublishOptionsLike,
  VideoCaptureOptionsLike,
  VideoPublishOptionsLike,
  VoiceRoomAdapter,
} from "./room-adapter.js";
import {
  isEvictionDisconnect,
  PARTICIPANT_ATTR,
  ROOM_EVENT,
  TRACK_SOURCE,
} from "./room-adapter.js";
import {
  createSpeakingDetector,
  LOCAL_SPEAKING_POLL_MS,
  speakingThresholdForSensitivity,
  type SpeakingDetectorOptions,
} from "./speaking.js";
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  micAudioPresetForBitrate,
  SCREEN_SHARE_CONTENT_HINT,
  SCREEN_SHARE_DEGRADATION_PREFERENCE,
  SCREEN_SHARE_QUALITIES,
  screenShareEncodingForQuality,
  type ScreenShareQuality,
} from "./quality.js";
import {
  audioCaptureOptionsForSettings,
  effectiveNoiseSuppression,
  micPublishOptionsForSettings,
  resolveMicBitrateKbps,
  SCREEN_SHARE_AUDIO_PUBLISH,
  wantsNoiseFilter,
  type AudioSettings,
} from "./audio-settings.js";
import {
  cameraCaptureOptionsFor,
  cameraPublishOptionsFor,
  type VideoSettings,
} from "./video-settings.js";
import {
  constrainedCameraCaptureOptions,
  constrainedCameraPublishOptions,
  PRESSURE_SCREEN_SHARE_FLOOR,
  type BandwidthPressureSource,
} from "./bandwidth.js";
import {
  clampParticipantVolume,
  DEFAULT_PARTICIPANT_VOLUME,
  isDefaultParticipantVolume,
  normalizeParticipantVolumes,
  type ParticipantVolumeMap,
} from "./participant-volume.js";
import {
  monitorRestorePlan,
  monitorSuppressionPlan,
  type MicMonitor,
  type MicMonitorConfig,
  type MonitorAudioSnapshot,
} from "./mic-monitor.js";
import type { UserId } from "@demli/types";

/** What `fetchToken` must resolve with — see POST /media/token in apps/api. */
export interface VoiceTokenGrant {
  /** LiveKit websocket URL, e.g. ws://localhost:7880 */
  url: string;
  /** LiveKit access token (JWT) minted by the API. */
  token: string;
}

/**
 * A PRE-MINTED join credential for the DM-call path (ADR 0012 §2). Structurally
 * identical to {@link VoiceTokenGrant} (a `{ url, token }` LiveKit grant) — the
 * distinct name marks a call site that ALREADY holds a token and does NOT want
 * the engine's `fetchToken` hop.
 *
 * A DM call's token is minted ONLY by `POST /dm-calls` (start → caller token,
 * accept → callee token), never by `POST /media/token` — the caller hands the
 * `{ url, token }` from that response straight to {@link VoiceEngine.join} as the
 * optional 2nd argument, together with the call's LiveKit room name
 * (`dmcall:<callId>` = `DmCall.roomName`) as the 1st. From the response DTO
 * (`DmCallTokenResponse`) that is `{ url: res.url, token: res.token }` with room
 * `res.roomName`.
 */
export type VoiceJoinCredential = VoiceTokenGrant;

/**
 * The already-captured screen tracks the engine will publish. Platform-agnostic:
 * the CALLER (desktop renderer / later mobile) does the platform acquisition
 * (Electron capture bridge + getDisplayMedia) and hands the engine ready tracks.
 * The engine never imports Electron or calls getDisplayMedia itself.
 */
export interface ScreenShareAssets {
  /** The screen-share video track — required. */
  video: MediaStreamTrack;
  /** Optional system/loopback audio track (the film's sound). */
  audio?: MediaStreamTrack | null;
}

/**
 * Caller-injected acquisition callback. Runs inside `startScreenShare` so the
 * engine can map its failures to typed §26 errors (permission_denied /
 * source-closed) uniformly through the FSM. Reject to abort the share.
 */
export type AcquireScreenShare = () => Promise<ScreenShareAssets>;

/** Options for {@link VoiceEngine.startScreenShare} (screen-share quality matrix). */
export interface ScreenSharePublishOptions {
  /**
   * Quality id (matrix cell, e.g. `"1080p30"`) applied to the published screen VIDEO
   * track as a livekit `screenShareEncoding` ceiling. Defaults to
   * {@link DEFAULT_SCREEN_SHARE_QUALITY}. The caller should ALSO constrain its capture
   * to the same profile (see SCREEN_SHARE_QUALITY_PROFILES) so capture and encoder agree.
   */
  quality?: ScreenShareQuality;
}

/**
 * The livekit publish options for a screen-share VIDEO track at a given quality: the
 * bitrate/frame-rate ceiling from the matrix PLUS the `maintain-framerate` degradation
 * trade (smooth motion under congestion). Shared by the initial publish and the
 * live-tier-change republish so both always agree. The `motion` content hint is a
 * TRACK property, set separately via {@link setScreenContentHint}.
 *
 * DEV NOTE — the "share on → ping spikes → bar goes red" report (#112c): that is
 * publisher-side uplink BUFFERBLOAT, not a literally uncapped encoder (the cap here has
 * always been finite). At share start the send-side BWE probes bandwidth and the encoder
 * emits a big initial keyframe; without `motion`/`maintain-framerate` that pacing is
 * spiky VBR that momentarily fills the local egress queue, delaying EVERY packet — incl.
 * the livekit signaling ping `VoiceConnectionBars` reads (`room.engine.client.rtt`, see
 * livekit.ts `createConnectionQualityProbe`) — so `rttMs` jumps and `ConnectionQuality`
 * drops to poor. The `motion` hint (smooth CBR-ish pacing) + `maintain-framerate` (sheds
 * resolution, tracks the cap cleanly) + a right-sized cap here are the fix. To verify a
 * change: watch the ping tooltip / bar colour for ~5s AS a share starts at the top tier;
 * a persistent red at 1440p60 on a real uplink means drop a tier, not raise the cap. Any
 * deeper lever (livekit publishDefaults start-bitrate / SFU congestion tuning) is a Room-
 * config change outside this file — escalate rather than pipe media differently.
 */
function screenSharePublishOptions(
  quality: ScreenShareQuality,
): TrackPublishOptionsLike {
  return {
    source: TRACK_SOURCE.ScreenShare,
    // Encoder ceiling from the quality matrix — never uncapped (anti-bufferbloat).
    // Capture-side resolution/frame-rate caps are the caller's job (same profile).
    screenShareEncoding: screenShareEncodingForQuality(quality),
    degradationPreference: SCREEN_SHARE_DEGRADATION_PREFERENCE,
  };
}

/**
 * Set the `motion` content hint on a screen video track before publishing. DOM-only
 * and best-effort: react-native-webrtc tracks don't expose `contentHint`, and a
 * frozen/odd track must never break the share, so any failure is swallowed. The hint
 * makes the encoder pace a smooth motion stream instead of spiky keyframe VBR.
 */
function setScreenContentHint(track: MediaStreamTrack): void {
  try {
    // Plain assignment (not an `in` guard): a browser MediaStreamTrack has a real
    // contentHint setter the encoder reads; a react-native-webrtc track simply gains
    // an inert property. Only a frozen/getter-only track would throw — swallowed.
    track.contentHint = SCREEN_SHARE_CONTENT_HINT;
  } catch {
    // Best-effort — a platform that rejects the assignment simply goes without the hint.
  }
}

/**
 * A remote participant's live screen share, exposed imperatively (NOT in the
 * reactive VoiceState — a media track is not React state, CLAUDE.md §27). The
 * UI attaches `track` to a <video> via `track.attach(el)` (adaptiveStream-aware).
 */
export interface RemoteScreenShare {
  identity: string;
  userId: UserId;
  /** Attach to a <video> element via track.attach(element) — never raw srcObject. */
  track: RemoteTrackLike;
}

/**
 * A remote participant's live CAMERA video (task #18), exposed imperatively —
 * the exact same contract as {@link RemoteScreenShare}, just a different track
 * source (`camera`). Kept OUT of the reactive VoiceState (a media track is not
 * React state, CLAUDE.md §27). The UI attaches `track` to a <video> via
 * `track.attach(el)` (adaptiveStream-aware). A remote can appear in BOTH the
 * camera and screen-share snapshots at once — the tiles are independent.
 */
export interface RemoteCamera {
  identity: string;
  userId: UserId;
  /** Attach to a <video> element via track.attach(element) — never raw srcObject. */
  track: RemoteTrackLike;
}

export interface VoiceEngineOptions {
  /** Called on join; the API mints the token (identity = userId, room = channelId). */
  fetchToken(channelId: string): Promise<VoiceTokenGrant>;
  /**
   * Room factory — injected so the engine (and this whole package's root entry)
   * stays livekit-free and RN-safe. Web/desktop pass `createLiveKitRoom` from
   * `@demli/media/web`; tests and other platforms pass their own adapter.
   */
  createRoom: () => VoiceRoomAdapter | Promise<VoiceRoomAdapter>;
  /**
   * Optional mic publish bitrate in kbps, snapped to the nearest livekit
   * `AudioPresets` step (see micAudioPresetForBitrate). When omitted the
   * livekit default is used — existing behavior is unchanged. Can be updated
   * later via {@link VoiceEngine.setAudioBitrateKbps}.
   */
  audioBitrateKbps?: number;
  /**
   * Optional factory for the "Yüksek (Krisp benzeri)" noise-suppression tier's
   * audio track processor — an RNNoise WASM AudioWorklet inserted between the AEC'd
   * mic capture and the publish. Injected by the PLATFORM (desktop renderer bundles
   * the worklet + WASM); the engine attaches a FRESH processor to the mic capture
   * whenever the effective NS tier is `high` and this factory is present. Omit on
   * platforms without a filter (mobile today) — the engine then degrades `high` to
   * the built-in `standard` WebRTC suppression (never to "no suppression"), so a UI
   * that hides the High option and one that doesn't both stay correct.
   *
   * Each call must return a NEW processor instance (livekit owns its lifecycle:
   * init on publish, restart on device switch, destroy on track teardown).
   */
  createNoiseFilter?: () => AudioTrackProcessorLike;
  /**
   * Optional factory for "Kendini dinle" (self-monitoring, see mic-monitor.ts) —
   * the platform's WebAudio playback of the local mic THROUGH the same capture
   * constraints + noise-filter worklet the publish uses, so the user can hear
   * what the Gürültü Engelleme tier actually does to their voice.
   *
   * Injected by the PLATFORM for the same reason as {@link createNoiseFilter}:
   * it needs getUserMedia + AudioContext + an <audio> sink, which the RN-safe
   * package root must not touch (web/Electron pass `createWebMicMonitor` from
   * `@demli/media/web`). Omit it and `setSelfMonitoring(true)` rejects with a
   * typed `monitor_unavailable` error instead of silently doing nothing.
   *
   * Called once per monitoring session (the instance is released on stop); while
   * a session is live the SAME instance is re-`start`ed on device / settings
   * changes rather than replaced.
   */
  createMicMonitor?: () => MicMonitor;
  /**
   * Optional tunables for the LOCAL speaking indicator (threshold + attack/
   * release hysteresis). Active only when the injected room adapter implements
   * `createLocalAudioMeter` (web/Electron); otherwise the local user's speaking
   * state falls back to the server's activeSpeakersChanged like everyone else.
   */
  speaking?: SpeakingDetectorOptions;
  /**
   * Persisted per-REMOTE-participant playback volumes (userId → 0..2), restored at
   * construction so a saved per-user level re-applies the
   * instant that user (re)joins — the same way device prefs survive a session. The
   * PLATFORM owns the persistence I/O (localStorage / AsyncStorage, keyed under
   * `PARTICIPANT_VOLUME_STORAGE_KEY`); the engine is the runtime source of truth
   * (§11). Values are normalized/clamped on the way in, so an untrusted blob is
   * safe. Omit for "everyone at 100%".
   */
  initialParticipantVolumes?: ParticipantVolumeMap;
  /**
   * Persisted per-SHARER SCREEN-SHARE (film) audio levels (userId → 0..2), the
   * separate-from-voice half of the voice/share volume split. Restored at
   * construction so a saved film level re-applies the instant that person's share
   * (its `screen_share_audio` track) arrives — livekit stores it per-source and
   * re-applies on subscribe. Same shape/normalizer/0-trap handling as
   * {@link initialParticipantVolumes}; the PLATFORM owns the I/O under
   * `SCREEN_SHARE_VOLUME_STORAGE_KEY`. Omit for "every share at 100%".
   */
  initialScreenShareVolumes?: ParticipantVolumeMap;
  /**
   * Injectable clock, used ONLY for the alone-idle deadline
   * ({@link VoiceState.aloneDeadlineAt}). Defaults to `Date.now`; tests pass a
   * fake so the three-minute window is exercised without waiting three minutes.
   */
  now?: () => number;
}

export interface VoiceEngine {
  getState(): VoiceState;
  /** Notified at most once per microtask with the latest state. */
  subscribe(listener: (state: VoiceState) => void): () => void;
  /**
   * Join a voice room. Two credential paths, ONE FSM (a call room IS a voice
   * room, ADR 0012 §2):
   *
   *  - GROUP VOICE CHANNEL (default): omit `credential`; the engine mints the
   *    token via the injected `fetchToken(roomChannelId)` (POST /media/token).
   *    Byte-for-byte the pre-existing behavior.
   *  - DM CALL (pre-minted): pass a `credential` ({@link VoiceJoinCredential} =
   *    `{ url, token }`) that the CALLER already obtained from POST /dm-calls
   *    (start → caller token, accept → callee token) — a call-room token is
   *    minted ONLY through that gated lifecycle, never `/media/token`. When it
   *    is present the engine SKIPS its `fetchToken` hop and connects with the
   *    supplied url+token directly. `roomChannelId` MUST be the call's LiveKit
   *    room name (`dmcall:<callId>` = `DmCall.roomName`) so `VoiceState.roomId`
   *    keys single-session eviction and reconnect on the SAME room string the
   *    server recorded (`recordAndEvict(userId, roomName)`).
   *
   * Everything after token acquisition — connect, device restore, mic publish,
   * speaking/quality probes, reconnect, single-session — is IDENTICAL for both
   * paths. Upgrade continuity (ADR 0012 §6) needs NO call here: when a DM call
   * upgrades to a group the two originals stay on this same LiveKit room, so the
   * engine keeps its live connection untouched — the client only re-points its
   * own occupancy/UI and never re-joins (see the media handoff note in the FSM
   * header).
   */
  join(roomChannelId: string, credential?: VoiceJoinCredential): Promise<void>;
  leave(): Promise<void>;
  /**
   * React to a single-active-session eviction from the realtime gateway
   * (`voice.session_replaced`): the user joined voice on another device/room, so
   * leave `evictedRoomId`. No-op unless we are actually in that room, so the
   * device that just joined ignores it. Ends cleanly at idle with
   * `endedReason: "session_replaced"` (a handoff, never an error). Idempotent with
   * the LiveKit eviction disconnect — whichever arrives first wins.
   */
  handleSessionReplaced(evictedRoomId: string): Promise<void>;
  /**
   * React to a server-authored voice disconnect (`voice.disconnected`), which
   * carries WHY: `alone` (last person in a DM call / group-DM voice channel for
   * the idle window) today, more reasons later.
   *
   * `roomKeys` is EVERY identity the server used to name the session — the SFU
   * room name AND the channel id — because the two are not always the same
   * string and the engine's `roomId` is whichever one the JOIN used. A voice
   * channel that resolves to a call room (`livekit_room = dmcall:<id>`, the
   * seamless-upgrade case, ADR 0012 §6) is joined by channel id while the server
   * reports the SFU room, so matching on one alone would silently miss it.
   *
   * Two jobs, because the SFU force-remove and this event race each other:
   *  - if we are still in one of `roomKeys`, leave cleanly and record `reason`;
   *  - if the SFU disconnect already ended the session (it lands as a generic
   *    eviction and defaults to `session_replaced`), REFINE the pending notice to
   *    the server's real reason, so the user is never told they "joined on
   *    another device" when they were actually alone.
   * A signal for any other room, or after the notice was acknowledged, is ignored.
   */
  handleForcedDisconnect(roomKeys: readonly string[], reason: VoiceEndedReason): Promise<void>;
  /** Clear the `endedReason` notice after the client has surfaced it (ack). */
  clearEndedReason(): void;
  /**
   * Tell the engine WHAT KIND of surface the current room is, so it knows whether
   * the server's alone-idle sweep applies (see alone-watch.ts). The engine cannot
   * know this by itself — it holds a room string, while the answer lives in the
   * group's `kind` — so the app resolves it and pushes it here.
   *
   * Call it with the resolved kind on join and whenever the resolution changes
   * (e.g. a DM call upgrading to a group). `null` means "not resolved", which —
   * like `server` and `unknown` — means NO countdown: a warning we are not sure
   * about is worse than no warning. Never affects media, only the deadline.
   */
  setSurfaceKind(kind: VoiceSurfaceKind | null): void;
  setMic(enabled: boolean): Promise<void>;
  setDeafened(deafened: boolean): Promise<void>;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  /**
   * Set the LISTENER's personal playback volume for one REMOTE participant, 0..2
   * (0=muted, 1=100% default, 2=200% boost) — the listener's per-user level.
   * Input is clamped to range. Client-side only: it scales that remote's own audio
   * elements; nothing crosses the SFU or the WebSocket gateway (§10/§35). Applied
   * LIVE when connected and NOT deafened (deafen is a master mute that wins — the
   * stored level is what undeafen restores). Stored (non-default levels only) so a
   * (re)joining participant gets the same level. Legal in any status; a no-op on
   * the local user's own row (you cannot attenuate yourself). Fire-and-forget:
   * synchronous, never throws.
   */
  setParticipantVolume(identity: string, volume: number): void;
  /** The stored personal playback volume for a participant (DEFAULT when unset). */
  getParticipantVolume(identity: string): number;
  /**
   * Set the LISTENER's personal volume for a remote's SCREEN-SHARE (film) audio,
   * 0..2 — SEPARATE from that person's voice ({@link setParticipantVolume}), so a
   * viewer can turn the movie up/down without changing how loud the sharer's mic
   * is (the voice-vs-share split). Input is clamped. Client-side only: it
   * scales that remote's `screen_share_audio` track alone; nothing crosses the SFU
   * or the WebSocket (§10/§35). Applied LIVE when connected and NOT deafened (deafen
   * is a master mute that wins; undeafen restores this level). Stored (non-default
   * only, 0 dropped on reload — the mute-trap guard) keyed by the sharer's userId so
   * a returning share gets the same level. Legal in any status; a no-op on the local
   * user. Fire-and-forget: synchronous, never throws.
   */
  setScreenShareVolume(identity: string, volume: number): void;
  /** The stored per-share (film) audio volume for a participant (DEFAULT when unset). */
  getScreenShareVolume(identity: string): number;
  /**
   * Select the preferred camera (videoinput) device. Stores
   * `selectedVideoDeviceId` and, while connected/reconnecting, forwards the
   * switch to the room (switchActiveDevice "videoinput"). Legal in any status
   * (like the mic/output device setters) so a preference can be set before join.
   * Rejects with a typed VoiceOperationError if the live switch fails.
   */
  setVideoDevice(deviceId: string): Promise<void>;
  /**
   * Turn the local camera on/off (task #18). Uses livekit's setCameraEnabled —
   * the SDK acquires+publishes the camera track (source `camera`). Independent of
   * the mic and of any screen share. Only legal while connected. Rejects with a
   * typed VoiceOperationError on permission-denied / no-device / publish failure
   * (state.error carries the user-facing message); the FSM stays connected.
   */
  setCamera(enabled: boolean): Promise<void>;
  /**
   * Set (or clear with null) the CHANNEL-configured mic publish bitrate in kbps
   * (M7c, owner-set). Combined with the user's audio settings via the HIGHER of
   * the two (see {@link configureAudio}). Applied to the NEXT mic publish (join,
   * or unmute after a mute) — a live mic track is not republished. Invalid values
   * (NaN/<=0) clear it.
   */
  setAudioBitrateKbps(kbps: number | null): void;
  /**
   * Apply the user's AUDIO settings (Ayarlar → Mikrofon): the processing/music
   * mode toggles become the mic CAPTURE constraints and the quality tier becomes
   * the mic bitrate (both resolved in audio-settings.ts, music mode overriding).
   * The voice-activity sensitivity re-tunes the local speaking detector live.
   *
   * The capture constraints + bitrate apply on the NEXT mic publish
   * (join / unmute). As a best-effort convenience, if the adapter supports
   * `restartAudioTrack` and the mic is live, the new capture constraints are also
   * re-applied to the CURRENT mic track (so Müzik Modu takes effect mid-call
   * without a rejoin). Safe to call in any status.
   */
  configureAudio(settings: AudioSettings): void;
  /**
   * Turn "Kendini dinle" (self-monitoring) on/off — play the local mic back
   * through the SAME capture constraints + noise-filter worklet the publish
   * uses, so the Gürültü Engelleme tier can be judged by ear (mic-monitor.ts).
   *
   * Legal in EVERY status. Inside a voice session it applies the anti-feedback
   * policy the founder asked for BEFORE opening the monitor — mute the mic and
   * deafen — and restores EXACTLY the previous mic/deafen state when turned off
   * (an already-muted or already-deafened user is left as they were). Outside a
   * session it is a plain preview and touches nothing else.
   *
   * The monitor is torn down on leave / disconnect / dispose, and re-armed on an
   * input-device, output-device or audio-settings change. Rejects with a typed
   * {@link VoiceOperationError} when the platform has no monitor
   * (`monitor_unavailable`) or the capture fails (permission / in-use / …).
   */
  setSelfMonitoring(enabled: boolean): Promise<void>;
  /**
   * Apply the user's VIDEO settings (Ayarlar → görüntü): the camera
   * quality/FPS becomes the camera CAPTURE constraints, applied on the NEXT
   * camera enable (`setCamera(true)`). The screen-share tier is consumed per-share
   * via {@link startScreenShare}'s options, so it is not stored here. Safe to call
   * in any status.
   */
  configureVideo(settings: VideoSettings): void;
  /**
   * Declare (`true`) or release (`false`) a source of sustained BACKGROUND
   * bandwidth use on this connection — a watch party's per-client video stream, a
   * large upload/download, a metered link. See bandwidth.ts for why this is a
   * general condition and not a per-feature flag.
   *
   * Sources are ref-counted by their opaque key, so concurrent consumers compose
   * and releasing one does not cancel another's. While ANY source is held the local
   * camera publishes at a reduced capture size + bitrate ceiling (freeing uplink,
   * the direction that actually hurts on an asymmetric home line) and the
   * screen-share adaptive controller may shed one tier further.
   *
   * AUDIO IS NEVER AFFECTED — not the bitrate, not the capture constraints, not a
   * subscription (§6: voice is priority #1, and mic bitrate is a rounding error
   * next to video anyway). Safe in any status; idempotent per source.
   */
  setBandwidthPressure(source: BandwidthPressureSource, active: boolean): void;
  /**
   * Pin (`"high"`) or release (`"auto"`) the preferred simulcast layer for a
   * REMOTE camera. Called by the UI when a camera is promoted to / removed from
   * the focus stage so the focused/fullscreen view pulls the sharp top layer while
   * small tiles stay on the bandwidth-friendly low layer (adaptiveStream). Safe in
   * any status; best-effort (a no-op when the platform can't select a layer).
   */
  setRemoteCameraQuality(identity: string, quality: "high" | "auto"): void;
  /**
   * Subscribe (`true`) or UNSUBSCRIBE (`false`) from a REMOTE camera's video
   * track. Called by the UI to release the bandwidth of a camera that is HIDDEN
   * (fullscreen PiP closed / camera strip collapsed): an unsubscribe tells the
   * SFU to stop forwarding the stream entirely — a stronger lever than the low
   * simulcast layer {@link setRemoteCameraQuality} pins. Re-subscribing resumes
   * it; the next `TrackSubscribed` re-seeds the camera snapshot. Safe in any
   * status; best-effort (a no-op when the platform can't toggle a subscription).
   */
  setRemoteCameraSubscribed(identity: string, subscribed: boolean): void;
  /**
   * Publish a screen share. `acquire` (caller-injected) returns the already-
   * captured tracks; the engine publishes them, wires OS-initiated track-end,
   * and flips `screenShareEnabled` / `screenShareHasAudio`. `options.quality`
   * selects the encoder preset (default "balanced"). Only legal while
   * connected. Rejects with a typed VoiceOperationError on acquire/publish
   * failure (state.error carries the user-facing message).
   */
  startScreenShare(
    acquire: AcquireScreenShare,
    options?: ScreenSharePublishOptions,
  ): Promise<void>;
  /** Stop the local screen share and unpublish its tracks. Cleanly returns to no-share. */
  stopScreenShare(): Promise<void>;
  /**
   * Replace the published share-audio track of a LIVE share without touching
   * the video, so the picture never blinks. Passing `null` drops the share
   * audio entirely (video-only).
   *
   * Only for an explicit action by the sharer. The desktop share-audio
   * supervisor must NOT call this to "find a better source": a silent source
   * usually just means play has not been pressed yet, and the sources such a
   * search used to find (system-mix inputs) carried the call's own voices back
   * to the other side (M16 H1).
   *
   * Returns true when the swap was applied. No-op (false) when no share is live,
   * we are not connected, or the track is already the published one, and a
   * stop/leave that lands while the swap is in flight wins: the new track is
   * never left published into a torn-down share. Publishes with the same music profile as
   * {@link startScreenShare} (`SCREEN_SHARE_AUDIO_PUBLISH`), so a swapped-in
   * track is never quietly downgraded to livekit's voice defaults.
   *
   * Resets `screenShareAudioLive` to false: a NEW source has not proven itself
   * yet, and only the supervisor may declare it audible.
   */
  replaceScreenShareAudio(track: MediaStreamTrack | null): Promise<boolean>;
  /**
   * The film-audio track currently published with the local share, or null.
   * Exposed so the platform's supervisor can watch the very track viewers
   * receive (rather than a copy that might diverge from it).
   */
  getLocalScreenShareAudioTrack(): MediaStreamTrack | null;
  /**
   * Report whether the published film audio has been observed carrying REAL
   * signal (the platform supervisor's verdict). Drives
   * `state.screenShareAudioLive` — the honest "viewers can hear the film" flag
   * the UI must use instead of `screenShareHasAudio` (§35). Ignored when no film
   * audio is published, so a late verdict cannot claim audio on a silent share.
   */
  setScreenShareAudioLive(live: boolean): void;
  /** Snapshot of active REMOTE screen shares (video tracks to render). Stable ref when unchanged. */
  getScreenShares(): RemoteScreenShare[];
  /** Subscribe to remote screen-share changes (useSyncExternalStore-compatible). */
  subscribeScreenShares(listener: (shares: RemoteScreenShare[]) => void): () => void;
  /** Snapshot of active REMOTE cameras (video tracks to render). Stable ref when unchanged. */
  getCameras(): RemoteCamera[];
  /** Subscribe to remote camera changes (useSyncExternalStore-compatible). */
  subscribeCameras(listener: (cameras: RemoteCamera[]) => void): () => void;
  /** Tear down everything (renderer unmount). Safe in any state. */
  dispose(): Promise<void>;
}

/** Programmer error: a command was issued in a status that does not allow it. */
export class InvalidVoiceCommandError extends Error {
  constructor(
    readonly command: VoiceCommand["type"],
    readonly status: VoiceStatus,
  ) {
    super(`Voice command ${command} is not allowed while ${status}.`);
    this.name = "InvalidVoiceCommandError";
  }
}

/** A command failed at the media layer; carries the typed, user-facing error. */
export class VoiceOperationError extends Error {
  constructor(readonly voiceError: VoiceError) {
    super(voiceErrorMessage(voiceError));
    this.name = "VoiceOperationError";
  }
}

const ALL_STATUSES: readonly VoiceStatus[] = [
  "idle",
  "joining",
  "connected",
  "reconnecting",
  "error",
  "leaving",
];

/** Which statuses each command is legal in (guard table for the FSM). */
export const COMMAND_ALLOWED_STATUSES: Readonly<
  Record<VoiceCommand["type"], readonly VoiceStatus[]>
> = {
  JOIN: ["idle", "error"],
  LEAVE: ["joining", "connected", "reconnecting", "error"],
  // Preference commands are legal everywhere; they only touch the room
  // when one is connected.
  SET_MIC: ALL_STATUSES,
  SET_DEAFENED: ALL_STATUSES,
  SET_INPUT_DEVICE: ALL_STATUSES,
  SET_OUTPUT_DEVICE: ALL_STATUSES,
  SET_VIDEO_DEVICE: ALL_STATUSES,
  // Per-user volume is a personal preference — legal everywhere; it only touches
  // a remote's playout when connected and not deafened.
  SET_PARTICIPANT_VOLUME: ALL_STATUSES,
  // "Kendini dinle" is a settings-level preview: legal with no room at all (the
  // common case — you are in Ayarlar tuning the noise tier) AND inside a session
  // (where it first mutes + deafens). So: everywhere.
  SET_SELF_MONITORING: ALL_STATUSES,
  // Milestone 4 — the stubs reject before these guards matter.
  START_SCREEN_SHARE: ["connected"],
  STOP_SCREEN_SHARE: ["connected"],
  // Camera (task #18): publishing a live camera track needs a live room, so —
  // like screen share — it is connected-only.
  SET_CAMERA: ["connected"],
};

/**
 * Map getUserMedia/device failures to typed §26 errors.
 *
 * EVERY branch carries the `device` it is about. Before this, the catch-all
 * returned a bare `{ kind: "device_unavailable" }` whose only message was the
 * MICROPHONE one — so a camera that failed to open on mobile web told the user
 * "Seçili ses aygıtı kullanılamıyor, ayarlardan başka bir aygıt seç" (the
 * founder's P0: wrong device, useless advice, and the real cause hidden).
 *
 * The two DOMException classes that catch-all was swallowing are now their own
 * kinds, because their fixes are completely different:
 *  - `NotReadableError` / `AbortError` → the OS gave the device to someone else.
 *    On mobile browsers the camera is effectively exclusive, so this is what a
 *    second acquire looks like while a preview still holds the first handle.
 *  - `OverconstrainedError` → the device is free but cannot do the requested
 *    resolution/frame-rate (a 1440p60 desktop preference on a phone's front
 *    camera). The caller can retry unconstrained; see `setCamera`.
 */
function mapAcquisitionError(
  err: unknown,
  device: MediaDeviceKind,
  fallbackDeviceId: string | null,
): VoiceError {
  const name = err instanceof Error ? err.name : "";
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError"
  ) {
    return { kind: "permission_denied", device };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    // `device` distinguishes "no camera" from "no microphone" in the message;
    // it stays absent for the mic so the pre-existing error shape is unchanged.
    return device === "camera"
      ? { kind: "device_not_found", device: "camera" }
      : { kind: "device_not_found" };
  }
  if (device !== "screen") {
    if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
      return { kind: "device_in_use", device };
    }
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return { kind: "device_constraints", device };
    }
  }
  return { kind: "device_unavailable", deviceId: fallbackDeviceId ?? "default", device };
}

/** True for the failure classes a RELAXED (unconstrained) retry can plausibly fix. */
function isConstraintFailure(error: VoiceError): boolean {
  return error.kind === "device_constraints" || error.kind === "device_unavailable";
}

function sameParticipant(a: VoiceParticipant, b: VoiceParticipant): boolean {
  return (
    a.identity === b.identity &&
    a.micEnabled === b.micEnabled &&
    a.speaking === b.speaking &&
    a.screenSharing === b.screenSharing &&
    a.cameraEnabled === b.cameraEnabled &&
    a.volume === b.volume &&
    a.deafened === b.deafened &&
    a.isLocal === b.isLocal
  );
}

/**
 * A REMOTE participant's deafen state, read from its LiveKit attribute
 * ({@link PARTICIPANT_ATTR.deafened} = "1" when deafened). Deafen is a
 * listener-side client state LiveKit does not model natively (§11); the peer
 * broadcasts it as an attribute and we re-derive on every attribute change / sync.
 */
function participantDeafened(p: ParticipantLike): boolean {
  return p.attributes?.[PARTICIPANT_ATTR.deafened] === "1";
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Normalize an untrusted mic bitrate preference; anything invalid → null. */
function normalizeAudioBitrate(kbps: number | null | undefined): number | null {
  return typeof kbps === "number" && Number.isFinite(kbps) && kbps > 0 ? kbps : null;
}

/**
 * How often the engine samples the connection-quality probe (ms). 1Hz keeps the
 * ping indicator fresh while never writing voice state more than once per second
 * (CLAUDE.md §27) — and a write only happens when the value actually changed.
 */
export const CONNECTION_QUALITY_POLL_MS = 1000;

/**
 * Publisher-uplink adaptive screen-share tuning (the "don't let a 2K60 stream choke a
 * home upload" controller). While a screen share is LIVE the engine watches the same
 * connection-quality probe that drives the ping indicator and nudges the EFFECTIVE
 * screen-share tier down/up the bitrate ladder — WITHOUT touching the user's SELECTED
 * tier. This is the real fix for the "start streaming → my ping spikes red → everyone
 * sees garbage" report: the root cause is the publisher's uplink bufferbloating when a
 * high encoder ceiling outruns a typical asymmetric home connection, so GCC never gets
 * a chance to converge. Capping the ceiling to what the uplink actually sustains keeps
 * the egress queue short — lower RTT for the publisher AND a clean (if lower-res)
 * picture for viewers, instead of a high-res stream that stutters for everyone.
 *
 * Timing is deliberately asymmetric with hysteresis so it settles instead of
 * oscillating: it drops FAST under sustained poor uplink and restores SLOWLY only once
 * the uplink has been healthy for a while. A single step per decision, best-effort — the
 * worst failure mode is a stream that sits one tier lower than ideal (stable), never a
 * broken share.
 */
/** Consecutive poor-uplink ticks (~s at 1 Hz) before dropping the screen-share tier a step. */
const ADAPTIVE_DOWN_TICKS = 4;
/** Consecutive healthy-uplink ticks before restoring a step toward the user's selection (slow, anti-oscillation). */
const ADAPTIVE_UP_TICKS = 10;
/** RTT (ms) at/above which the uplink counts as congested regardless of the coarse level. */
const ADAPTIVE_RTT_POOR_MS = 300;
/** RTT (ms) below which the uplink counts as healthy for the restore path. */
const ADAPTIVE_RTT_GOOD_MS = 120;
/**
 * The lowest tier the controller will drop to on its own — a floor so a bad-network
 * viewer still gets a usable picture rather than a 480p15 postage stamp. Clamped to the
 * user's selection too (never downgrade BELOW what they chose), so a user who picks a
 * low tier is left exactly there.
 */
const ADAPTIVE_SCREEN_SHARE_FLOOR: ScreenShareQuality = "720p30";

/** Compare two quality summaries (avoids spurious setState on unchanged ticks). */
function sameConnectionQuality(
  a: VoiceConnectionQuality,
  b: VoiceConnectionQuality,
): boolean {
  return a.level === b.level && a.rttMs === b.rttMs;
}

export function createVoiceEngine(options: VoiceEngineOptions): VoiceEngine {
  const createRoom = options.createRoom;
  const now = options.now ?? (() => Date.now());

  let state: VoiceState = { ...initialVoiceState };
  let room: VoiceRoomAdapter | null = null;
  let speakingIdentities = new Set<string>();
  let micBeforeDeafen = initialVoiceState.micEnabled;

  // ── alone-idle deadline (server's alone sweep, mirrored for the UI) ────────
  // WHAT KIND of room we are in, pushed in by the app (`setSurfaceKind`) because
  // the engine only ever sees a room string while the answer lives in the group's
  // `kind`. Starts null = "not resolved" = no countdown, which is the fail-safe
  // reading: a server voice channel is NEVER swept, so a warning shown there
  // would be a lie. Reset on every join so a stale kind can't leak into a new room.
  let surfaceKind: VoiceSurfaceKind | null = null;

  /**
   * The room whose SFU eviction produced the CURRENTLY PENDING `endedReason`.
   * Exists only so a `voice.disconnected` arriving a beat AFTER the force-remove
   * can still be matched to the session it explains (`state.roomId` is already
   * null by then) — see {@link handleForcedDisconnect}. Cleared on the next join.
   */
  let lastEvictedRoomId: string | null = null;

  // ── per-user playback volume (listener-side, per remote) ──────────────────
  // LISTENER-side per-remote playback levels (identity → 0..2). Only NON-default
  // (≠ 100%) levels are held, so the map stays small; an absent identity means
  // DEFAULT. Seeded from the persisted prefs (normalized) and re-applied to a
  // remote on (re)join so a saved level survives leave/rejoin. Client-side only —
  // it scales that remote's own audio playout, never the SFU/WebSocket (§10/§35).
  const participantVolumes = new Map<string, number>(
    Object.entries(normalizeParticipantVolumes(options.initialParticipantVolumes)),
  );

  // ── per-SHARE (screen-share / film) playback volume, separate from voice ──
  // The SEPARATE-from-voice half: identity → 0..2 for that sharer's screen_share_audio
  // track only. Same map/normalizer/0-trap as participantVolumes; applied via
  // RemoteParticipant.setVolume(v, "screen_share_audio") so it never touches their mic.
  const screenShareVolumes = new Map<string, number>(
    Object.entries(normalizeParticipantVolumes(options.initialScreenShareVolumes)),
  );

  // ── local speaking detection (task #54) ───────────────────────────────────
  // The local user's own green ring is computed ON-DEVICE from the mic level so
  // it reacts in ~one poll (~50ms) instead of waiting 1-2s for the SFU's
  // active-speaker round-trip. Remote participants stay server-driven.
  const localSpeakingDetector = createSpeakingDetector(options.speaking);
  /** Meter over the live local mic track; null when the adapter can't sample locally. */
  let localMeter: LocalAudioMeter | null = null;
  /** Poll handle for {@link pollLocalSpeaking}; null when not polling. */
  let speakingPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Committed local-speaking decision (mirrored into the local participant row). */
  let localSpeaking = false;
  /** True while a local meter is running — gates the override in toParticipant. */
  let localDetectionActive = false;

  // ── connection quality / ping (task #55) ──────────────────────────────────
  // A ~1s poll of the local connection quality + RTT, mirrored into
  // VoiceState.connectionQuality for the ping indicator. Like the speaking meter
  // it is an OPTIONAL adapter surface (createConnectionQualityProbe); when the
  // adapter omits it, quality stays UNKNOWN and the indicator hides.
  /** Probe over the live connection; null when the adapter can't sample it. */
  let qualityProbe: ConnectionQualityProbe | null = null;
  /** Poll handle for {@link pollConnectionQuality}; null when not polling. */
  let qualityPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by LEAVE/dispose so stale in-flight joins abort silently. */
  let commandEpoch = 0;
  /** CHANNEL-configured mic bitrate (kbps, M7c); null = no channel override. */
  let audioBitrateKbps: number | null = normalizeAudioBitrate(options.audioBitrateKbps);
  /** User AUDIO settings (Ayarlar → Mikrofon); null until configureAudio is called. */
  let audioSettings: AudioSettings | null = null;
  /** Resolved camera capture constraints (Kamera kalitesi/FPS); undefined = livekit default. */
  let cameraCaptureOptions: VideoCaptureOptionsLike | undefined;
  /** Resolved camera publish encoding (explicit bitrate ceiling); undefined = livekit default. */
  let cameraPublishOptions: VideoPublishOptionsLike | undefined;
  /**
   * True only while {@link reapplyLiveCamera} is unpublishing+republishing the
   * camera to apply a live settings change — so the intermediate camera unpublish
   * is NOT mistaken for an unexpected track-end (device unplugged).
   */
  let republishingCamera = false;
  /**
   * The screen-share (yayın) encoder tier currently in force. Tracked so a change
   * to Ayarlar → görüntü while a share is LIVE republishes the screen video with
   * the new `screenShareEncoding` (the founder's "change the stream quality while
   * broadcasting, apply instantly" rule) — mirrors how {@link configureVideo} live-
   * re-applies the camera. Set from {@link startScreenShare}'s option so it always
   * matches what is actually published, and updated by {@link configureVideo}.
   */
  let screenShareQuality: ScreenShareQuality = DEFAULT_SCREEN_SHARE_QUALITY;
  /**
   * Publisher-uplink adaptive cap (see the ADAPTIVE_* constants). `null` = publish the
   * user's SELECTED {@link screenShareQuality} unchanged; a non-null value is a LOWER
   * ladder tier the controller dropped to under sustained poor uplink (never above the
   * selection). The published tier is always {@link effectiveScreenShareQuality}.
   */
  let adaptiveScreenShareCap: ScreenShareQuality | null = null;
  /** Consecutive poor-uplink poll ticks (drives a downgrade at ADAPTIVE_DOWN_TICKS). */
  let adaptivePoorStreak = 0;
  /** Consecutive healthy-uplink poll ticks (drives a restore at ADAPTIVE_UP_TICKS). */
  let adaptiveGoodStreak = 0;

  // ── bandwidth pressure (bandwidth.ts) ─────────────────────────────────────
  /**
   * Ref-counted set of consumers currently declaring a heavy background transfer
   * on this connection (watch party, big download, …). Non-empty = constrained
   * mode: the camera publishes at the reduced tier and the screen-share adaptive
   * controller may shed one tier further. NEVER affects audio.
   *
   * Deliberately NOT part of {@link VoiceState} and NOT cleared on leave: this is
   * an AMBIENT app-level condition (a watch party keeps running while you hop
   * rooms), owned and reconciled by the app. Keeping it out of the FSM state also
   * removes a whole bug class — the leave/error paths reset state fields, and a
   * mirrored flag there would silently desync from this set.
   */
  const bandwidthPressureSources = new Set<BandwidthPressureSource>();

  /** True while any consumer holds bandwidth pressure. */
  function bandwidthConstrained(): boolean {
    return bandwidthPressureSources.size > 0;
  }

  /**
   * Camera CAPTURE constraints actually used for a publish — the constrained tier
   * while under pressure, otherwise the user's configured options.
   */
  function effectiveCameraCaptureOptions(): VideoCaptureOptionsLike | undefined {
    return bandwidthConstrained() ? constrainedCameraCaptureOptions() : cameraCaptureOptions;
  }

  /**
   * Camera PUBLISH options actually used for a publish. Under pressure the user's
   * resolved options are passed through {@link constrainedCameraPublishOptions},
   * which can only ever LOWER the ceiling (never raise a lighter selection).
   */
  function effectiveCameraPublishOptions(): VideoPublishOptionsLike | undefined {
    return bandwidthConstrained()
      ? constrainedCameraPublishOptions(cameraPublishOptions)
      : cameraPublishOptions;
  }

  /** True when the platform injected an RNNoise-style noise-filter factory (desktop). */
  const hasNoiseFilterFactory = typeof options.createNoiseFilter === "function";
  /** Whether an RNNoise processor is currently attached to the live mic track. */
  let noiseFilterActive = false;
  /**
   * Latched true when the worklet FAILED at runtime (WASM/CSP/load error). Once
   * broken we treat the filter as unavailable for the rest of the session, so the
   * `high` tier degrades to the built-in WebRTC NS instead of leaving NS off with a
   * dead worklet (which would be WORSE than standard). Reset on room release so a
   * rejoin can retry. Never surfaced as an error — High just quietly acts as Standard.
   */
  let noiseFilterBroken = false;

  /**
   * True when the factory is injected, the CURRENT room adapter can apply it, and the
   * worklet has not failed this session. Dynamic (checks the live `room`, created
   * per-join) — decides whether the `high` tier drops the built-in WebRTC NS (the
   * worklet does suppression) or keeps it as the fallback, and whether
   * {@link syncNoiseFilter} ever attaches a processor.
   */
  function noiseFilterAvailable(): boolean {
    return (
      hasNoiseFilterFactory && !noiseFilterBroken && typeof room?.applyNoiseFilter === "function"
    );
  }

  /**
   * Mic CAPTURE constraints for an arbitrary settings object (undefined = livekit
   * default). SERIALIZABLE — the shape used for change detection AND publish (the
   * RNNoise worklet is applied SEPARATELY via {@link syncNoiseFilter}, never through
   * capture options: livekit 2.x builds the mic track before its AudioContext is set,
   * so a capture-options processor throws "Audio context needs to be set"). Whether
   * a filter is AVAILABLE decides if the `high` tier drops the built-in WebRTC NS
   * (worklet will run) or keeps it as the fallback.
   */
  function micCaptureOptionsFrom(
    settings: AudioSettings | null,
  ): AudioCaptureOptionsLike | undefined {
    return settings
      ? audioCaptureOptionsForSettings(settings, {
          noiseFilterAvailable: filterCapableForSettings(settings),
        })
      : undefined;
  }

  /** Whether the injected factory + adapter can actually run a filter for these settings. */
  function filterCapableForSettings(settings: AudioSettings | null): boolean {
    return !!settings && noiseFilterAvailable() && wantsNoiseFilter(settings);
  }

  /**
   * Attach or detach the RNNoise worklet on the LIVE mic to match the current NS
   * tier — the real "Yüksek" tier. Runs AFTER a mic publish (join / unmute /
   * republish) so the LocalAudioTrack exists and livekit has set its AudioContext
   * (avoiding the capture-options throw). Idempotent via {@link noiseFilterActive};
   * best-effort — a worklet failure leaves the built-in WebRTC NS fallback in place
   * (the mic keeps working, never silent). No-op unless the adapter supports it.
   */
  async function syncNoiseFilter(): Promise<void> {
    const apply = room?.applyNoiseFilter;
    if (!apply || !options.createNoiseFilter) return;
    const want =
      state.status === "connected" &&
      state.micEnabled &&
      noiseFilterAvailable() &&
      !!audioSettings &&
      wantsNoiseFilter(audioSettings);
    if (want === noiseFilterActive) return;
    try {
      await apply.call(room, want ? options.createNoiseFilter() : null);
      noiseFilterActive = want;
    } catch {
      // The worklet failed (missing WASM/CSP/asset). Latch it broken and re-publish
      // the mic so the built-in WebRTC NS comes back ON — High degrades to Standard
      // rather than sitting with NS off and a dead worklet (worse than Standard).
      noiseFilterActive = false;
      if (want) await recoverFromBrokenNoiseFilter();
    }
  }

  /**
   * Fall back from a failed `high` worklet to the built-in WebRTC NS. Latches the
   * filter broken (so the capture resolver now turns browser NS back on) and
   * re-publishes the live mic with that fallback capture. Best-effort; no worklet
   * re-attach (we do NOT call syncNoiseFilter here), so it can't loop.
   */
  async function recoverFromBrokenNoiseFilter(): Promise<void> {
    noiseFilterBroken = true;
    if (
      !room?.republishMicTrack ||
      state.status !== "connected" ||
      !state.micEnabled
    ) {
      return;
    }
    try {
      await room.republishMicTrack(resolveMicCaptureOptions(), resolveMicPublishOptions());
    } catch {
      // Best-effort — the fallback NS applies on the next unmute / rejoin regardless.
    }
  }

  /**
   * Mic PUBLISH options (bitrate + Opus RED/DTX/stereo) for an arbitrary settings
   * object. With user settings we build the FULL rich options (audio-settings.ts);
   * without settings we keep the legacy channel-bitrate-only path (snap to a
   * preset step) so the pre-settings behavior — and its tests — are unchanged.
   */
  function micPublishOptionsFrom(
    settings: AudioSettings | null,
  ): MicPublishOptionsLike | undefined {
    if (settings) return micPublishOptionsForSettings(audioBitrateKbps, settings);
    const kbps = resolveMicBitrateKbps(audioBitrateKbps, null);
    return kbps == null ? undefined : { audioPreset: micAudioPresetForBitrate(kbps) };
  }

  /** Resolved mic CAPTURE constraints from CURRENT settings (processor applied separately). */
  function resolveMicCaptureOptions(): AudioCaptureOptionsLike | undefined {
    return micCaptureOptionsFrom(audioSettings);
  }

  /** Resolved mic PUBLISH options (bitrate + codec) from the CURRENT settings. */
  function resolveMicPublishOptions(): MicPublishOptionsLike | undefined {
    return micPublishOptionsFrom(audioSettings);
  }

  /**
   * setMicrophoneEnabled honouring the mic CAPTURE constraints (audio processing
   * / music mode) and PUBLISH bitrate. The extra arguments are passed ONLY when a
   * preference is configured, so the default publish path (no channel bitrate, no
   * user settings) stays byte-for-byte the pre-settings behavior (single arg). The
   * RNNoise worklet (Yüksek tier) is applied AFTER this via {@link syncNoiseFilter},
   * not through capture options — see its docstring for why.
   */
  async function setRoomMic(target: VoiceRoomAdapter, enabled: boolean): Promise<unknown> {
    const capture = resolveMicCaptureOptions();
    const publish = resolveMicPublishOptions();
    const result =
      !capture && !publish
        ? await target.localParticipant.setMicrophoneEnabled(enabled)
        : await target.localParticipant.setMicrophoneEnabled(enabled, capture, publish);
    // Match the worklet to the tier once the track (or its removal) has settled.
    await syncNoiseFilter();
    return result;
  }

  // ── "Kendini dinle" / self-monitoring (mic-monitor.ts) ────────────────────

  /** The live monitor instance; null when monitoring has never started / was stopped. */
  let micMonitor: MicMonitor | null = null;
  /**
   * The mic/deafen state saved when monitoring suppressed it, so turning
   * monitoring off restores EXACTLY that. Null when nothing is suppressed (never
   * started, or started outside a voice session where there is nothing to mute).
   */
  let monitorSnapshot: MonitorAudioSnapshot | null = null;
  /**
   * True only while the monitor itself is driving setMic/setDeafened. Without it
   * the "user unmuted → stop monitoring" guard below would fire on our OWN
   * suppression/restore calls and immediately cancel the feature.
   */
  let monitorSuppressing = false;

  /** True while a session is live/being established — i.e. the mic can be hot. */
  function inVoiceSession(): boolean {
    return (
      state.status === "joining" ||
      state.status === "connected" ||
      state.status === "reconnecting"
    );
  }

  /**
   * The noise-filter factory the MONITOR should use, or null.
   *
   * Deliberately NOT {@link filterCapableForSettings}: that one also requires a
   * live room adapter (`room.applyNoiseFilter`), because the publish path can
   * only run a worklet on a published track. The monitor owns its own graph, so
   * it can run the worklet with no room at all — which is the primary use case
   * (sitting in Ayarlar comparing Yüksek against Standart). It still honours the
   * broken-worklet latch, so a filter that failed once is not retried into
   * silence.
   */
  function monitorFilterFactory(): (() => AudioTrackProcessorLike) | null {
    if (!options.createNoiseFilter || noiseFilterBroken) return null;
    return audioSettings && wantsNoiseFilter(audioSettings)
      ? options.createNoiseFilter
      : null;
  }

  /**
   * The monitor's capture + filter configuration, derived from the SAME resolvers
   * the publish uses so what the user hears matches what the far end gets. The
   * capture constraints are recomputed with the monitor's own filter capability
   * (see {@link monitorFilterFactory}) so the `high` tier drops the built-in
   * WebRTC NS here exactly like it does on the publish.
   */
  function micMonitorConfig(): MicMonitorConfig {
    const createNoiseFilter = monitorFilterFactory();
    return {
      capture: audioSettings
        ? audioCaptureOptionsForSettings(audioSettings, {
            noiseFilterAvailable: createNoiseFilter !== null,
          })
        : undefined,
      inputDeviceId: state.selectedInputDeviceId,
      outputDeviceId: state.selectedOutputDeviceId,
      createNoiseFilter,
    };
  }

  /**
   * Mute + deafen before opening the monitor (the founder's anti-feedback rule),
   * remembering what to put back. No-op outside a voice session — there is no
   * live mic to loop and nothing to restore — and no-op when already suppressed.
   * Throws through if the mute/deafen fails, so monitoring never opens over a
   * still-hot mic.
   */
  async function suppressForMonitoring(): Promise<void> {
    if (!inVoiceSession() || monitorSnapshot) return;
    const saved: MonitorAudioSnapshot = {
      micEnabled: state.micEnabled,
      deafened: state.deafened,
    };
    const plan = monitorSuppressionPlan(saved);
    monitorSnapshot = saved;
    monitorSuppressing = true;
    try {
      if (plan.deafen) await setDeafened(true);
      else if (plan.mute) await setMic(false);
    } catch (err) {
      // Suppression failed, so monitoring will not open. Drop the snapshot too —
      // a snapshot with no monitor behind it would later "restore" a state the
      // user never left, silently changing their mic out from under them.
      monitorSnapshot = null;
      throw err;
    } finally {
      monitorSuppressing = false;
    }
  }

  /**
   * Put the mic/deafen state back the way it was before monitoring suppressed
   * it. The DECISION lives in the pure {@link monitorRestorePlan} (unit-tested);
   * this only executes it. Best-effort — a failed restore must not leave the
   * caller with a rejected promise on the way out of a feature they just closed.
   */
  async function releaseMonitorSuppression(): Promise<void> {
    const saved = monitorSnapshot;
    monitorSnapshot = null;
    // Nothing saved, or the session ended underneath us (leave/disconnect already
    // reset the audio state) — there is nothing meaningful to restore into.
    if (!saved || !inVoiceSession()) return;
    const plan = monitorRestorePlan(saved, {
      micEnabled: state.micEnabled,
      deafened: state.deafened,
    });
    monitorSuppressing = true;
    try {
      if (plan.undeafen) await setDeafened(false);
      if (plan.mic !== null) await setMic(plan.mic);
    } catch {
      // Best-effort — the user can always toggle mic/deafen themselves.
    } finally {
      monitorSuppressing = false;
    }
  }

  /**
   * Stop the monitor and release its capture (the OS mic indicator clears here).
   * `restore` decides whether the pre-monitor mic/deafen state is put back — true
   * when the USER turned monitoring off, false when the session is going away
   * (leave/disconnect/dispose) or the user's own unmute superseded the snapshot.
   */
  async function stopSelfMonitoring(restore: boolean): Promise<void> {
    const monitor = micMonitor;
    micMonitor = null;
    if (monitor) {
      try {
        await monitor.stop();
      } catch {
        // Best-effort teardown — never block the caller on a dead audio graph.
      }
    }
    setState({ selfMonitoring: false });
    if (restore) await releaseMonitorSuppression();
    else monitorSnapshot = null;
  }

  /**
   * Re-arm a RUNNING monitor against the current config (input/output device or
   * audio settings changed). Fire-and-forget: a failed re-arm stops monitoring
   * cleanly and restores the audio state rather than leaving the user listening
   * to a stale chain that no longer reflects their settings (which would be the
   * exact lie this feature exists to avoid).
   */
  function rearmSelfMonitoring(): void {
    const monitor = micMonitor;
    if (!state.selfMonitoring || !monitor) return;
    void monitor.start(micMonitorConfig()).catch(() => {
      void stopSelfMonitoring(true);
    });
  }

  async function setSelfMonitoring(enabled: boolean): Promise<void> {
    guard("SET_SELF_MONITORING");
    if (enabled === state.selfMonitoring) return;
    if (!enabled) {
      await stopSelfMonitoring(true);
      return;
    }
    const create = options.createMicMonitor;
    if (!create) {
      const error: VoiceError = { kind: "monitor_unavailable" };
      setState({ error });
      throw new VoiceOperationError(error);
    }
    // Silence the outgoing path FIRST so the speakers can never feed the live
    // mic, then open the monitor. Order matters: the reverse would broadcast a
    // feedback loop for as long as the capture takes to come up.
    await suppressForMonitoring();
    const monitor = micMonitor ?? create();
    micMonitor = monitor;
    try {
      await monitor.start(micMonitorConfig());
    } catch (err) {
      micMonitor = null;
      try {
        await monitor.stop();
      } catch {
        // Best-effort — start() already promises to leave nothing running.
      }
      await releaseMonitorSuppression();
      const mapped = mapAcquisitionError(err, "microphone", state.selectedInputDeviceId);
      setState({ error: mapped });
      throw new VoiceOperationError(mapped);
    }
    setState({ selfMonitoring: true, error: null });
  }

  /** The local screen share we published (null when not sharing). */
  let localScreenShare: {
    video: MediaStreamTrack;
    audio: MediaStreamTrack | null;
    /** Bound to the video track's `ended` event to catch OS-initiated stops. */
    onVideoEnded: () => void;
  } | null = null;

  /** Live remote screen-share video tracks, keyed by participant identity. */
  const remoteScreenShares = new Map<string, RemoteScreenShare>();
  /** Cached snapshot — rebuilt only when the map changes (stable for useSyncExternalStore). */
  let screenShareSnapshot: RemoteScreenShare[] = [];
  const screenShareListeners = new Set<(shares: RemoteScreenShare[]) => void>();

  /** Live remote CAMERA video tracks (task #18), keyed by participant identity. */
  const remoteCameras = new Map<string, RemoteCamera>();
  /** Cached snapshot — rebuilt only when the map changes (stable for useSyncExternalStore). */
  let cameraSnapshot: RemoteCamera[] = [];
  const cameraListeners = new Set<(cameras: RemoteCamera[]) => void>();

  const listeners = new Set<(s: VoiceState) => void>();
  let notifyScheduled = false;

  function scheduleNotify(): void {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      const snapshot = state;
      for (const listener of listeners) listener(snapshot);
    });
  }

  /** Immutable update; skips (and does not notify) when nothing changed. */
  function setState(patch: Partial<VoiceState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof VoiceState)[]) {
      if (state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    scheduleNotify();
  }

  function guard(command: VoiceCommand["type"]): void {
    if (!COMMAND_ALLOWED_STATUSES[command].includes(state.status)) {
      throw new InvalidVoiceCommandError(command, state.status);
    }
  }

  // ── participants ────────────────────────────────────────────────────────

  function toParticipant(p: ParticipantLike, isLocal: boolean): VoiceParticipant {
    return {
      userId: p.identity, // token contract: identity IS the userId
      identity: p.identity,
      micEnabled: p.isMicrophoneEnabled,
      // Local user: on-device level (instant). Remotes (and local fallback when
      // no meter): the SFU's activeSpeakersChanged set. (task #54)
      speaking:
        isLocal && localDetectionActive
          ? localSpeaking
          : speakingIdentities.has(p.identity),
      // Local: our authoritative screen-share flag. Remote: whether we actually
      // hold a subscribed screen-share track to render (in sync with the badge).
      screenSharing: isLocal ? state.screenShareEnabled : remoteScreenShares.has(p.identity),
      // Camera (task #18), same derivation as screenSharing but a SEPARATE track.
      // Local: our authoritative camera flag. Remote: whether we hold a
      // subscribed camera track to render (in sync with the camera tile).
      cameraEnabled: isLocal ? state.cameraEnabled : remoteCameras.has(p.identity),
      // Per-user "User Volume": the local user is always 100% (you can't attenuate
      // yourself); remotes carry the listener's stored personal level (default 100%).
      volume: isLocal ? DEFAULT_PARTICIPANT_VOLUME : participantVolume(p.identity),
      // Deafen (§11): local mirrors our own flag; a remote is read from the deafen
      // attribute it broadcast (headphone-off badge). LiveKit doesn't model deafen,
      // so this is the one cross-participant signal for it.
      deafened: isLocal ? state.deafened : participantDeafened(p),
      isLocal,
    };
  }

  // ── remote screen shares (imperative subscription, not reactive state) ─────

  /** Rebuild the cached snapshot and notify screen-share subscribers. */
  function notifyScreenShares(): void {
    screenShareSnapshot = Array.from(remoteScreenShares.values());
    const snapshot = screenShareSnapshot;
    for (const listener of screenShareListeners) listener(snapshot);
  }

  /** Rebuild the cached camera snapshot and notify camera subscribers (task #18). */
  function notifyCameras(): void {
    cameraSnapshot = Array.from(remoteCameras.values());
    const snapshot = cameraSnapshot;
    for (const listener of cameraListeners) listener(snapshot);
  }

  function stopTrack(track: MediaStreamTrack | null | undefined): void {
    if (!track) return;
    try {
      track.stop();
    } catch {
      // Best-effort: a track may already be ended.
    }
  }

  /**
   * Rebuild the participants array from the room, reusing previous row
   * objects (and the previous array) when nothing changed, so speaking
   * ticks stay cheap for the UI (CLAUDE.md §27).
   */
  function syncParticipants(): void {
    if (!room) {
      if (state.participants.length > 0) setState({ participants: [] });
      return;
    }
    const fresh: VoiceParticipant[] = [toParticipant(room.localParticipant, true)];
    for (const remote of room.remoteParticipants.values()) {
      fresh.push(toParticipant(remote, false));
    }
    const prev = state.participants;
    let changed = prev.length !== fresh.length;
    const merged = fresh.map((next, i) => {
      const old = prev[i];
      if (old && sameParticipant(old, next)) return old;
      changed = true;
      return next;
    });
    if (changed) setState({ participants: merged });
    refreshAloneDeadline();
  }

  /**
   * Recompute {@link VoiceState.aloneDeadlineAt} from (surface kind × status ×
   * who is in the room). Called from every place those three can change:
   * participant sync, the surface resolution arriving, join, leave, disconnect.
   *
   * Three rules, in order:
   *  1. NOT an ejectable surface (server voice channel, unknown, unresolved) ⇒
   *     null. The server never sweeps those, so we never warn about them.
   *  2. Not live in a room (idle/joining/leaving/error), or somebody else is here
   *     ⇒ null. This is the "someone joined, warning disappears instantly" path,
   *     and it also RESTARTS the window from a full three minutes if they leave
   *     again, exactly like the server's own `aloneSince` bookkeeping.
   *  3. Alone and live ⇒ keep the EXISTING deadline if there is one (an unrelated
   *     participant update must not push the deadline forward and make the
   *     countdown stall), otherwise start one at now + the grace window.
   *
   * `reconnecting` deliberately counts as live and keeps the deadline: the SFU
   * still holds the room, so the server's clock is still running on us.
   */
  function refreshAloneDeadline(): void {
    if (!isAloneEjectableSurface(surfaceKind)) {
      setState({ aloneDeadlineAt: null });
      return;
    }
    const live = state.status === "connected" || state.status === "reconnecting";
    const alone = state.participants.filter((p) => !p.isLocal).length === 0;
    if (!live || !alone) {
      setState({ aloneDeadlineAt: null });
      return;
    }
    if (state.aloneDeadlineAt !== null) return;
    setState({ aloneDeadlineAt: now() + ALONE_GRACE_MS });
  }

  /**
   * Has our own alone window already elapsed? Used ONLY to attribute an eviction
   * disconnect: when the SFU removes us right after the countdown ran out, the
   * cause is the server's alone sweep, not another device taking over the session
   * — and telling the user the wrong one of those is exactly the kind of scary,
   * inaccurate copy §26 forbids.
   *
   * A plain 1-1 DM call needs this: the server ejects the lone participant there
   * but signals the call's end through `call.ended`, so no `voice.disconnected`
   * arrives to name the reason and the local deadline is the only evidence.
   */
  function aloneWindowElapsed(): boolean {
    return state.aloneDeadlineAt !== null && now() >= state.aloneDeadlineAt;
  }

  /** The listener's stored personal volume for a participant (DEFAULT when none). */
  function participantVolume(identity: string): number {
    return participantVolumes.get(identity) ?? DEFAULT_PARTICIPANT_VOLUME;
  }

  /** The listener's stored per-SHARE (film) audio volume for a sharer (DEFAULT when none). */
  function screenShareVolume(identity: string): number {
    return screenShareVolumes.get(identity) ?? DEFAULT_PARTICIPANT_VOLUME;
  }

  /**
   * The volume to actually push to a remote's playout: deafen (a master mute)
   * forces 0 for everyone; otherwise it is the listener's personal per-user level
   * for that remote. Keeping deafen and per-user volume in one resolver
   * is what makes them compose — deafen wins live, undeafen restores the level.
   */
  function effectiveVolume(identity: string, deafened: boolean): number {
    return deafened ? 0 : participantVolume(identity);
  }

  /** Same composition for the per-SHARE (film) audio: deafen → 0, else the stored level. */
  function effectiveScreenShareVolume(identity: string, deafened: boolean): number {
    return deafened ? 0 : screenShareVolume(identity);
  }

  /**
   * Best-effort push of ONE remote's playout volume for ONE source. livekit's
   * `RemoteParticipant.setVolume` CAN throw: on the web path it forwards to the
   * `<audio>` element's `volume` setter, which raises `IndexSizeError` for any
   * value outside [0,1] — i.e. a per-user BOOST above 100% (our range is 0..2) —
   * and a publication mid-teardown can reject too. An UNGUARDED throw here is
   * load-bearing, NOT cosmetic: it aborts the `applyRemoteVolumes` loop (silencing
   * every remote AFTER the offender) and, on JOIN, escapes `applyRemoteVolumes`
   * BEFORE `applyMicPreference()` runs — so the LOCAL mic never publishes and peers
   * hear nothing. Swallow it per (remote, source) so one participant's playout can
   * never silence the room or wedge the join (§11/§26); the value that failed to
   * apply is re-tried on the next join / reconnect / deafen toggle.
   */
  function safeSetVolume(
    remote: RemoteParticipantLike,
    volume: number,
    source?: RemoteAudioSourceLike,
  ): void {
    try {
      remote.setVolume(volume, source);
    } catch {
      // best-effort — a per-remote playout throw must never cascade (see above).
    }
  }

  /**
   * Push the effective playout volume to every remote — deafen forces 0, otherwise
   * each remote's personal per-user level. Called on join, reconnect, and
   * deafen/undeafen. Web path: livekit's volumeMap re-applies the value to any
   * audio track that arrives later; ParticipantConnected re-applies it explicitly
   * too, so a late joiner is covered by both.
   *
   * Applies the VOICE (microphone) level AND the SEPARATE per-share (screen_share_
   * audio) level, each to its own source. This is also what makes DEAFEN silence a
   * remote's FILM audio, not just their voice: livekit's `setVolume` defaults to the
   * microphone source, so before this a deafened desktop user still heard the movie.
   */
  function applyRemoteVolumes(deafened: boolean): void {
    if (!room) return;
    for (const remote of room.remoteParticipants.values()) {
      // Each source guarded INDEPENDENTLY: a throw applying the film level must not
      // skip the mic level (or vice-versa), and neither may skip the NEXT remote.
      safeSetVolume(remote, effectiveVolume(remote.identity, deafened));
      const shareVolume = effectiveScreenShareVolume(remote.identity, deafened);
      safeSetVolume(remote, shareVolume, TRACK_SOURCE.ScreenShareAudio);
      // RN native-playout parallel for the FILM track (see setScreenShareVolume).
      room.setRemoteScreenShareVolume?.(remote.identity, shareVolume);
    }
    // RN path: remote audio is rendered NATIVELY, so the per-element setVolume
    // above never reaches the playout — deafen did nothing. The RN adapter mutes
    // the actual subscription for current AND future remotes (voice + film audio);
    // the web adapter omits this hook (its setVolume already worked). Per-user
    // volume on the native playout is the mobile wave's concern.
    room.setRemoteAudioMuted?.(deafened);
  }

  /**
   * Broadcast the LOCAL deafen flag to peers as a LiveKit participant ATTRIBUTE
   * ({@link PARTICIPANT_ATTR.deafened} = "1" deafened / "" cleared). Deafen is a
   * listener-side client state LiveKit does not model natively (§11), so the badge
   * on peers rides this attribute; peers pick it up via `ParticipantAttributesChanged`.
   *
   * Best-effort and FIRE-AND-FORGET: a failure never affects LOCAL deafen (remote
   * playback is already silenced by {@link applyRemoteVolumes}); the only cost is a
   * peer's badge lagging, which the next re-assert (join / reconnect / toggle) heals.
   * A no-op when the adapter can't publish attributes. Wrapped in Promise.resolve so
   * a synchronous throw or a non-promise return can never escape.
   */
  function publishDeafenedAttribute(deafened: boolean): void {
    const target = room;
    const publish = target?.setLocalAttribute;
    if (!target || !publish) return;
    void Promise.resolve()
      .then(() => publish.call(target, PARTICIPANT_ATTR.deafened, deafened ? "1" : ""))
      .catch(() => {
        // best-effort — deafen is local-first; the peer badge is not load-bearing.
      });
  }

  /** Reconcile the published mic track with the user's current preference. */
  async function applyMicPreference(): Promise<void> {
    if (!room || state.status !== "connected") return;
    const want = state.micEnabled;
    if (room.localParticipant.isMicrophoneEnabled === want) return;
    try {
      await setRoomMic(room, want);
    } catch (err) {
      // Stay connected (listen-only); surface the typed error (§26).
      setState({
        micEnabled: false,
        error: mapAcquisitionError(err, "microphone", state.selectedInputDeviceId),
      });
    }
  }

  // ── local speaking detection ──────────────────────────────────────────────

  /**
   * One poll tick: sample the local mic level and update the local-speaking
   * decision. Forces silent (instantly, no release delay) whenever we are not
   * connected or the mic is disabled — so muting drops the ring immediately.
   */
  function pollLocalSpeaking(): void {
    if (!localMeter) return;
    let next: boolean;
    if (state.status !== "connected" || !state.micEnabled) {
      localSpeakingDetector.reset();
      next = false;
    } else {
      next = localSpeakingDetector.push(localMeter.level(), Date.now());
    }
    if (next !== localSpeaking) {
      localSpeaking = next;
      syncParticipants();
    }
  }

  /** Begin on-device local-speaking detection if the adapter supports it. */
  function startLocalSpeaking(): void {
    stopLocalSpeaking(); // idempotent — never double-run a timer
    if (!room || typeof room.createLocalAudioMeter !== "function") return;
    const meter = room.createLocalAudioMeter();
    if (!meter) return;
    localMeter = meter;
    localDetectionActive = true;
    localSpeaking = false;
    localSpeakingDetector.reset();
    speakingPollTimer = setInterval(pollLocalSpeaking, LOCAL_SPEAKING_POLL_MS);
  }

  /** Stop detection and release the meter (leave/dispose/disconnect). */
  function stopLocalSpeaking(): void {
    if (speakingPollTimer !== null) {
      clearInterval(speakingPollTimer);
      speakingPollTimer = null;
    }
    if (localMeter) {
      try {
        localMeter.close();
      } catch {
        // Best-effort — the audio context may already be closed.
      }
      localMeter = null;
    }
    localDetectionActive = false;
    localSpeaking = false;
    localSpeakingDetector.reset();
  }

  // ── connection quality / ping (task #55) ──────────────────────────────────

  /**
   * One poll tick: read the probe and mirror a throttled summary into state.
   * Quality is meaningful only while `connected` — in any other status (joining,
   * reconnecting, leaving, error) we report UNKNOWN so a stale RTT never lingers
   * on the indicator. Writes only when the value actually changed (§27).
   */
  function pollConnectionQuality(): void {
    if (!qualityProbe) return;
    let next: VoiceConnectionQuality;
    if (state.status === "connected") {
      const level: ConnectionQualityLevel = qualityProbe.level();
      const rttMs = qualityProbe.rttMs();
      next =
        level === "unknown" && rttMs === null
          ? UNKNOWN_CONNECTION_QUALITY
          : { level, rttMs };
    } else {
      next = UNKNOWN_CONNECTION_QUALITY;
    }
    // Drive the publisher-uplink adaptive screen-share controller off the SAME reading
    // every tick (not only when the throttled state value changes) — it needs the raw
    // per-second signal to count sustained streaks. No-op unless a share is live.
    adaptScreenShareToUplink(next);
    if (!sameConnectionQuality(state.connectionQuality, next)) {
      setState({ connectionQuality: next });
    }
  }

  /**
   * The screen-share tier actually PUBLISHED: the adaptive cap when the uplink
   * controller has lowered it, otherwise the user's selected {@link screenShareQuality}.
   */
  function effectiveScreenShareQuality(): ScreenShareQuality {
    return adaptiveScreenShareCap ?? screenShareQuality;
  }

  /** Reset the adaptive screen-share controller (new selection / new or ended share). */
  function resetAdaptiveScreenShare(): void {
    adaptiveScreenShareCap = null;
    adaptivePoorStreak = 0;
    adaptiveGoodStreak = 0;
  }

  /**
   * The lowest tier the adaptive controller may drop to right now. Under bandwidth
   * pressure the link genuinely has less headroom than the normal floor assumes, so
   * the controller is allowed one tier further down. Pressure alone never moves the
   * tier — only the RTT-driven controller does.
   */
  function adaptiveScreenShareFloor(): ScreenShareQuality {
    return bandwidthConstrained()
      ? PRESSURE_SCREEN_SHARE_FLOOR
      : ADAPTIVE_SCREEN_SHARE_FLOOR;
  }

  /**
   * Declare (or release) a source of sustained background bandwidth use — see
   * bandwidth.ts for why this is a general CONDITION rather than a watch-party flag.
   *
   * Ref-counted by `source`, so concurrent consumers compose and releasing one does
   * not cancel another's pressure. Only the empty↔non-empty EDGE does any work: a
   * live camera is republished at (or restored from) the constrained tier, which is
   * the same unpublish+republish path a settings change already uses. Audio is never
   * touched. Safe in any status — outside a session it just records the condition and
   * the next camera publish picks it up.
   */
  function setBandwidthPressure(source: BandwidthPressureSource, active: boolean): void {
    const key = typeof source === "string" ? source.trim() : "";
    if (!key) return; // an unnamed source could never be released — ignore it
    const before = bandwidthConstrained();
    if (active) bandwidthPressureSources.add(key);
    else bandwidthPressureSources.delete(key);
    const after = bandwidthConstrained();
    if (before === after) return;

    // Re-publish a LIVE camera at the new tier so the change applies mid-call
    // (mirrors configureVideo's live re-apply). A camera that is off simply picks
    // the right options up at its next enable.
    if (room && state.status === "connected" && state.cameraEnabled) {
      void reapplyLiveCamera();
    }
    // The screen-share floor just moved. Releasing pressure can leave the cap BELOW
    // the (now higher) floor, so re-clamp; the controller restores the rest slowly.
    if (localScreenShare) clampAdaptiveScreenShareToFloor();
  }

  /**
   * Re-clamp the adaptive cap into the CURRENT floor..selection window after the
   * floor moved (a pressure change). Republishes only when the tier actually moves.
   */
  function clampAdaptiveScreenShareToFloor(): void {
    if (adaptiveScreenShareCap === null) return;
    const ladder = SCREEN_SHARE_QUALITIES;
    const selectedIdx = ladder.indexOf(screenShareQuality);
    if (selectedIdx < 0) return;
    const floorIdx = Math.min(ladder.indexOf(adaptiveScreenShareFloor()), selectedIdx);
    const currentIdx = ladder.indexOf(adaptiveScreenShareCap);
    const nextIdx = Math.max(floorIdx, Math.min(selectedIdx, currentIdx));
    if (nextIdx === currentIdx) return;
    const nextQuality = ladder[nextIdx];
    if (!nextQuality) return;
    adaptiveScreenShareCap = nextQuality === screenShareQuality ? null : nextQuality;
    void reapplyLiveScreenShare();
  }

  /**
   * Move the EFFECTIVE screen-share tier one step DOWN (`-1`) or UP (`+1`) the
   * bitrate-ordered ladder, clamped to `[floor, user selection]`. Restoring exactly to
   * the user's selection clears the cap (back to "publish what they chose"). Returns
   * true and republishes the live screen video when the tier actually moves. The
   * republish swaps only the encoder ceiling on the SAME captured track (see
   * {@link reapplyLiveScreenShare}) — capture/OS-share indicator/film audio are
   * untouched.
   */
  function stepAdaptiveScreenShare(dir: -1 | 1): boolean {
    const ladder = SCREEN_SHARE_QUALITIES; // low → high by bitrate ceiling
    const selectedIdx = ladder.indexOf(screenShareQuality);
    if (selectedIdx < 0) return false;
    const floorIdx = Math.min(ladder.indexOf(adaptiveScreenShareFloor()), selectedIdx);
    const currentIdx = ladder.indexOf(effectiveScreenShareQuality());
    const nextIdx = Math.max(floorIdx, Math.min(selectedIdx, currentIdx + dir));
    if (nextIdx === currentIdx) return false;
    const nextQuality = ladder[nextIdx];
    if (!nextQuality) return false; // clamped in-bounds; guard satisfies noUncheckedIndexedAccess
    adaptiveScreenShareCap = nextQuality === screenShareQuality ? null : nextQuality;
    void reapplyLiveScreenShare();
    return true;
  }

  /**
   * One adaptive tick: fold the current uplink reading into the poor/good streaks and,
   * on a sustained streak, step the screen-share tier down/up. A no-op (and streak
   * reset) unless a screen share is actually live while connected. See the ADAPTIVE_*
   * constants for the thresholds + hysteresis rationale.
   */
  function adaptScreenShareToUplink(quality: VoiceConnectionQuality): void {
    if (!room || !localScreenShare || state.status !== "connected") {
      adaptivePoorStreak = 0;
      adaptiveGoodStreak = 0;
      return;
    }
    const poor =
      quality.level === "poor" ||
      (quality.rttMs !== null && quality.rttMs >= ADAPTIVE_RTT_POOR_MS);
    const good =
      (quality.level === "excellent" || quality.level === "good") &&
      (quality.rttMs === null || quality.rttMs <= ADAPTIVE_RTT_GOOD_MS);

    if (poor) {
      adaptiveGoodStreak = 0;
      adaptivePoorStreak += 1;
      if (adaptivePoorStreak >= ADAPTIVE_DOWN_TICKS && stepAdaptiveScreenShare(-1)) {
        adaptivePoorStreak = 0;
      }
    } else if (good) {
      adaptivePoorStreak = 0;
      adaptiveGoodStreak += 1;
      if (adaptiveGoodStreak >= ADAPTIVE_UP_TICKS && stepAdaptiveScreenShare(+1)) {
        adaptiveGoodStreak = 0;
      }
    } else {
      // Fair / unknown: hold the tier and DECAY both streaks so a one-off blip never
      // accumulates into a step.
      if (adaptivePoorStreak > 0) adaptivePoorStreak -= 1;
      if (adaptiveGoodStreak > 0) adaptiveGoodStreak -= 1;
    }
  }

  /** Begin connection-quality polling if the adapter supports it. */
  function startConnectionQuality(): void {
    stopConnectionQuality(); // idempotent — never double-run a timer
    if (!room || typeof room.createConnectionQualityProbe !== "function") return;
    const probe = room.createConnectionQualityProbe();
    if (!probe) return;
    qualityProbe = probe;
    qualityPollTimer = setInterval(pollConnectionQuality, CONNECTION_QUALITY_POLL_MS);
    pollConnectionQuality(); // seed immediately so the indicator can appear at once
  }

  /** Stop polling and release the probe (leave/dispose/disconnect). */
  function stopConnectionQuality(): void {
    if (qualityPollTimer !== null) {
      clearInterval(qualityPollTimer);
      qualityPollTimer = null;
    }
    if (qualityProbe) {
      try {
        qualityProbe.close();
      } catch {
        // Best-effort — the probe may already be released.
      }
      qualityProbe = null;
    }
  }

  // ── room event handlers ─────────────────────────────────────────────────

  const onReconnecting = (): void => {
    if (state.status === "connected") setState({ status: "reconnecting" });
  };

  const onReconnected = (): void => {
    if (state.status !== "reconnecting") return;
    setState({ status: "connected", error: null });
    applyRemoteVolumes(state.deafened);
    // Re-assert our deafen attribute after a reconnect — the signalling transport
    // was rebuilt, so a pre-reconnect attribute may not have survived; peers that
    // (re)appear must still see the correct headphone-off badge. Only when deafened
    // (absence already means "not deafened"). Best-effort.
    if (state.deafened) publishDeafenedAttribute(true);
    void applyMicPreference();
    // Re-assert remote audio subscriptions after a reconnect too — the transport
    // was rebuilt, so a pre-existing film/voice audio publication can be left
    // unsubscribed on RN exactly like a late join. Unconditional (like the join
    // path): applyRemoteVolumes above already ran, so if we are DEAFENED any track
    // this re-subscribes is immediately muted (desktop: volume 0 via the volumeMap;
    // RN: onRemoteTrackSubscribed re-mutes it) — and it is then ready to un-mute the
    // instant the user undeafens, which a guarded call here would have left silent.
    room?.ensureRemoteAudioSubscribed?.();
    syncParticipants();
  };

  /**
   * `reason` is livekit's numeric `DisconnectReason`. Both platform adapters
   * forward the SDK's event args verbatim, so it arrives here untouched; it is
   * optional (older/self-initiated disconnects omit it) and only ever read
   * through {@link isEvictionDisconnect}, so the engine stays livekit-enum-free.
   */
  const onDisconnected = (reason?: unknown): void => {
    // Deliberate leave is driven by leave(); everything else is a failure.
    if (state.status === "leaving" || state.status === "idle") return;

    // Common teardown, identical for the error and eviction paths. The self-
    // monitor holds a live capture track, so an unexpected disconnect must
    // release it too — otherwise a dropped call leaves the mic (and its OS
    // indicator) running with no session behind it. No restore: the mic/deafen
    // state is reset by the transitions below either way.
    void stopSelfMonitoring(false);
    stopLocalSpeaking();
    stopConnectionQuality();
    releaseRoom();
    speakingIdentities = new Set();
    teardownLocalScreenShare();
    clearRemoteScreenShares();
    clearRemoteCameras();

    // Single-active-session eviction (DUPLICATE_IDENTITY: another device joined
    // the SAME room; PARTICIPANT_REMOVED: the API kicked us for joining a
    // DIFFERENT room elsewhere). This is a clean handoff, NOT a failure — return
    // to idle with a typed notice instead of the scary server_unavailable error.
    if (isEvictionDisconnect(reason)) {
      // WHY were we removed? A LiveKit eviction disconnect carries no product
      // reason, so it defaults to the single-session handoff — EXCEPT when our own
      // alone window had already run out, which means this is the server's
      // alone-idle sweep cutting a room nobody else was in. A later
      // `voice.disconnected` can still refine it (handleForcedDisconnect).
      const evictedReason: VoiceEndedReason = aloneWindowElapsed()
        ? "alone"
        : "session_replaced";
      // Remember WHICH room this notice belongs to, so a `voice.disconnected`
      // that loses the race to the force-remove can still correct it.
      lastEvictedRoomId = state.roomId;
      setState({
        status: "idle",
        roomId: null,
        error: null,
        endedReason: evictedReason,
        aloneDeadlineAt: null,
        participants: [],
        screenShareEnabled: false,
        screenShareHasAudio: false,
        screenShareAudioLive: false,
        cameraEnabled: false,
        connectionQuality: UNKNOWN_CONNECTION_QUALITY,
      });
      return;
    }

    const wasReconnecting = state.status === "reconnecting";
    setState({
      status: "error",
      error: { kind: wasReconnecting ? "reconnect_failed" : "server_unavailable" },
      // A dead room has no alone clock running on it — the server's window only
      // applies while we are actually in the SFU.
      aloneDeadlineAt: null,
      participants: [],
      screenShareEnabled: false,
      screenShareHasAudio: false,
      screenShareAudioLive: false,
      // Camera is a per-session live track; a dead room means no camera (task #18).
      cameraEnabled: false,
      connectionQuality: UNKNOWN_CONNECTION_QUALITY,
    });
  };

  const onParticipantConnected = (participant: RemoteParticipantLike): void => {
    // Re-apply this remote's effective volumes immediately — their stored per-user
    // VOICE level AND their separate per-SHARE (film) level,
    // or 0 for either if we're deafened (a late joiner stays muted while deafened).
    // livekit stores the per-share value against the source, so it re-applies when
    // their screen_share_audio track later arrives. Late-joiner reapply hook for all.
    safeSetVolume(participant, effectiveVolume(participant.identity, state.deafened));
    const shareVolume = effectiveScreenShareVolume(participant.identity, state.deafened);
    safeSetVolume(participant, shareVolume, TRACK_SOURCE.ScreenShareAudio);
    // RN native-playout parallel for the FILM track (see setScreenShareVolume).
    room?.setRemoteScreenShareVolume?.(participant.identity, shareVolume);
    syncParticipants();
  };

  const onParticipantDisconnected = (participant: RemoteParticipantLike): void => {
    speakingIdentities.delete(participant.identity);
    if (remoteScreenShares.delete(participant.identity)) notifyScreenShares();
    if (remoteCameras.delete(participant.identity)) notifyCameras();
    syncParticipants();
  };

  const onActiveSpeakersChanged = (speakers: ParticipantLike[]): void => {
    const next = new Set(speakers.map((s) => s.identity));
    if (setsEqual(next, speakingIdentities)) return; // no-op tick — no update
    speakingIdentities = next;
    syncParticipants();
  };

  /**
   * A participant's custom ATTRIBUTES changed. Today that carries the DEAFEN flag
   * ({@link PARTICIPANT_ATTR.deafened}) — a listener-side state LiveKit doesn't
   * model. Re-derive the rows: `syncParticipants` re-reads each participant's
   * current attributes, so the toggling remote's `deafened` flips and — via the
   * per-row equality in {@link sameParticipant} — ONLY that row re-renders (§27).
   * Args (changedAttributes, participant) are unused; a full re-sync is cheap and
   * keeps this handler indifferent to which attribute moved.
   */
  const onParticipantAttributesChanged = (): void => {
    syncParticipants();
  };

  /** True when a mute event's participant is our own local participant. */
  function isLocalParticipant(participant: ParticipantLike): boolean {
    return !!room && participant.identity === room.localParticipant.identity;
  }

  /**
   * Keep {@link remoteCameras} in sync with a remote camera's MUTE state.
   *
   * livekit MUTES (it does not unpublish) a camera that a remote turns off, so the
   * subscription survives and `TrackSubscribed`/`Unsubscribed` never fire on a
   * camera toggle — only `TrackMuted`/`TrackUnmuted` do. Without handling them the
   * engine kept the (now frozen) track in its snapshot, so `cameraEnabled` stayed
   * true and the tile showed a black/stuck frame instead of the avatar. On mute we
   * drop the camera from the snapshot (tile → avatar, `cameraEnabled` → false); on
   * unmute we re-bind the resumed track (a fresh snapshot ref makes the UI reattach
   * and repaint). Local-camera mutes are ignored here — the local flag is driven by
   * `setCamera`, and the local user is never in `remoteCameras`. Screen share is
   * unaffected: turning it off UNPUBLISHES, so `TrackUnsubscribed` already handles it.
   */
  function syncRemoteCameraMute(
    publication: TrackPublicationLike,
    participant: ParticipantLike,
    muted: boolean,
  ): void {
    if (publication.source !== TRACK_SOURCE.Camera) return;
    if (isLocalParticipant(participant)) return;
    if (muted) {
      if (remoteCameras.delete(participant.identity)) notifyCameras();
      return;
    }
    const track = publication.track;
    if (!track) return; // no subscribed track to re-bind (shouldn't happen for a live camera)
    remoteCameras.set(participant.identity, {
      identity: participant.identity,
      userId: participant.identity as UserId,
      track,
    });
    notifyCameras();
  }

  const onTrackMuted = (
    publication: TrackPublicationLike,
    participant: ParticipantLike,
  ): void => {
    syncRemoteCameraMute(publication, participant, true);
    syncParticipants();
  };

  const onTrackUnmuted = (
    publication: TrackPublicationLike,
    participant: ParticipantLike,
  ): void => {
    syncRemoteCameraMute(publication, participant, false);
    syncParticipants();
  };

  const onLocalTrackUnpublished = (publication: TrackPublicationLike): void => {
    if (state.status !== "connected" && state.status !== "reconnecting") return;
    if (publication.source === TRACK_SOURCE.Microphone) {
      if (!state.micEnabled) return; // we unpublished it on purpose
      setState({
        micEnabled: false,
        error: { kind: "track_ended_unexpectedly", track: "mic" },
      });
      syncParticipants();
      return;
    }
    // Camera (task #18): the device was unplugged / the track ended. Our own
    // setCamera(false) already flipped cameraEnabled first, so that unpublish is
    // ignored here; only a still-"on" camera vanishing is unexpected.
    if (publication.source === TRACK_SOURCE.Camera) {
      if (!state.cameraEnabled) return; // we turned it off on purpose
      if (republishingCamera) return; // intermediate unpublish of a live re-apply
      setState({
        cameraEnabled: false,
        error: { kind: "track_ended_unexpectedly", track: "camera" },
      });
      syncParticipants();
    }
  };

  const onMediaDevicesError = (err: Error): void => {
    setState({
      micEnabled: false,
      error: mapAcquisitionError(err, "microphone", state.selectedInputDeviceId),
    });
    syncParticipants();
  };

  /** A remote track was subscribed — capture screen-share or camera video for rendering. */
  const onTrackSubscribed = (
    track: RemoteTrackLike,
    publication: RemoteTrackPublicationLike,
    participant: RemoteParticipantLike,
  ): void => {
    // Camera video (task #18) — a SEPARATE tile from screen share.
    if (publication.source === TRACK_SOURCE.Camera) {
      // A camera that subscribed already-muted (joined with the camera off, since
      // livekit mutes rather than unpublishes) must NOT render — that is the black
      // tile. TrackUnmuted will bind it when they actually turn the camera on.
      if (publication.isMuted) return;
      remoteCameras.set(participant.identity, {
        identity: participant.identity,
        userId: participant.identity as UserId,
        track,
      });
      notifyCameras();
      syncParticipants(); // reflect the camera-on flag
      return;
    }
    // Only the screen-share VIDEO track is rendered in a <video>. Screen-share
    // AUDIO (source screen_share_audio) plays through the PLATFORM's audio
    // playback layer — on web the adapter attaches every remote audio track
    // (livekit.ts, the desktop couldn't-hear P0 fix); on RN playback is native.
    // Same path as voice, so it needs no handling here.
    if (publication.source === TRACK_SOURCE.ScreenShare) {
      remoteScreenShares.set(participant.identity, {
        identity: participant.identity,
        userId: participant.identity as UserId,
        track,
      });
      notifyScreenShares();
      syncParticipants(); // reflect the screen-sharing badge
    }
  };

  const onTrackUnsubscribed = (
    _track: RemoteTrackLike,
    publication: RemoteTrackPublicationLike,
    participant: RemoteParticipantLike,
  ): void => {
    if (publication.source === TRACK_SOURCE.Camera) {
      if (remoteCameras.delete(participant.identity)) notifyCameras();
      syncParticipants();
      return;
    }
    if (publication.source === TRACK_SOURCE.ScreenShare) {
      if (remoteScreenShares.delete(participant.identity)) notifyScreenShares();
      syncParticipants();
    }
  };

  /**
   * Late-joiner SEED — the P0 fix. A remote already screen-sharing / on camera when
   * we connect may never (re-)fire TrackSubscribed for us (autoSubscribe/adaptiveStream
   * timing, seen on RN), so replay the adapter's current remote video subscriptions
   * through the SAME onTrackSubscribed path — identical routing + camera mute-gate +
   * notify. No-op when the adapter can't enumerate. Idempotent per identity.
   */
  function seedRemoteVideoTracks(): void {
    const seeds = room?.seedRemoteVideoTracks?.();
    if (!seeds) return;
    for (const seed of seeds) {
      onTrackSubscribed(seed.track, seed.publication, seed.participant);
    }
  }

  const roomHandlers: ReadonlyArray<[RoomEventName, RoomListener]> = [
    [ROOM_EVENT.Reconnecting, onReconnecting],
    [ROOM_EVENT.Reconnected, onReconnected],
    [ROOM_EVENT.Disconnected, onDisconnected],
    [ROOM_EVENT.ParticipantConnected, onParticipantConnected],
    [ROOM_EVENT.ParticipantDisconnected, onParticipantDisconnected],
    [ROOM_EVENT.ActiveSpeakersChanged, onActiveSpeakersChanged],
    [ROOM_EVENT.ParticipantAttributesChanged, onParticipantAttributesChanged],
    [ROOM_EVENT.TrackMuted, onTrackMuted],
    [ROOM_EVENT.TrackUnmuted, onTrackUnmuted],
    [ROOM_EVENT.LocalTrackUnpublished, onLocalTrackUnpublished],
    [ROOM_EVENT.MediaDevicesError, onMediaDevicesError],
    [ROOM_EVENT.TrackSubscribed, onTrackSubscribed],
    [ROOM_EVENT.TrackUnsubscribed, onTrackUnsubscribed],
  ];

  function attachRoom(target: VoiceRoomAdapter): void {
    for (const [event, handler] of roomHandlers) target.on(event, handler);
  }

  /** Detach listeners and drop the room reference (leak check, review §7). */
  function releaseRoom(): void {
    if (!room) return;
    for (const [event, handler] of roomHandlers) room.off(event, handler);
    room = null;
    // The mic track (and any RNNoise processor livekit destroyed with it) is gone;
    // a rejoin must re-attach from scratch, and may retry a previously-broken worklet.
    noiseFilterActive = false;
    noiseFilterBroken = false;
  }

  /**
   * Stop + forget the local screen share without touching FSM state or the room
   * (used by leave/dispose/disconnect where the room is going away anyway).
   * Stopping the raw tracks releases the OS "sharing" indicator + loopback audio.
   */
  function teardownLocalScreenShare(): void {
    if (!localScreenShare) return;
    const active = localScreenShare;
    localScreenShare = null;
    try {
      active.video.removeEventListener("ended", active.onVideoEnded);
    } catch {
      // ignore
    }
    stopTrack(active.video);
    stopTrack(active.audio);
  }

  /** Drop all remote screen-share tracks (their room is gone). */
  function clearRemoteScreenShares(): void {
    if (remoteScreenShares.size === 0) return;
    remoteScreenShares.clear();
    notifyScreenShares();
  }

  /** Drop all remote camera tracks (their room is gone) — task #18. */
  function clearRemoteCameras(): void {
    if (remoteCameras.size === 0) return;
    remoteCameras.clear();
    notifyCameras();
  }

  // ── commands ────────────────────────────────────────────────────────────

  async function join(
    roomChannelId: string,
    preMinted?: VoiceJoinCredential,
  ): Promise<void> {
    guard("JOIN");
    const epoch = ++commandEpoch;
    releaseRoom(); // a failed previous session may have left one behind
    // A new room is a new surface: forget the previous one until the app resolves
    // and pushes this room's kind. Until it does, the fail-safe "no countdown"
    // answer holds — never the previous room's answer.
    surfaceKind = null;
    lastEvictedRoomId = null;
    setState({
      status: "joining",
      roomId: roomChannelId,
      error: null,
      // A fresh, user-initiated join clears any prior eviction notice so a stale
      // "you joined elsewhere" can never linger into the new session.
      endedReason: null,
      // …and any prior alone clock: the previous room's deadline says nothing
      // about this one, and leaving it stale would mis-attribute a later eviction.
      aloneDeadlineAt: null,
      participants: [],
      // Belt-and-suspenders: a fresh session has NO local live tracks yet, so hard-
      // reset the live-track flags here. A normal leave/disconnect already clears
      // them, but a session that ended abnormally (e.g. a wedged leave that never
      // reached its reset) must never carry a stale `cameraEnabled`/`screenShare*`
      // into the new room — that showed the founder a lit "stop camera" button on a
      // camera that was never on (§11 single source of truth).
      cameraEnabled: false,
      screenShareEnabled: false,
      screenShareHasAudio: false,
      screenShareAudioLive: false,
    });

    let grant: VoiceTokenGrant;
    if (preMinted) {
      // PRE-MINTED path (DM calls, ADR 0012 §2): the token was already minted by
      // POST /dm-calls (start → caller, accept → callee), NOT POST /media/token.
      // Skip the fetchToken hop and connect with the supplied { url, token }.
      // No await here ⇒ no epoch re-check is needed before createRoom (nothing
      // could have raced in the caller's absence yet). roomChannelId is the
      // LiveKit room the token admits us to (`dmcall:<callId>`); keying
      // VoiceState.roomId on it (set above) makes single-session eviction and
      // reconnect behave identically to a voice channel.
      grant = preMinted;
    } else {
      // FETCH-TOKEN path (group voice channels): the engine mints via the
      // caller's injected fetchToken (POST /media/token). Unchanged.
      try {
        grant = await options.fetchToken(roomChannelId);
      } catch {
        if (epoch !== commandEpoch) return; // user left while fetching
        const error: VoiceError = { kind: "server_unavailable" };
        setState({ status: "error", error });
        throw new VoiceOperationError(error);
      }
      if (epoch !== commandEpoch) return;
    }

    let candidate: VoiceRoomAdapter;
    try {
      candidate = await createRoom();
    } catch {
      if (epoch !== commandEpoch) return;
      const error: VoiceError = { kind: "server_unavailable" };
      setState({ status: "error", error });
      throw new VoiceOperationError(error);
    }
    if (epoch !== commandEpoch) return;

    room = candidate;
    attachRoom(room);
    try {
      await room.connect(grant.url, grant.token);
    } catch {
      if (epoch !== commandEpoch) return;
      releaseRoom();
      const error: VoiceError = { kind: "server_unavailable" };
      setState({ status: "error", error, participants: [] });
      throw new VoiceOperationError(error);
    }
    if (epoch !== commandEpoch) return;

    setState({ status: "connected", error: null });

    // Late-joiner seed: surface any screen share / camera already in progress at
    // connect (a remote sharing before we joined never re-fires TrackSubscribed).
    seedRemoteVideoTracks();
    // The AUDIO half of the same seed: force-subscribe any pre-existing remote audio
    // — voice AND the host's film/screen-share audio — so a viewer who joined AFTER
    // the share started actually HEARS it (RN doesn't reliably subscribe pre-existing
    // publications; audio then plays natively once subscribed). No-op on desktop.
    room.ensureRemoteAudioSubscribed?.();

    // Best-effort: restore device preferences from a previous session.
    if (state.selectedInputDeviceId) {
      try {
        await room.switchActiveDevice("audioinput", state.selectedInputDeviceId);
      } catch {
        setState({
          error: {
            kind: "device_unavailable",
            deviceId: state.selectedInputDeviceId,
            device: "microphone",
          },
        });
      }
    }
    if (epoch !== commandEpoch) return;
    if (state.selectedOutputDeviceId) {
      try {
        await room.switchActiveDevice("audiooutput", state.selectedOutputDeviceId);
      } catch {
        // Output switch failures are non-fatal; keep default output.
      }
    }
    if (epoch !== commandEpoch) return;

    applyRemoteVolumes(state.deafened);
    // Deafen survives across sessions (leave keeps it), so a user who joins while
    // deafened must re-assert the attribute into the NEW room or peers there never
    // see the headphone-off badge. Only when deafened — absence of the attribute
    // already means "not deafened", so a fresh non-deafened join writes nothing.
    // Best-effort, fire-and-forget.
    if (state.deafened) publishDeafenedAttribute(true);
    await applyMicPreference(); // may surface permission_denied / device_not_found
    if (epoch !== commandEpoch) return;
    // Joining a room WITH "kendini dinle" already on (started from Ayarlar, where
    // there was no room to suppress) must now apply the anti-feedback policy —
    // otherwise the monitor plays our mic into a live publish.
    if (state.selfMonitoring) await suppressForMonitoring();
    if (epoch !== commandEpoch) return;
    syncParticipants();
    startLocalSpeaking(); // on-device own-ring detection (task #54)
    startConnectionQuality(); // ping / connection-quality polling (task #55)
  }

  async function leave(): Promise<void> {
    guard("LEAVE");
    commandEpoch++;
    setState({ status: "leaving" });
    // The monitor owns a live capture track; a monitor that outlives the session
    // is a leaked mic (and a lit OS indicator). No restore — the session's
    // mic/deafen state is about to be reset by the leave itself.
    await stopSelfMonitoring(false);
    stopLocalSpeaking();
    stopConnectionQuality();
    const active = room;
    releaseRoom(); // detach first so Disconnected doesn't double-handle
    speakingIdentities = new Set();
    teardownLocalScreenShare();
    clearRemoteScreenShares();
    clearRemoteCameras();
    if (active) {
      // Leaving must ALWAYS reach idle. `disconnect()` is a best-effort network
      // round-trip that can HANG indefinitely on a dead transport (the peer
      // already left / flaky network / the app was backgrounded — seen on RN):
      // awaiting it would wedge the FSM in "leaving" forever, which jams the
      // Leave button AND every other control (they gate on connected/room-active),
      // strands a stale `cameraEnabled`, and blocks the next JOIN (illegal from
      // "leaving") so a re-join silently no-ops (§35, founder P0). So FIRE it
      // WITHOUT awaiting and reconcile to idle right now. Listeners are already
      // detached above, so its late Disconnected can't double-handle, and it still
      // stops the local tracks (mic/screen/camera → OS indicator released) whenever
      // it eventually settles.
      void (async () => {
        try {
          await active.disconnect();
        } catch {
          // Already disconnected / dead transport — best-effort.
        }
      })();
    }
    // Let the "leaving" transition flush to subscribers before we settle to idle so
    // the intermediate FSM state stays observable (§11). This awaits ONLY a
    // microtask — never the (possibly hung) disconnect above — so leave() still
    // always reaches idle promptly.
    await Promise.resolve();
    setState({
      status: "idle",
      roomId: null,
      participants: [],
      error: null,
      // A user-initiated leave clears any eviction notice. handleSessionReplaced
      // (which reuses this leave path) re-sets it AFTER this returns, so an
      // eviction still surfaces while a plain Leave stays silent.
      endedReason: null,
      // No room ⇒ no alone clock. Cleared BEFORE handleForcedDisconnect re-records
      // its reason, so the notice it sets is never re-derived from a stale deadline.
      aloneDeadlineAt: null,
      screenShareEnabled: false,
      screenShareHasAudio: false,
      screenShareAudioLive: false,
      // Camera is not carried between sessions (unlike mic/deafen/device prefs);
      // selectedVideoDeviceId — the device PREFERENCE — does survive (task #18).
      cameraEnabled: false,
      connectionQuality: UNKNOWN_CONNECTION_QUALITY,
      // mic/deafen/device preferences survive across sessions on purpose
    });
  }

  /**
   * Handle a single-active-session eviction delivered over the realtime gateway
   * (`voice.session_replaced`). The device that just joined elsewhere is now in a
   * DIFFERENT room (or idle), so a roomId mismatch means "not me" — the client-
   * side reconnect/new-join safeguard: a normal LiveKit reconnect never changes
   * roomId, and a same-device room switch has already moved roomId to the new room
   * before this signal arrives. When it IS us, reuse the single leave path to
   * reach idle cleanly, then mark WHY so the UI shows the localized notice.
   * Idempotent with the LiveKit eviction Disconnected: whichever lands first ends
   * the session; the other no-ops (roomId is already null / status already idle).
   */
  async function handleSessionReplaced(evictedRoomId: string): Promise<void> {
    if (state.roomId !== evictedRoomId) return;
    if (state.status === "idle" || state.status === "leaving") return;
    await leave(); // ONE leave path (clears endedReason first) …
    setState({ endedReason: "session_replaced" }); // … then record the reason.
  }

  /**
   * Handle a server-authored voice disconnect that NAMES its reason
   * (`voice.disconnected`, e.g. `alone`). Same room guard and same single leave
   * path as {@link handleSessionReplaced}, plus one extra branch that exists
   * purely because of a race:
   *
   * the server force-removes the participant from the SFU AND publishes the event.
   * Whichever lands first ends the session. When the SFU disconnect wins, the
   * engine has already settled at idle with the generic `session_replaced` notice
   * — so this event, arriving a beat later for the SAME room, UPGRADES that
   * pending notice to the truth. It only ever overwrites a notice that is still
   * pending (un-acknowledged); once the UI has shown and cleared it, a late event
   * must not resurrect a toast out of nowhere.
   */
  async function handleForcedDisconnect(
    roomKeys: readonly string[],
    reason: VoiceEndedReason,
  ): Promise<void> {
    const names = roomKeys.filter((key) => key.length > 0);
    if (names.length === 0) return;
    const live = state.status !== "idle" && state.status !== "leaving";
    if (live && state.roomId !== null && names.includes(state.roomId)) {
      await leave(); // ONE leave path (clears endedReason first) …
      setState({ endedReason: reason }); // … then record the server's reason.
      return;
    }
    // Already ended — refine the pending notice iff it explains THIS room's
    // eviction. Guarded on a still-pending notice so a late event can never
    // resurrect a toast the user already dismissed.
    if (
      state.roomId === null &&
      lastEvictedRoomId !== null &&
      names.includes(lastEvictedRoomId) &&
      state.endedReason !== null
    ) {
      setState({ endedReason: reason });
    }
  }

  /** Clear the eviction notice once the client has surfaced it (ack). */
  function clearEndedReason(): void {
    setState({ endedReason: null });
  }

  /**
   * Record which surface the current room is, then re-evaluate the alone clock.
   * Idempotent: pushing the same kind twice changes nothing.
   */
  function setSurfaceKind(kind: VoiceSurfaceKind | null): void {
    if (surfaceKind === kind) return;
    surfaceKind = kind;
    refreshAloneDeadline();
  }

  async function setMic(enabled: boolean): Promise<void> {
    guard("SET_MIC");
    // A DELIBERATE unmute while self-monitoring would put the speakers straight
    // back into the live mic, so it ends monitoring instead of fighting it. The
    // user's choice wins outright: the saved pre-monitor snapshot is DROPPED
    // (restore: false), because this unmute IS their new preference — restoring
    // the old one afterwards would undo the very thing they just asked for.
    if (enabled && state.selfMonitoring && !monitorSuppressing) {
      await stopSelfMonitoring(false);
    }
    if (enabled && state.deafened) {
      // Unmuting while deafened undeafens; restore each
      // remote to its personal per-user level (not a blanket 100%).
      applyRemoteVolumes(false);
      setState({ deafened: false });
    }
    setState({ micEnabled: enabled });
    if (room && state.status === "connected") {
      try {
        await setRoomMic(room, enabled);
      } catch (err) {
        const mapped = mapAcquisitionError(err, "microphone", state.selectedInputDeviceId);
        setState({ micEnabled: false, error: mapped });
        throw new VoiceOperationError(mapped);
      }
      syncParticipants();
    }
    setState({ error: null });
  }

  async function setDeafened(deafened: boolean): Promise<void> {
    guard("SET_DEAFENED");
    // Same rule as setMic: a deliberate UNDEAFEN while monitoring means the user
    // wants the room back, so monitoring ends and its snapshot is dropped.
    if (!deafened && state.selfMonitoring && !monitorSuppressing) {
      await stopSelfMonitoring(false);
    }
    if (deafened === state.deafened) return;
    if (deafened) {
      micBeforeDeafen = state.micEnabled;
      applyRemoteVolumes(true);
      setState({ deafened: true, micEnabled: false, error: null });
      if (room && state.status === "connected" && room.localParticipant.isMicrophoneEnabled) {
        try {
          await setRoomMic(room, false);
        } catch {
          // Remote playback is already silenced; mic mute is best-effort here.
        }
      }
    } else {
      applyRemoteVolumes(false);
      setState({ deafened: false, micEnabled: micBeforeDeafen, error: null });
      await applyMicPreference();
    }
    // Broadcast the new deafen flag so peers show/clear our headphone-off badge.
    publishDeafenedAttribute(deafened);
    syncParticipants();
  }

  async function setInputDevice(deviceId: string): Promise<void> {
    guard("SET_INPUT_DEVICE");
    if (room && (state.status === "connected" || state.status === "reconnecting")) {
      try {
        await room.switchActiveDevice("audioinput", deviceId);
      } catch {
        const mapped: VoiceError = {
          kind: "device_unavailable",
          deviceId,
          device: "microphone",
        };
        setState({ error: mapped });
        throw new VoiceOperationError(mapped);
      }
    }
    setState({ selectedInputDeviceId: deviceId, error: null });
    // A running monitor is bound to the OLD mic; re-capture from the new one so
    // "kendini dinle" keeps tracking the device that is actually being published.
    rearmSelfMonitoring();
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    guard("SET_OUTPUT_DEVICE");
    if (room && (state.status === "connected" || state.status === "reconnecting")) {
      try {
        await room.switchActiveDevice("audiooutput", deviceId);
      } catch {
        const mapped: VoiceError = {
          kind: "device_unavailable",
          deviceId,
          device: "microphone",
        };
        setState({ error: mapped });
        throw new VoiceOperationError(mapped);
      }
    }
    setState({ selectedOutputDeviceId: deviceId, error: null });
    // Re-point the monitor's playback at the new sink (setSinkId lives on the
    // element the monitor owns, so only a re-arm can move it).
    rearmSelfMonitoring();
  }

  function setParticipantVolume(identity: string, volume: number): void {
    guard("SET_PARTICIPANT_VOLUME"); // legal in any status
    const clamped = clampParticipantVolume(volume);
    // Store only NON-default levels so the map (and its persisted round-trip) never
    // accumulates redundant 100% entries — mirrors normalizeParticipantVolumes.
    if (isDefaultParticipantVolume(clamped)) participantVolumes.delete(identity);
    else participantVolumes.set(identity, clamped);
    // Apply LIVE only when connected AND not deafened: deafen is a master mute that
    // must win, so we leave the remote at 0 and let undeafen restore this level.
    if (room && !state.deafened) {
      const remote = room.remoteParticipants.get(identity);
      if (remote) safeSetVolume(remote, clamped);
    }
    // Reflect the new level into that participant's row (state.volume) so the UI
    // slider re-renders — and only that row (memoization preserved, §27).
    syncParticipants();
  }

  function getParticipantVolume(identity: string): number {
    return participantVolume(identity);
  }

  function setScreenShareVolume(identity: string, volume: number): void {
    guard("SET_PARTICIPANT_VOLUME"); // same guard family — legal in any status
    const clamped = clampParticipantVolume(volume);
    // Store only NON-default levels (mirrors participant volume) so the persisted
    // map never accumulates redundant 100%s. In-session 0 is honored; the platform's
    // load-time normalizer drops a persisted 0 so a mute never survives a restart.
    if (isDefaultParticipantVolume(clamped)) screenShareVolumes.delete(identity);
    else screenShareVolumes.set(identity, clamped);
    // Apply LIVE only when connected AND not deafened: deafen must win, so we leave
    // the film at 0 and let undeafen restore this level. Targets the film-audio track
    // ONLY (source screen_share_audio) — the sharer's mic is untouched. livekit keeps
    // the value against the source, so it re-applies if the share (re)starts later.
    if (room && !state.deafened) {
      const remote = room.remoteParticipants.get(identity);
      if (remote) safeSetVolume(remote, clamped, TRACK_SOURCE.ScreenShareAudio);
      // RN parallel to setRemoteAudioMuted: the per-participant setVolume above does
      // not reliably reach the NATIVE playout for the film track (a second, flakily-
      // subscribed remote audio publication), so the RN adapter applies it to the
      // film pub directly AND re-applies on (re)subscribe. Called even when `remote`
      // is absent so the level is remembered for a share that starts later. No-op on
      // web (hook omitted — its audio-element setVolume already worked).
      room.setRemoteScreenShareVolume?.(identity, clamped);
    }
    // Not part of the reactive participant row (a film level is not voice state); the
    // UI reads it back via getScreenShareVolume, so no syncParticipants needed here.
  }

  function getScreenShareVolume(identity: string): number {
    return screenShareVolume(identity);
  }

  async function setVideoDevice(deviceId: string): Promise<void> {
    guard("SET_VIDEO_DEVICE");
    // Only touch the room when a live camera track exists to switch — livekit's
    // videoinput switch is a no-op (or errors) without one. Off-camera, we just
    // remember the preference; it applies when the camera is next enabled.
    if (
      room &&
      state.cameraEnabled &&
      (state.status === "connected" || state.status === "reconnecting")
    ) {
      try {
        await room.switchActiveDevice("videoinput", deviceId);
      } catch {
        const mapped: VoiceError = { kind: "device_unavailable", deviceId };
        setState({ error: mapped });
        throw new VoiceOperationError(mapped);
      }
    }
    setState({ selectedVideoDeviceId: deviceId, error: null });
  }

  /** OS-initiated screen-share end (user hit the OS "Stop sharing" overlay, or
   *  the shared window closed). Distinct from our own stopScreenShare(): here we
   *  surface a typed §26 "source closed" notice while cleanly returning to no-share. */
  async function handleScreenTrackEnded(): Promise<void> {
    if (!localScreenShare) return; // our own stopScreenShare already cleared it
    const active = localScreenShare;
    localScreenShare = null; // clear first so unpublish's own events are ignored
    try {
      active.video.removeEventListener("ended", active.onVideoEnded);
    } catch {
      // ignore
    }
    if (room) {
      try {
        await room.localParticipant.unpublishTrack(active.video, true);
      } catch {
        // best-effort
      }
      if (active.audio) {
        try {
          await room.localParticipant.unpublishTrack(active.audio, true);
        } catch {
          // best-effort
        }
      }
    }
    stopTrack(active.video);
    stopTrack(active.audio);
    setState({
      screenShareEnabled: false,
      screenShareHasAudio: false,
      screenShareAudioLive: false,
      error: { kind: "track_ended_unexpectedly", track: "screen" },
    });
    syncParticipants();
  }

  async function startScreenShare(
    acquire: AcquireScreenShare,
    shareOptions?: ScreenSharePublishOptions,
  ): Promise<void> {
    guard("START_SCREEN_SHARE"); // connected only
    if (state.screenShareEnabled) return; // already sharing — idempotent
    const epoch = commandEpoch;
    const quality = shareOptions?.quality ?? DEFAULT_SCREEN_SHARE_QUALITY;
    // Track the live tier so a later Ayarlar → görüntü change can republish the
    // screen video with a new encoding without a stop/restart (live-apply, #3).
    screenShareQuality = quality;
    // Fresh share → clear any adaptive cap from a previous session so we start at the
    // user's selection and let the uplink controller re-decide from scratch.
    resetAdaptiveScreenShare();

    let assets: ScreenShareAssets;
    try {
      assets = await acquire();
    } catch (err) {
      const mapped = mapAcquisitionError(err, "screen", null);
      setState({ error: mapped });
      throw new VoiceOperationError(mapped);
    }

    // The user may have left / dropped while the OS picker was open.
    if (epoch !== commandEpoch || state.status !== "connected" || !room) {
      stopTrack(assets.video);
      stopTrack(assets.audio);
      return;
    }

    // Belt-and-suspenders for the film (system/loopback) audio: never publish an
    // already-ENDED track. A dead loopback capture (readyState "ended" — the audio
    // endpoint/driver could not back the WASAPI loopback) would otherwise publish as
    // ScreenShareAudio, flip screenShareHasAudio TRUE, and stream SILENCE to viewers
    // while claiming success (the founder's "yayın sesi gitmiyor" with no notice).
    // Dropping it here keeps screenShareHasAudio HONEST — it is true only when a LIVE
    // audio publication actually exists — so a video-only reality is never masked.
    // NOT a §11 status transition: this only affects the screenShareHasAudio FLAG,
    // exactly as a caller passing `audio: null` already does. The renderer's
    // capture-time guard warns the sharer (§26); this is the media-layer safety net.
    let audioTrack =
      assets.audio && assets.audio.readyState !== "ended" ? assets.audio : null;
    if (assets.audio && !audioTrack) stopTrack(assets.audio);
    // Hint the encoder that this is full-frame MOTION (a film), so it paces a smooth
    // stream instead of spiky keyframe-heavy VBR — the pacing half of the anti-
    // bufferbloat fix (P0 #112 "stream on → ping spikes"). Best-effort: a platform
    // whose track doesn't expose contentHint (react-native-webrtc) just ignores it.
    setScreenContentHint(assets.video);
    try {
      await room.localParticipant.publishTrack(
        assets.video,
        screenSharePublishOptions(quality),
      );
      // System/loopback "film" audio (the movie's sound) is published as its OWN
      // track, from the SAME local participant as the video. That co-location is
      // what keeps A/V in sync with no extra work: both ride one PeerConnection to
      // the SFU, so the viewer's client aligns them via RTCP sender reports — video
      // and audio share a timeline and never drift. Publishing it (source
      // ScreenShareAudio) is ALSO what makes it reach viewers at all: livekit
      // auto-subscribes and auto-plays it on the receiver (desktop: managed remote-
      // audio elements; mobile: the native AudioSession) — same as voice.
      if (audioTrack) {
        try {
          await room.localParticipant.publishTrack(audioTrack, {
            source: TRACK_SOURCE.ScreenShareAudio,
            // Publish the film's sound as MUSIC, not as speech. Without these
            // livekit applies its voice defaults (~48 kbps mono + DTX) and the
            // movie arrives collapsed to mono, bitrate-starved, with quiet
            // passages gated (task #113).
            ...SCREEN_SHARE_AUDIO_PUBLISH,
          });
        } catch {
          // Publish video-only if the system-audio track can't be published.
          stopTrack(audioTrack);
          audioTrack = null;
        }
      }
    } catch {
      stopTrack(assets.video);
      stopTrack(audioTrack);
      const mapped: VoiceError = { kind: "device_unavailable", deviceId: "screen" };
      setState({ error: mapped });
      throw new VoiceOperationError(mapped);
    }

    // The user may have left/dropped while the publish was in flight. Don't
    // resurrect a share into a torn-down session — unpublish + stop and bail.
    if (epoch !== commandEpoch || state.status !== "connected" || !room) {
      if (room) {
        try {
          await room.localParticipant.unpublishTrack(assets.video, true);
        } catch {
          // best-effort
        }
        if (audioTrack) {
          try {
            await room.localParticipant.unpublishTrack(audioTrack, true);
          } catch {
            // best-effort
          }
        }
      }
      stopTrack(assets.video);
      stopTrack(audioTrack);
      return;
    }

    const onVideoEnded = (): void => {
      void handleScreenTrackEnded();
    };
    assets.video.addEventListener("ended", onVideoEnded);
    localScreenShare = { video: assets.video, audio: audioTrack, onVideoEnded };

    setState({
      screenShareEnabled: true,
      screenShareHasAudio: audioTrack !== null,
      // A freshly published film-audio track has NOT proven itself audible yet —
      // only the platform supervisor may set this (see setScreenShareAudioLive).
      screenShareAudioLive: false,
      error: null,
    });
    syncParticipants();
  }

  /**
   * Hot-swap the film-audio track of a live share. See the interface doc for WHY
   * (the source is often unknowable until the user presses play). Video is left
   * completely untouched, so the picture never blinks during a swap.
   */
  async function replaceScreenShareAudio(
    track: MediaStreamTrack | null,
  ): Promise<boolean> {
    // Only meaningful for a LIVE share on a live connection. A supervisor that
    // fires after the user stopped sharing must NOT resurrect audio.
    if (!room || !localScreenShare || state.status !== "connected") {
      if (track) stopTrack(track);
      return false;
    }
    const previous = localScreenShare.audio;
    if (previous === track) return false; // already published — nothing to do
    // Never publish an already-dead track (the same honesty guard startScreenShare
    // applies): it would flip screenShareHasAudio true and stream silence.
    if (track && track.readyState === "ended") {
      stopTrack(track);
      return false;
    }

    const share = localScreenShare;
    if (previous) {
      try {
        await room.localParticipant.unpublishTrack(previous, true);
      } catch {
        // best-effort — a failed unpublish must not block the new source
      }
      stopTrack(previous);
      share.audio = null;
    }

    // Stop / leave may have landed while the unpublish was in flight: never
    // publish into a share (or room) that is gone.
    if (localScreenShare !== share || !room || state.status !== "connected") {
      if (track) stopTrack(track);
      return false;
    }

    if (track) {
      try {
        await room.localParticipant.publishTrack(track, {
          source: TRACK_SOURCE.ScreenShareAudio,
          // Same music profile as the initial publish — a swapped-in film track
          // must never silently fall back to livekit's voice defaults (#113).
          ...SCREEN_SHARE_AUDIO_PUBLISH,
        });
      } catch {
        stopTrack(track);
        // The old track is already gone, so the share continues video-only
        // rather than pretending it still has sound.
        share.audio = null;
        setState({ screenShareHasAudio: false, screenShareAudioLive: false });
        syncParticipants();
        return false;
      }
    }

    // The share may have been torn down while the publish was in flight: take
    // the new track back off the SFU, not just stop it locally.
    if (localScreenShare !== share) {
      if (track) {
        try {
          await room?.localParticipant.unpublishTrack(track, true);
        } catch {
          // best-effort
        }
        stopTrack(track);
      }
      return false;
    }
    share.audio = track;
    setState({
      screenShareHasAudio: track !== null,
      // A new source starts unproven; the supervisor confirms it.
      screenShareAudioLive: false,
    });
    syncParticipants();
    return true;
  }

  function getLocalScreenShareAudioTrack(): MediaStreamTrack | null {
    return localScreenShare?.audio ?? null;
  }

  /** Record the supervisor's audibility verdict for the published film audio. */
  function setScreenShareAudioLive(live: boolean): void {
    // Never claim audible audio when none is published.
    if (live && (!state.screenShareHasAudio || !localScreenShare?.audio)) return;
    setState({ screenShareAudioLive: live });
  }

  async function stopScreenShare(): Promise<void> {
    // Deliberately GUARDLESS + idempotent. Stopping a share must ALWAYS reach a
    // clean no-share state, in ANY status. The old "connected"-only guard threw an
    // InvalidVoiceCommandError when the user hit Stop mid-reconnect; the store
    // swallowed it, so screenShareEnabled stayed stuck TRUE and the share button
    // was jammed on until the next leave (the founder's "stuck sharing" bug).
    //
    // Bump the command epoch so an in-flight startScreenShare (OS picker / publish
    // still running) sees the mismatch and aborts instead of resurrecting the share
    // by re-setting screenShareEnabled:true AFTER we tore it down (the start/stop
    // race). Mirrors leave()/join()/dispose(), which all bump the epoch too.
    commandEpoch++;
    const active = localScreenShare;
    localScreenShare = null; // clear first so the ended listener is a no-op
    if (active) {
      try {
        active.video.removeEventListener("ended", active.onVideoEnded);
      } catch {
        // ignore
      }
      if (room) {
        try {
          await room.localParticipant.unpublishTrack(active.video, true);
        } catch {
          // best-effort
        }
        if (active.audio) {
          try {
            await room.localParticipant.unpublishTrack(active.audio, true);
          } catch {
            // best-effort
          }
        }
      }
      stopTrack(active.video);
      stopTrack(active.audio);
    }
    // Reconcile to a DEFINITE no-share regardless of the path taken (a live share,
    // a stale flag with no track, or a stop while reconnecting all land here). Only
    // clear `error` when we actually tore a share down — otherwise a stop issued
    // with nothing to stop (e.g. already disconnected) must not mask an unrelated
    // connection error (server_unavailable / reconnect_failed).
    setState({
      screenShareEnabled: false,
      screenShareHasAudio: false,
      screenShareAudioLive: false,
      ...(active ? { error: null } : {}),
    });
    syncParticipants();
  }

  function getScreenShares(): RemoteScreenShare[] {
    return screenShareSnapshot;
  }

  function subscribeScreenShares(
    listener: (shares: RemoteScreenShare[]) => void,
  ): () => void {
    screenShareListeners.add(listener);
    return () => screenShareListeners.delete(listener);
  }

  // ── camera (task #18) ─────────────────────────────────────────────────────

  async function setCamera(enabled: boolean): Promise<void> {
    guard("SET_CAMERA"); // connected only
    if (enabled === state.cameraEnabled) return; // idempotent
    const lp = room?.localParticipant;
    // Degrade gracefully if the adapter can't publish a camera (e.g. a platform
    // whose adapter omits setCameraEnabled): surface a typed error, stay connected.
    if (!room || typeof lp?.setCameraEnabled !== "function") {
      const mapped: VoiceError = {
        kind: "device_unavailable",
        deviceId: "camera",
        device: "camera",
      };
      setState({ error: mapped });
      throw new VoiceOperationError(mapped);
    }
    // Flip the flag FIRST so the resulting localTrackUnpublished (on disable) is
    // recognised as intentional, not an unexpected track-end.
    setState({ cameraEnabled: enabled });
    try {
      // Pass the camera capture constraints (resolution/FPS) AND the explicit
      // publish encoding (bitrate ceiling) ONLY when enabling AND a video
      // preference is configured — the default path stays single-arg so
      // pre-settings behavior is unchanged. The publish options are what make
      // the camera sharp (livekit's default encoding is soft, esp. at 1080p).
      // Under bandwidth pressure these resolve to the constrained tier instead —
      // see bandwidth.ts (video only; audio is never throttled).
      const captureOptions = effectiveCameraCaptureOptions();
      const publishOptions = effectiveCameraPublishOptions();
      if (enabled && (captureOptions || publishOptions)) {
        await lp.setCameraEnabled(enabled, captureOptions, publishOptions);
      } else {
        await lp.setCameraEnabled(enabled);
      }
    } catch (err) {
      const mapped = mapAcquisitionError(err, "camera", state.selectedVideoDeviceId);
      // GRACEFUL DEGRADE (mobile P0): a camera that cannot do the REQUESTED
      // resolution/frame-rate must still turn on at whatever it can do — a phone's
      // front camera has no 1440p60 mode, and a quality tier chosen on a desktop
      // follows the account to the browser. Retry ONCE with the capture constraints
      // dropped (keeping the publish encoding, which is only a ceiling) before
      // giving up. Only for constraint-shaped failures: a permission denial or a
      // busy device would fail identically and the retry would just be noise.
      const retryable =
        enabled &&
        effectiveCameraCaptureOptions() !== undefined &&
        isConstraintFailure(mapped);
      if (!retryable) {
        setState({ cameraEnabled: false, error: mapped });
        syncParticipants();
        throw new VoiceOperationError(mapped);
      }
      try {
        await lp.setCameraEnabled(true, undefined, effectiveCameraPublishOptions());
      } catch (retryErr) {
        const retryMapped = mapAcquisitionError(
          retryErr,
          "camera",
          state.selectedVideoDeviceId,
        );
        setState({ cameraEnabled: false, error: retryMapped });
        syncParticipants();
        throw new VoiceOperationError(retryMapped);
      }
    }
    // Apply the preferred camera device now that a live track exists (mirrors how
    // join() restores the mic/output device). Non-fatal — keep the default camera
    // if the switch fails.
    if (enabled && state.selectedVideoDeviceId && room) {
      try {
        await room.switchActiveDevice("videoinput", state.selectedVideoDeviceId);
      } catch {
        // best-effort: the preferred camera may be gone; the default stays live.
      }
    }
    setState({ error: null });
    syncParticipants();
  }

  function getCameras(): RemoteCamera[] {
    return cameraSnapshot;
  }

  function subscribeCameras(listener: (cameras: RemoteCamera[]) => void): () => void {
    cameraListeners.add(listener);
    return () => cameraListeners.delete(listener);
  }

  // ── audio / video settings (Ayarlar → Mikrofon / görüntü) ─────────────────

  function configureAudio(settings: AudioSettings): void {
    const previous = audioSettings;
    audioSettings = settings;
    // Voice-activity sensitivity re-tunes the on-device speaking indicator live.
    localSpeakingDetector.setThreshold(
      speakingThresholdForSensitivity(settings.vadThreshold),
    );

    // Re-apply to the LIVE mic whenever ANYTHING that affects the published track
    // changed — capture DSP/sample-rate OR publish bitrate/RED/DTX/stereo. The old
    // code only watched the CAPTURE constraints, so changing the QUALITY tier
    // (bitrate/codec) did nothing — the founder's "changed the settings and
    // nothing changed" bug. And even a capture change went through restartAudioTrack,
    // which keeps the OLD publication's bitrate — so bitrate never actually moved.
    // Compare on the SIGNATURE form (processor-free); a fresh processor instance is
    // never serializable-equal, so it can't be part of the diff. Include the effective
    // NS TIER explicitly: with a filter available `high` and `off` both yield the same
    // capture booleans (WebRTC NS off), so only the tier distinguishes "run the worklet"
    // from "stop it" — without this a High→Off switch would never republish and the
    // worklet would keep running.
    const nextCapture = resolveMicCaptureOptions();
    const nextPublish = resolveMicPublishOptions();
    const prevCapture = micCaptureOptionsFrom(previous);
    const prevPublish = micPublishOptionsFrom(previous);
    const nextTier = effectiveNoiseSuppression(settings);
    const prevTier = previous ? effectiveNoiseSuppression(previous) : null;
    // Classify the change along its THREE independent axes, because each one has a
    // different cheapest-correct mechanism and the difference is audible:
    //  - publish (bitrate / RED / DTX / stereo) lives on the PUBLICATION → only a
    //    full unpublish+republish can move it (renegotiation, listeners re-subscribe).
    //  - capture (the DSP booleans, sample rate, channel count) lives on the
    //    getUserMedia track → retunable in place, or at worst re-acquired.
    //  - tier (high ↔ not-high) is just the RNNoise worklet → setProcessor /
    //    stopProcessor, a sender track swap with no renegotiation at all.
    // The old code collapsed all three into one boolean and answered every change
    // with a republish, so flipping Gürültü Engelleme tore the mic down and dropped
    // every listener's audio while the OS reopened the device — the founder's
    // "filtre hemen yansımıyor". Now each axis pays only its own cost.
    const publishChanged = JSON.stringify(prevPublish) !== JSON.stringify(nextPublish);
    const captureChanged = JSON.stringify(prevCapture) !== JSON.stringify(nextCapture);
    const tierChanged = prevTier !== nextTier;
    const changed = publishChanged || captureChanged || tierChanged;
    // Re-arm a running "kendini dinle" on ANY change — with or without a room.
    // This is the whole point of the feature: flip Yüksek → Standart in Ayarlar
    // and hear the difference immediately. Guarded by `changed` so unrelated
    // settings writes don't re-open the capture.
    if (changed) rearmSelfMonitoring();
    if (!changed || !room || state.status !== "connected" || !state.micEnabled) return;

    // Apply on the LIVE mic with the lightest mechanism each axis actually needs.
    // Best-effort throughout — on failure the new options apply on the next
    // unmute / rejoin, and we never tear the session down to force them.
    void (async () => {
      try {
        // DETACH the worklet FIRST when it is going away. Two reasons, both load-
        // bearing: the user asked for it to stop, so it must stop before anything
        // slower happens; and while a processor is attached the adapter's
        // `mediaStreamTrack` is the worklet's OUTPUT, so an in-place constraint
        // retune below would target the wrong track entirely.
        if (noiseFilterActive && !filterCapableForSettings(settings)) {
          await syncNoiseFilter();
        }

        if (publishChanged && typeof room.republishMicTrack === "function") {
          // Bitrate / RED / DTX / stereo genuinely live on the publication — a
          // republish is the only thing that moves them. This is the one path that
          // costs listeners a gap, and it is reached only by an audio-QUALITY or
          // Müzik Modu change, never by a plain noise-suppression switch.
          await room.republishMicTrack(nextCapture, nextPublish);
          // The old track (and with it any attached processor) is gone; the flag
          // must forget the processor that died with it or the re-attach below is
          // skipped as a no-op.
          noiseFilterActive = false;
        } else if (captureChanged && nextCapture) {
          await applyMicCaptureLive(nextCapture, prevCapture);
        }

        // Attach / detach the worklet to match the new tier. After a republish this
        // re-attaches onto the fresh track; after an in-place retune the existing
        // processor state is already correct and this is a cheap no-op.
        await syncNoiseFilter();
      } catch {
        // Best-effort — the new options apply on the next unmute / rejoin.
      }
    })();
  }

  /**
   * Apply changed CAPTURE constraints to the live mic without republishing, in
   * increasing order of cost. Only reached when the publish options are unchanged
   * (otherwise a republish already carried the capture along).
   *
   *  1. `applyMicCaptureConstraints` — retunes the SAME track. Zero gap: no
   *     re-acquire, no `replaceTrack`, no renegotiation. This is the path a
   *     Gürültü Engelleme / Yankı Engelleme / Otomatik Seviye change takes.
   *  2. `restartAudioTrack` — re-acquires getUserMedia and swaps the sender track,
   *     keeping the SAME publication (livekit `replaceTrack`, and it restarts any
   *     attached processor onto the new track). Listeners keep the track; only the
   *     local device reopen is audible. Required when the change is STRUCTURAL
   *     (sample rate / channel count), which cannot be retuned in place.
   *  3. `republishMicTrack` — last resort for adapters offering nothing lighter.
   */
  async function applyMicCaptureLive(
    next: AudioCaptureOptionsLike,
    prev: AudioCaptureOptionsLike | undefined,
  ): Promise<void> {
    if (!room) return;
    // Sample rate / channel count can only change by re-acquiring the device
    // (music mode's stereo capture is the real case), so skip the in-place attempt.
    const structural =
      !prev || prev.sampleRate !== next.sampleRate || prev.channelCount !== next.channelCount;
    if (!structural && typeof room.applyMicCaptureConstraints === "function") {
      if (await room.applyMicCaptureConstraints(next)) return;
    }
    if (typeof room.restartAudioTrack === "function") {
      await room.restartAudioTrack(next);
      return;
    }
    if (typeof room.republishMicTrack === "function") {
      await room.republishMicTrack(next, resolveMicPublishOptions());
      noiseFilterActive = false;
    }
  }

  function configureVideo(settings: VideoSettings): void {
    const prevCapture = cameraCaptureOptions;
    const prevPublish = cameraPublishOptions;
    cameraCaptureOptions = cameraCaptureOptionsFor(
      settings.cameraQuality,
      settings.cameraFrameRate,
    );
    cameraPublishOptions = cameraPublishOptionsFor(
      settings.cameraQuality,
      settings.cameraFrameRate,
    );
    // Live re-apply to a RUNNING camera so a resolution / FPS / bitrate change
    // takes effect mid-call (the founder's "every setting is live, no rejoin"
    // rule) — mirrors configureAudio. Only when connected with the camera ON and
    // the resolved options actually changed.
    const changed =
      JSON.stringify(prevCapture) !== JSON.stringify(cameraCaptureOptions) ||
      JSON.stringify(prevPublish) !== JSON.stringify(cameraPublishOptions);
    if (changed && room && state.status === "connected" && state.cameraEnabled) {
      void reapplyLiveCamera();
    }

    // Screen-share (yayın) live-apply: unlike the camera, the engine OWNS the
    // captured screen track, so a tier change while a share is live republishes
    // that same track with the new encoder ceiling — no stop/restart, no OS
    // picker (the founder's "change stream quality while broadcasting, apply
    // instantly" rule). Only when connected with a share actually live.
    const prevQuality = screenShareQuality;
    screenShareQuality = settings.screenShareQuality;
    if (prevQuality !== screenShareQuality) {
      // A fresh user choice overrides any auto-downgrade: clear the adaptive cap and
      // streaks so we publish exactly what they picked and the controller re-decides
      // from there (it may drop again if the uplink still can't sustain it).
      resetAdaptiveScreenShare();
      if (room && state.status === "connected" && localScreenShare) {
        void reapplyLiveScreenShare();
      }
    }
  }

  /**
   * Republish the LIVE screen-share VIDEO with the current {@link screenShareQuality}
   * so a tier change applies immediately. The encoder ceiling (bitrate + max
   * frame-rate) lives on the publication, so — exactly like the mic's
   * `republishMicTrack` — only an unpublish+republish can move it. We unpublish
   * WITHOUT stopping the raw capture track (`stopOnUnpublish: false`) and republish
   * the SAME track, so capture (and its OS "sharing" indicator + the co-published
   * film audio) is never interrupted; only the encoder budget changes. Best-effort:
   * on failure the share keeps its previous encoding rather than dropping.
   *
   * Note: this moves only the ENCODER ceiling — the capture resolution/frame-rate
   * were fixed at getDisplayMedia time (the caller's job), so raising the tier
   * lifts the bitrate/fps budget of the existing capture; a full capture-resolution
   * change still needs a re-share.
   */
  async function reapplyLiveScreenShare(): Promise<void> {
    if (!room || !localScreenShare) return;
    const video = localScreenShare.video;
    try {
      await room.localParticipant.unpublishTrack(video, false);
      await room.localParticipant.publishTrack(
        video,
        // EFFECTIVE tier: the adaptive uplink cap when the controller has lowered it,
        // else the user's selection. Both the user's live tier change (configureVideo)
        // and an auto up/down step route through here.
        screenSharePublishOptions(effectiveScreenShareQuality()),
      );
    } catch {
      // best-effort — the live share keeps its previous encoding on failure.
    }
  }

  /**
   * Republish the LIVE camera with the current capture + publish options so a
   * settings change applies immediately. The encoder bitrate lives on the
   * publication, so — like the mic — only an unpublish+republish can move it (a
   * capture-only restart would keep the old bitrate). Guarded by
   * {@link republishingCamera} so the intermediate unpublish isn't read as an
   * unexpected track-end. Best-effort: on failure the camera turns off with a
   * typed error (§26) rather than lingering in a broken state.
   */
  async function reapplyLiveCamera(): Promise<void> {
    const lp = room?.localParticipant;
    if (!room || typeof lp?.setCameraEnabled !== "function") return;
    republishingCamera = true;
    try {
      await lp.setCameraEnabled(false);
      await lp.setCameraEnabled(
        true,
        effectiveCameraCaptureOptions(),
        effectiveCameraPublishOptions(),
      );
      if (state.selectedVideoDeviceId) {
        try {
          await room.switchActiveDevice("videoinput", state.selectedVideoDeviceId);
        } catch {
          // best-effort — keep the default camera if the preferred one is gone.
        }
      }
    } catch (err) {
      setState({
        cameraEnabled: false,
        error: mapAcquisitionError(err, "camera", state.selectedVideoDeviceId),
      });
      syncParticipants();
    } finally {
      republishingCamera = false;
    }
  }

  /**
   * Pin (or release) the preferred simulcast layer for one REMOTE camera —
   * the subscriber-side half of the sharpness fix. The UI calls "high" when a
   * camera is focused/fullscreened (so the SFU sends the top layer instead of the
   * small-tile low layer adaptiveStream would otherwise pick) and "auto" when it
   * shrinks back to a tile. Best-effort, no-throw; a no-op when the adapter can't
   * select a layer. Legal in any status (guarded by the adapter presence).
   */
  function setRemoteCameraQuality(identity: string, quality: "high" | "auto"): void {
    room?.setRemoteCameraQuality?.(identity, quality);
  }

  /**
   * Subscribe/unsubscribe from one REMOTE camera — the harder bandwidth lever
   * next to {@link setRemoteCameraQuality}. Where quality only pins a simulcast
   * LAYER, this toggles the whole SUBSCRIPTION: `false` tells the SFU to stop
   * forwarding the stream when the UI has HIDDEN the camera (fullscreen PiP
   * closed / camera strip collapsed); `true` resumes it. Best-effort, no-throw; a
   * no-op when the adapter can't toggle a subscription. Legal in any status
   * (guarded by the adapter presence). Unsubscribing emits `TrackUnsubscribed`,
   * which drops the camera from `remoteCameras`; re-subscribing re-seeds it via
   * `TrackSubscribed`.
   */
  function setRemoteCameraSubscribed(identity: string, subscribed: boolean): void {
    room?.setRemoteCameraSubscribed?.(identity, subscribed);
  }

  async function dispose(): Promise<void> {
    listeners.clear();
    screenShareListeners.clear();
    cameraListeners.clear();
    commandEpoch++;
    // Release the monitor's capture + worklet + audio context before anything
    // else — dispose is the renderer unmount, so nothing may survive it.
    await stopSelfMonitoring(false);
    stopLocalSpeaking();
    stopConnectionQuality();
    const active = room;
    releaseRoom();
    speakingIdentities = new Set();
    teardownLocalScreenShare();
    clearRemoteScreenShares();
    clearRemoteCameras();
    if (active) {
      try {
        await active.disconnect();
      } catch {
        // Best-effort teardown.
      }
    }
    state = { ...initialVoiceState };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    join,
    leave,
    handleSessionReplaced,
    handleForcedDisconnect,
    clearEndedReason,
    setSurfaceKind,
    setMic,
    setDeafened,
    setInputDevice,
    setOutputDevice,
    setParticipantVolume,
    getParticipantVolume,
    setScreenShareVolume,
    getScreenShareVolume,
    setVideoDevice,
    setCamera,
    setAudioBitrateKbps(kbps: number | null): void {
      audioBitrateKbps = normalizeAudioBitrate(kbps);
    },
    configureAudio,
    setSelfMonitoring,
    configureVideo,
    setBandwidthPressure,
    setRemoteCameraQuality,
    setRemoteCameraSubscribed,
    startScreenShare,
    stopScreenShare,
    replaceScreenShareAudio,
    setScreenShareAudioLive,
    getLocalScreenShareAudioTrack,
    getScreenShares,
    subscribeScreenShares,
    getCameras,
    subscribeCameras,
    dispose,
  };
}
