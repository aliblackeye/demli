/**
 * Structural subset of the livekit-client `Room` surface the voice engine
 * uses. The engine depends on this interface — never on livekit-client
 * directly — so the FSM is unit-testable with a fake room and the real
 * SDK is only loaded via the web entry (see livekit.ts).
 *
 * This file is livekit-free (it imports only pure, RN-safe voice-model types
 * from `state.ts`) so it stays reachable from the RN-safe package root. The
 * compile-time pin that guarantees these event-name string constants match
 * livekit's `RoomEvent` enum lives in the web-only `livekit.ts`, where importing
 * the SDK types is fine.
 */

import type { ConnectionQualityLevel } from "./state.js";

/**
 * LiveKit room event names the engine subscribes to. Values are pinned to
 * the real `RoomEvent` enum at compile time (see the check in livekit.ts).
 */
export const ROOM_EVENT = {
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  LocalTrackUnpublished: "localTrackUnpublished",
  MediaDevicesError: "mediaDevicesError",
  // Screen share (Milestone 4) AND camera (task #18): remote screen-share and
  // camera video tracks both arrive/leave through these two events; the engine
  // routes on the publication's `source`.
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  // A participant's custom ATTRIBUTES changed (livekit `Participant.attributes`,
  // a key/value map). Carries the DEAFEN flag (see PARTICIPANT_ATTR) — a
  // listener-side client state LiveKit does not model natively — so a remote's
  // headphone-off badge updates the instant they (un)deafen.
  ParticipantAttributesChanged: "participantAttributesChanged",
} as const;

export type RoomEventName = (typeof ROOM_EVENT)[keyof typeof ROOM_EVENT];

/**
 * Custom LiveKit participant-ATTRIBUTE keys (livekit's `Participant.attributes`,
 * a `Record<string, string>`). Attributes are how the client broadcasts a piece of
 * per-participant state LiveKit does not model natively — today the DEAFEN flag,
 * which is purely a LISTENER-side client state (§11) LiveKit never puts on the wire
 * (mute is a track state; deafen is not). The value is `"1"` when set / `""` (which
 * livekit treats as a delete) when cleared. §24: a typed constant, never a raw
 * `"deafened"` magic-string scattered across the engine + platform adapters.
 */
export const PARTICIPANT_ATTR = {
  deafened: "deafened",
} as const;

export type ParticipantAttrKey = (typeof PARTICIPANT_ATTR)[keyof typeof PARTICIPANT_ATTR];

/**
 * The subset of livekit's numeric `DisconnectReason` the engine treats as a CLEAN
 * eviction rather than a failure — the single-active-voice-session model:
 *  - DuplicateIdentity: another device connected to the SAME room with our
 *    identity, so the SFU closed this (older) connection (same-room rejoin).
 *  - ParticipantRemoved: the API `RoomServiceClient.removeParticipant` kicked us
 *    because we joined a DIFFERENT room from another device (cross-room eviction).
 * Both mean "your session was replaced", NOT "the server is unavailable", so the
 * engine returns cleanly to idle with `endedReason: "session_replaced"` instead of
 * surfacing the scary §26 error. Values are pinned to livekit's real enum at
 * compile time in the web entry (see livekit.ts) so they can never silently drift.
 * This file stays livekit-free (RN-safe root); the numbers are the wire contract.
 */
export const DISCONNECT_REASON = {
  DuplicateIdentity: 2,
  ParticipantRemoved: 4,
} as const;

export type DisconnectReasonValue = (typeof DISCONNECT_REASON)[keyof typeof DISCONNECT_REASON];

/** True when a Disconnected `reason` is a clean single-session eviction (see above). */
export function isEvictionDisconnect(reason: unknown): boolean {
  return (
    reason === DISCONNECT_REASON.DuplicateIdentity ||
    reason === DISCONNECT_REASON.ParticipantRemoved
  );
}

/** Track source values, mirroring livekit's `Track.Source`. */
export const TRACK_SOURCE = {
  Microphone: "microphone",
  /** Local/remote camera video (task #18) — separate from ScreenShare. */
  Camera: "camera",
  ScreenShare: "screen_share",
  ScreenShareAudio: "screen_share_audio",
} as const;

export interface ParticipantLike {
  readonly identity: string;
  readonly isMicrophoneEnabled: boolean;
  readonly isScreenShareEnabled: boolean;
  /**
   * The participant's custom ATTRIBUTES (livekit's `Participant.attributes`,
   * a `Record<string, string>`). The engine reads {@link PARTICIPANT_ATTR.deafened}
   * off a REMOTE to derive that peer's deafen badge — both the initial value at
   * connect (late-joiner seed) and every later `ParticipantAttributesChanged`.
   * Optional so a bare/local participant stub stays valid (the LOCAL user's deafen
   * comes from `VoiceState.deafened`, never this).
   */
  readonly attributes?: Record<string, string>;
}

/** Encoder ceiling — structural subset of livekit's `VideoEncoding`. */
export interface VideoEncodingLike {
  /** Max encoder bitrate in bits per second. */
  maxBitrate: number;
  maxFramerate?: number;
}

/**
 * ONE custom simulcast LAYER for {@link VideoPublishOptionsLike.videoSimulcastLayers}
 * — a structural subset of livekit's `VideoPreset` (only the fields livekit reads
 * off a layer at publish: `width`/`height` + the `encoding` budget). Kept as plain
 * data (NOT a `VideoPreset` instance) so `packages/media` stays livekit-free and
 * RN-safe; livekit consumes it by field access (`encodingsFromPresets`), so a plain
 * object is byte-for-byte equivalent to a `VideoPreset` for this use. The compile-
 * time pin in livekit.ts (`VideoPreset extends SimulcastLayerLike`) guarantees these
 * three fields never drift from the SDK.
 */
export interface SimulcastLayerLike {
  readonly width: number;
  readonly height: number;
  readonly encoding: VideoEncodingLike;
}

/** Mic publish preset — structural subset of livekit's `AudioPreset`. */
export interface AudioPresetLike {
  /** Max audio encoder bitrate in bits per second. */
  maxBitrate: number;
}

/**
 * Camera VIDEO publish options — structural subset of livekit's
 * `TrackPublishOptions` (third arg of `setCameraEnabled`). Carries the explicit
 * encoder ceiling (`videoEncoding.maxBitrate`) so a 1080p camera is published at
 * a genuinely sharp bitrate instead of livekit's conservative default (h1080 =
 * 3 Mbps). Pinned to a valid `TrackPublishOptions` in livekit.ts.
 */
export interface VideoPublishOptionsLike {
  /** Encoder ceiling for the primary (top simulcast) layer. */
  videoEncoding?: VideoEncodingLike;
  /**
   * Whether to publish the camera as SIMULCAST (multiple layers) or a single
   * full-quality stream. livekit's default is `true` with THREE conservative layers
   * whose lowest is a fixed 320×180 @ ~160 kbps — and the aggressive `videoEncoding`
   * bitrate above lifts ONLY the top layer. An earlier wave therefore turned
   * simulcast OFF so every subscriber got the full sharp stream; but a SINGLE layer
   * has no fallback, so a weak subscriber on a real network could not keep up and the
   * picture STALLED/FROZE (the founder's "takılma/donma" report).
   *
   * We now publish CUSTOM simulcast (see {@link videoSimulcastLayers}): exactly two
   * layers — a usable low (~640×360 @ 500 kbps, far above livekit's 320×180 default)
   * and the aggressive top (`videoEncoding`, full 720p/1080p). A weak subscriber /
   * small tile rides the low layer and never stalls; a focused/fullscreen tile is
   * large, so `adaptiveStream` requests HIGH and it pulls the sharp top layer. The
   * only cost is a brief dynacast layer-resume when a tile is first focused — an
   * acceptable trade for never freezing a weak viewer (CLAUDE.md §6). Pinned to a
   * valid `TrackPublishOptions` in livekit.ts.
   */
  simulcast?: boolean;
  /**
   * CUSTOM simulcast layers below the top (`videoEncoding`) layer — livekit's
   * `TrackPublishOptions.videoSimulcastLayers`. Passing exactly ONE low layer yields
   * a TWO-layer encode (low + top): livekit takes this as the low preset and the
   * `videoEncoding` bitrate as the top, so we get a deliberate low/high split instead
   * of livekit's soft 3-layer default. Only meaningful when {@link simulcast} is on.
   * Plain data (see {@link SimulcastLayerLike}); livekit reads it by field access.
   */
  videoSimulcastLayers?: readonly SimulcastLayerLike[];
  /**
   * How the CAMERA encoder SHEDS quality under CPU / bandwidth / thermal pressure —
   * a subset of the DOM `RTCDegradationPreference`, pinned valid against livekit's
   * `TrackPublishOptions` in livekit.ts. Distinct from the screen-share field of the
   * same name on {@link TrackPublishOptionsLike}: a face and a film want OPPOSITE
   * trades, so the two must never be unified.
   *
   * The engine sets `balanced` here (see `CAMERA_DEGRADATION_PREFERENCE`), matching
   * libwebrtc/livekit's own camera default. The two absolutes are both wrong for a
   * camera: `maintain-framerate` collapses resolution to a blur, and
   * `maintain-resolution` forbids downscaling so a constrained phone can only shed
   * frame-rate — down to libwebrtc's ~2fps floor, which viewers see as a FROZEN
   * camera (the mobile-camera-freeze P0). `balanced` drops resolution first and
   * keeps an fps floor per resolution bucket, so the picture always keeps moving.
   */
  degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution";
}

/** Options passed to `publishTrack` — a structural subset of livekit's `TrackPublishOptions`. */
export interface TrackPublishOptionsLike {
  /** One of {@link TRACK_SOURCE} — labels the track so peers can identify it. */
  source: string;
  name?: string;
  /**
   * Encoder ceiling for a screen-share VIDEO track (the quality matrix).
   * livekit reads this — not `videoEncoding` — for `screen_share` sources.
   */
  screenShareEncoding?: VideoEncodingLike;
  /**
   * How the screen-share encoder SHEDS quality under CPU / bandwidth pressure — a
   * subset of the DOM `RTCDegradationPreference` (valid against livekit's
   * `TrackPublishOptions.degradationPreference`; the same union is compile-pinned on
   * {@link VideoPublishOptionsLike}). The engine sets `maintain-framerate` for a
   * screen share so a film stays SMOOTH under congestion — the encoder scales
   * resolution down rather than dropping frames — pairing with the `motion` content
   * hint. Without it libwebrtc's screen-content default (`maintain-resolution`) can
   * stutter and, with spiky VBR pacing, overshoot the bitrate cap → bufferbloat.
   */
  degradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution";
  /**
   * Opus knobs for a published AUDIO track — same four livekit reads off
   * `TrackPublishOptions` for the mic (see {@link MicPublishOptionsLike}), exposed
   * here because SYSTEM/loopback audio (the film's sound, source
   * `ScreenShareAudio`) is published through `publishTrack`, not the mic path.
   *
   * They matter: with none of them set livekit falls back to its own audio
   * defaults — ~48 kbps MONO with DTX on — which is a voice profile applied to a
   * MOVIE. Mono collapses the stereo mix, 48 kbps is a music-quality floor, and
   * DTX gates quiet passages (a held note or a fade reads as a dropout). The
   * engine passes the Müzik-tier profile instead (see
   * `SCREEN_SHARE_AUDIO_PUBLISH` in audio-settings.ts).
   */
  audioPreset?: AudioPresetLike;
  dtx?: boolean;
  red?: boolean;
  forceStereo?: boolean;
}

/**
 * Publish options for the mic track — structural subset of livekit's
 * `TrackPublishOptions` (third argument of `setMicrophoneEnabled`). Beyond the
 * bitrate preset it carries the Opus codec knobs that make voice/music sound
 * good over a lossy link (audio-settings.ts owns the per-tier values):
 *  - `red`   — Redundant Encoding (RED): re-sends recent audio so a dropped
 *    packet doesn't punch a hole in speech. Cheap insurance; on for every tier.
 *  - `dtx`   — Discontinuous Transmission: stop sending during silence (saves
 *    bandwidth, natural for voice). OFF for Müzik Modu so sustained/quiet notes
 *    are never gated.
 *  - `forceStereo` — publish 2-channel Opus (Müzik Modu / studio use).
 */
export interface MicPublishOptionsLike {
  audioPreset?: AudioPresetLike;
  dtx?: boolean;
  red?: boolean;
  forceStereo?: boolean;
}

/**
 * The runtime arguments livekit hands an audio {@link AudioTrackProcessorLike} — a
 * structural subset of livekit's `AudioProcessorOptions`: the raw captured mic
 * track and the shared `AudioContext` the processor builds its graph on. Kept
 * livekit-free (only DOM lib types, like the rest of this file) so the RN-safe
 * root stays clean; the pin in livekit.ts guarantees it matches the SDK shape.
 */
export interface AudioProcessorOptionsLike {
  /** The raw captured mic MediaStreamTrack to process. */
  track: MediaStreamTrack;
  /** The AudioContext to build the processing graph on (livekit owns it). */
  audioContext: AudioContext;
}

/**
 * An audio TRACK PROCESSOR — a structural subset of livekit's
 * `TrackProcessor<Track.Kind.Audio>`. This is the seam for the "Yüksek (Krisp
 * benzeri)" noise-suppression tier: an RNNoise WASM AudioWorklet inserted BETWEEN
 * the AEC'd getUserMedia track and the publish. livekit calls `init` with the raw
 * track + AudioContext, publishes {@link processedTrack} instead of the raw track,
 * calls `restart` on a device switch, and `destroy` when the track is torn down.
 *
 * The IMPLEMENTATION is platform-owned (the desktop renderer bundles the worklet +
 * WASM and injects a factory via `VoiceEngineOptions.createNoiseFilter`); this
 * package only references the structural type, so the RN-safe root never pulls a
 * worklet asset. The pin in livekit.ts guarantees this stays assignable to the SDK
 * `TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>`.
 */
export interface AudioTrackProcessorLike {
  /** Stable processor name (livekit dedupes by it). */
  name: string;
  init(opts: AudioProcessorOptionsLike): Promise<void>;
  restart(opts: AudioProcessorOptionsLike): Promise<void>;
  destroy(): Promise<void>;
  /** The processed track livekit publishes in place of the raw mic track. */
  processedTrack?: MediaStreamTrack;
}

/**
 * Mic CAPTURE constraints (getUserMedia audio DSP) — structural subset of
 * livekit's `AudioCaptureOptions` (second argument of `setMicrophoneEnabled`
 * and the argument to `restartAudioTrack`). These are the user's audio-processing
 * toggles (Ses işleme): noise suppression, echo cancellation, auto gain — plus
 * the music/studio override that turns them all off (see audio-settings.ts). The
 * pin in livekit.ts guarantees this stays a valid `AudioCaptureOptions`.
 */
export interface AudioCaptureOptionsLike {
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  /** Capture sample rate — pinned to 48 kHz so Opus runs at full fidelity. */
  sampleRate?: number;
  /** Capture channel count — 2 for Müzik Modu (stereo), 1 otherwise. */
  channelCount?: number;
}

/**
 * Camera CAPTURE constraints — structural subset of livekit's
 * `VideoCaptureOptions` (second argument of `setCameraEnabled`). Carries the
 * camera-quality resolution + frame-rate (Kamera kalitesi / FPS, see
 * video-settings.ts). Pinned to a valid `VideoCaptureOptions` in livekit.ts.
 */
export interface VideoCaptureOptionsLike {
  /** Target resolution + frame-rate; a structural subset of livekit's `VideoResolution`. */
  resolution?: { width: number; height: number; frameRate?: number };
}

/** A published local track handle — a structural subset of livekit's `LocalTrackPublication`. */
export interface LocalTrackPublicationLike {
  readonly source?: string;
  readonly trackSid?: string;
}

export interface LocalParticipantLike extends ParticipantLike {
  /**
   * Enable/disable the mic. The optional second argument carries the CAPTURE
   * constraints (the audio-processing toggles / music mode); the third carries
   * publish options (mic bitrate preset, M8). Both are passed only when the
   * engine has a preference configured, so the default publish path (no extra
   * args) is byte-for-byte the pre-settings behavior. Implementations may ignore
   * the extra arguments (mobile forwards them to livekit).
   */
  setMicrophoneEnabled(
    enabled: boolean,
    captureOptions?: AudioCaptureOptionsLike,
    publishOptions?: MicPublishOptionsLike,
  ): Promise<unknown>;
  /**
   * Enable/disable the local CAMERA (task #18). livekit's `setCameraEnabled`
   * acquires and publishes the camera track itself (source `camera`) — unlike
   * screen share, the engine does NOT hand it a pre-captured track. The optional
   * second argument carries the CAMERA capture constraints (resolution + FPS,
   * Kamera kalitesi); the publish options are never used by the engine (pinned to
   * `undefined`). Capture options are passed only when a video preference is
   * configured, so the default path can't drift.
   *
   * OPTIONAL adapter surface: the web/Electron adapter (a livekit `Room`)
   * provides it structurally; a platform whose adapter omits it degrades to
   * "camera unsupported" (the engine surfaces a typed error instead of throwing).
   *
   * The third argument carries the camera PUBLISH options — the explicit
   * `videoEncoding` bitrate ceiling (video-settings.ts), so 1080p is published
   * sharp rather than at livekit's soft default. Passed only when a video
   * preference is configured, so the default path can't drift.
   */
  setCameraEnabled?(
    enabled: boolean,
    captureOptions?: VideoCaptureOptionsLike,
    publishOptions?: VideoPublishOptionsLike,
  ): Promise<LocalTrackPublicationLike | undefined>;
  /**
   * Publish an already-acquired MediaStreamTrack (screen video / system audio).
   * The renderer acquires the screen stream (Electron capture bridge +
   * getDisplayMedia); the engine only publishes it — see engine.startScreenShare.
   */
  publishTrack(
    track: MediaStreamTrack,
    options: TrackPublishOptionsLike,
  ): Promise<LocalTrackPublicationLike>;
  /** Unpublish a previously published track; `stopOnUnpublish` stops the raw track. */
  unpublishTrack(
    track: MediaStreamTrack,
    stopOnUnpublish?: boolean,
  ): Promise<LocalTrackPublicationLike | undefined>;
}

/**
 * Which of a remote's audio publications a volume applies to. livekit's
 * `RemoteParticipant.setVolume(volume, source)` is PER-SOURCE, so the LISTENER can
 * scale a person's VOICE (`microphone`) independently of what they're BROADCASTING
 * (`screen_share_audio`, the film's sound) — the voice-vs-share volume split.
 * Values equal livekit's `Track.Source` members. Defaults to `microphone`
 * so the pre-existing single-arg calls (voice volume + deafen) are unchanged.
 */
export type RemoteAudioSourceLike = "microphone" | "screen_share_audio";

export interface RemoteParticipantLike extends ParticipantLike {
  /**
   * Set this remote's playback volume WITHOUT touching tracks (client-side only):
   *  - deafen uses 0 (master mute) / restore,
   *  - per-user "User Volume" uses 0..ceiling (0=muted, 1=100%; the engine's
   *    `maxParticipantVolume` — 2 on native playout, 1 on `<audio>` elements).
   * The web adapter (livekit `RemoteParticipant.setVolume`) scales the remote's own
   * audio elements, whose `volume` throws above 1 — which is why desktop/web engines
   * run with a 100% ceiling. Nothing crosses the SFU or WebSocket (§10/§35).
   *
   * The optional `source` targets ONE of the remote's audio publications
   * (`microphone` vs `screen_share_audio`) so the film's audio can be scaled apart
   * from the person's voice — a separate share volume. Defaults to
   * `microphone`, so every pre-existing call (voice per-user volume + deafen) keeps
   * its exact behavior. livekit stores the value per-source and re-applies it when
   * the matching track (re)subscribes, so setting it before the film-audio track
   * arrives still takes effect.
   */
  setVolume(volume: number, source?: RemoteAudioSourceLike): void;
}

export interface TrackPublicationLike {
  readonly source: string;
  /**
   * Whether this publication is currently muted. livekit sets it before it emits
   * `TrackMuted`/`TrackUnmuted`, so the engine can read it inside those handlers.
   * Optional so a bare publication (older adapters / the mic-only path) stays valid.
   */
  readonly isMuted?: boolean;
  /**
   * The subscribed remote track this publication carries, when it has one. Present
   * on a `RemoteTrackPublication` at `TrackMuted`/`TrackUnmuted` time. The engine
   * needs it to RE-BIND a remote CAMERA on unmute: livekit MUTES (never
   * unpublishes) a camera that is turned off, so `TrackSubscribed`/`Unsubscribed`
   * never fire for a camera toggle — only these mute events do (see engine.ts).
   */
  readonly track?: RemoteTrackLike | null;
}

/**
 * A subscribed remote media track the UI can render (a remote SCREEN SHARE or
 * CAMERA video track — task #18). Attaching via the track's own
 * `attach(element)` (rather than a raw `srcObject`) is REQUIRED because the room
 * uses `adaptiveStream` — livekit needs the bound element to decide which
 * simulcast layer to stream (see livekit.ts). Structural subset of livekit's
 * `RemoteVideoTrack`.
 */
export interface RemoteTrackLike {
  readonly kind: string;
  readonly mediaStreamTrack: MediaStreamTrack;
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
}

/** Subset of livekit's `RemoteTrackPublication` the engine reads on subscribe. */
export interface RemoteTrackPublicationLike {
  readonly source: string;
  /**
   * Whether the track is muted at subscribe time. A remote CAMERA that is
   * published-but-off (joined with the camera muted) subscribes muted; the engine
   * skips rendering it so a black tile never appears (see onTrackSubscribed).
   */
  readonly isMuted?: boolean;
}

/**
 * One already-subscribed remote video track captured for the late-joiner SEED
 * (see {@link VoiceRoomAdapter.seedRemoteVideoTracks}). Shaped so the engine can
 * replay it through its normal `onTrackSubscribed(track, publication, participant)`
 * path — identical camera-vs-screen-share routing and camera mute-gating.
 */
export interface SeededRemoteVideoTrack {
  readonly track: RemoteTrackLike;
  readonly publication: RemoteTrackPublicationLike;
  readonly participant: RemoteParticipantLike;
}

/**
 * `(...args: never[]) => void` accepts any concrete listener signature;
 * handlers narrow their own arguments.
 */
export type RoomListener = (...args: never[]) => void;

/**
 * A live meter for the LOCAL mic's real-time input level, sampled ON-DEVICE
 * (WebAudio) so the local speaking indicator never waits on the SFU's
 * active-speaker round-trip (task #54). The engine polls {@link level} on an
 * interval and feeds it to its speaking detector.
 *
 * Implementations must self-heal: `level()` re-resolves the current mic track
 * each call, so it stays correct across mute/unmute, device switches, and
 * reconnects without the engine re-creating the meter.
 */
export interface LocalAudioMeter {
  /**
   * Current mic input level in [0,1] (RMS-ish). Returns 0 when there is no live
   * or enabled local mic track (muted → alive-but-silent → ~0). Must not throw.
   */
  level(): number;
  /** Release the underlying audio nodes/context. Safe to call more than once. */
  close(): void;
}

/**
 * A live probe of the LOCAL connection's quality + round-trip time (task #55).
 * The engine polls it on a ~1s interval while connected and writes a throttled
 * summary into `VoiceState.connectionQuality` for the ping indicator.
 *
 * Like {@link LocalAudioMeter}, implementations must self-heal: each call
 * re-reads the current room/transport, so the probe stays correct across
 * reconnects (the room object survives a reconnect) without the engine
 * re-creating it. Neither method may throw — read as "unknown"/null on any error.
 */
export interface ConnectionQualityProbe {
  /**
   * Current coarse quality level. `"unknown"` before the transport reports one.
   * Must not throw.
   */
  level(): ConnectionQualityLevel;
  /**
   * Current round-trip time in ms, or null when unavailable. Must not throw.
   */
  rttMs(): number | null;
  /** Release any retained resources. Safe to call more than once. */
  close(): void;
}

export interface VoiceRoomAdapter {
  on(event: RoomEventName, listener: RoomListener): unknown;
  off(event: RoomEventName, listener: RoomListener): unknown;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  readonly localParticipant: LocalParticipantLike;
  readonly remoteParticipants: ReadonlyMap<string, RemoteParticipantLike>;
  switchActiveDevice(
    kind: "audioinput" | "audiooutput" | "videoinput",
    deviceId: string,
  ): Promise<unknown>;
  /**
   * OPTIONAL: publish ONE attribute on the LOCAL participant so peers learn a
   * client-only state LiveKit does not broadcast natively — today the DEAFEN flag
   * ({@link PARTICIPANT_ATTR.deafened}, §11). Maps to livekit's
   * `LocalParticipant.setAttributes({ [key]: value })`: a MERGE (it never clobbers
   * other attributes), where an empty-string value deletes the key. Peers receive
   * it via `ParticipantAttributesChanged`. The engine calls this fire-and-forget
   * (on deafen toggle, and re-asserted on join/reconnect since deafen survives a
   * session), so it must NOT throw synchronously and should reject rather than
   * throw on failure — deafen is local-first, the peer badge is best-effort. Both
   * platform adapters implement it; a platform that omits it simply does not
   * broadcast deafen (peers won't see the badge, local behaviour is unaffected).
   */
  setLocalAttribute?(key: string, value: string): Promise<void>;
  /**
   * Optional: build a meter for on-device local mic level so the local speaking
   * indicator is computed locally instead of waiting for the server. Returns
   * null when the platform cannot sample locally; the engine then falls back to
   * server-driven (activeSpeakersChanged) speaking for the local user too.
   * Only the web/Electron adapter implements this today (mobile omits it).
   */
  createLocalAudioMeter?(): LocalAudioMeter | null;
  /**
   * Optional: build a probe for the local connection quality + RTT so the FSM can
   * surface a ping/quality indicator (task #55). Returns null when the platform
   * cannot sample it; the engine then leaves `connectionQuality` as
   * `UNKNOWN_CONNECTION_QUALITY` (the indicator hides). Both the web/Electron and
   * RN adapters implement this — it reads from the shared livekit `Room`.
   */
  createConnectionQualityProbe?(): ConnectionQualityProbe | null;
  /**
   * OPTIONAL: re-acquire the LIVE mic track with new capture constraints so an
   * audio-settings change (music mode, a DSP toggle) applies WITHOUT a
   * leave/rejoin — livekit's `LocalAudioTrack.restartTrack`. Best-effort: only
   * called by the engine while connected with the mic on; adapters that omit it
   * simply apply the new constraints on the next mic publish (unmute/rejoin).
   */
  restartAudioTrack?(captureOptions: AudioCaptureOptionsLike): Promise<void>;
  /**
   * OPTIONAL: retune the LIVE mic capture's DSP constraints IN PLACE — the
   * zero-interruption path for a Gürültü Engelleme / Yankı Engelleme / Otomatik
   * Seviye change.
   *
   * `MediaStreamTrack.applyConstraints` retunes the SAME capture track: no
   * getUserMedia re-acquire, no `replaceTrack`, no renegotiation, so the far end
   * hears no gap at all. This is what makes the setting land the instant it is
   * clicked, which is the whole point — the previous behaviour tore the mic down
   * and republished it, which dropped every listener's audio for as long as the
   * OS took to reopen the device.
   *
   * Returns TRUE only when the constraints were really applied. FALSE means "not
   * possible here" (no live track, a processor is attached so `mediaStreamTrack`
   * is the processed output rather than the capture, or the browser rejected the
   * constraint set) — the engine then falls back to {@link restartAudioTrack} and,
   * failing that, {@link republishMicTrack}. Never throws: an unsupported
   * constraint must degrade to the heavier path, not surface as a media error.
   *
   * ONLY the DSP booleans belong here. `sampleRate` / `channelCount` cannot be
   * retuned on a live capture — the engine routes those to a re-acquire instead.
   */
  applyMicCaptureConstraints?(captureOptions: AudioCaptureOptionsLike): Promise<boolean>;
  /**
   * OPTIONAL: fully RE-PUBLISH the live mic track with new capture constraints
   * AND publish options. Unlike {@link restartAudioTrack} (which only swaps the
   * getUserMedia track and keeps the old publication's bitrate/codec), this
   * unpublishes and republishes so a change to the audio QUALITY tier — bitrate,
   * RED/DTX, stereo — actually takes effect mid-call. This is the fix for
   * "changed the audio settings and nothing changed": the bitrate/codec live on
   * the publication, so only a republish can update them. Best-effort; adapters
   * that omit it fall back to `restartAudioTrack` (capture-only) then the next
   * mic publish. Only called while connected with the mic live.
   */
  republishMicTrack?(
    captureOptions: AudioCaptureOptionsLike | undefined,
    publishOptions: MicPublishOptionsLike | undefined,
  ): Promise<void>;
  /**
   * OPTIONAL: attach (`processor`) or detach (`null`) an audio track processor — the
   * RNNoise worklet behind the "Yüksek" NS tier — on the LIVE mic track. Applied
   * here rather than through capture options because livekit 2.x builds the mic
   * track before its AudioContext is set, so a capture-options processor throws;
   * the adapter sets the track's AudioContext first, then `setProcessor` /
   * `stopProcessor` (see livekit.ts). Called by the engine after a mic publish (join
   * / unmute / republish) and on an NS-tier change. Best-effort: on failure the mic
   * keeps its built-in WebRTC NS fallback (never left silent). Only the web/Electron
   * adapter implements it — mobile omits it (no worklet asset yet), so the engine
   * degrades `high` to `standard` there. Must not throw synchronously.
   */
  applyNoiseFilter?(processor: AudioTrackProcessorLike | null): Promise<void>;
  /**
   * OPTIONAL: pin the preferred simulcast layer for one remote CAMERA. With
   * `adaptiveStream` on, a small tile pulls a LOW layer — so a focused/fullscreen
   * camera can look soft. The UI calls this with `"high"` when a camera is
   * promoted to the stage (request the top layer) and `"auto"` when it returns to
   * a small tile (hand control back to adaptiveStream / a low layer). No-op for
   * platforms/tracks that can't select a layer. Best-effort — must not throw.
   */
  setRemoteCameraQuality?(identity: string, quality: "high" | "auto"): void;
  /**
   * OPTIONAL: subscribe/unsubscribe from one remote CAMERA's video track. Where
   * {@link setRemoteCameraQuality} only pins a simulcast layer, this toggles the
   * whole SUBSCRIPTION so a HIDDEN camera (fullscreen PiP closed / camera strip
   * collapsed) stops costing bandwidth — the SFU stops forwarding it. `true`
   * resumes it. No-op for platforms/tracks that can't toggle a subscription.
   * Best-effort — must not throw.
   */
  setRemoteCameraSubscribed?(identity: string, subscribed: boolean): void;
  /**
   * OPTIONAL: mute (deafen) or restore ALL remote audio playback — voice AND
   * screen-share/film audio — for current AND future remote participants. Needed
   * because on some platforms (React Native) remote audio is rendered natively and
   * a per-participant `setVolume(0)` does not reach the playout path, so deafen
   * never actually silenced anyone. The RN adapter implements this against the
   * subscription/playout directly; the web adapter omits it (its `setVolume(0)`
   * on the audio elements already works). Best-effort — must not throw.
   */
  setRemoteAudioMuted?(muted: boolean): void;
  /**
   * OPTIONAL: apply ONE remote's per-SHARE (screen_share_audio / film) playback
   * volume (0..2) to the native playout — the LISTENER's share volume,
   * separate from that person's voice. This exists for the SAME reason as
   * {@link setRemoteAudioMuted}: on React Native remote audio is rendered NATIVELY,
   * and while the per-user VOICE slider reaches the native gain via livekit's
   * `RemoteParticipant.setVolume` (v2.20 `_setVolume` → native), the FILM track is a
   * SECOND, sometimes-flakily-subscribed remote audio publication (the very gap
   * {@link ensureRemoteAudioSubscribed} force-subscribes) — so the engine's
   * per-source `setVolume(v, "screen_share_audio")` can land before that track is
   * bound and never reach the gain (the founder's "film sesi kaydırağı çalışmıyor"
   * P0). The RN adapter implements this to (a) target the film pub's track DIRECTLY,
   * and (b) RE-APPLY the last level when the `screen_share_audio` track (re)subscribes
   * — closing that timing gap. The engine calls it ALONGSIDE the per-participant
   * `setVolume` (never instead), so the web adapter simply OMITS it and keeps its
   * already-working audio-element path. Best-effort — must not throw.
   */
  setRemoteScreenShareVolume?(identity: string, volume: number): void;
  /**
   * OPTIONAL: the late-joiner SEED. When we connect to a room where a remote is
   * ALREADY publishing a screen share / camera, `TrackSubscribed` for that
   * pre-existing publication can be missed or deferred (autoSubscribe/adaptiveStream
   * timing — the "joined an ongoing share and saw nothing" P0). The engine calls
   * this right after connect: implementations SCAN the remote participants' camera +
   * screen-share publications, best-effort force a subscription on any not subscribed
   * yet (so the normal TrackSubscribed still fires), and RETURN the ones already
   * carrying a live track so the engine seeds them immediately through its subscribe
   * path. Returns [] when nothing is live / can't enumerate. Best-effort — no throw.
   */
  seedRemoteVideoTracks?(): SeededRemoteVideoTrack[];
  /**
   * OPTIONAL: the AUDIO half of the late-joiner seed — the "hear the ongoing film"
   * P0. Remote AUDIO plays automatically once a publication is SUBSCRIBED (desktop:
   * livekit's managed audio elements; mobile: the native audio device). But on
   * React Native, connecting to a room whose tracks were published BEFORE we joined
   * does not reliably subscribe those pre-existing publications (the very gap
   * {@link seedRemoteVideoTracks} force-subscribes for video). Voice audio and —
   * critically — the host's SCREEN-SHARE / film audio (`screen_share_audio`) are
   * separate audio publications, so a mobile viewer who joins AFTER the host starts
   * the film SEES the video (seeded above) but never subscribes the film-audio track
   * → total silence (the founder's "hears nothing" movie-night P0). The engine calls
   * this right after connect (and on reconnect): implementations force-subscribe every
   * remote AUDIO publication (microphone AND screen_share_audio) not subscribed yet.
   * Audio needs no engine-side rendering, so nothing is returned. No-op / omit on
   * platforms whose SDK already subscribes pre-existing tracks (desktop web).
   * Best-effort — must not throw.
   */
  ensureRemoteAudioSubscribed?(): void;
}
