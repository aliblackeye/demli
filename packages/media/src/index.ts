/**
 * @demli/media — voice/media lifecycle (CLAUDE.md §11).
 *
 * - state.ts: the voice FSM model (VoiceState/VoiceStatus/VoiceError/...).
 * - engine.ts: createVoiceEngine — drives the FSM over an injected room adapter.
 * - room-adapter.ts: the structural Room interface the engine talks to.
 *
 * This root entry is RN-SAFE: it never imports `livekit-client`. The web-only
 * livekit room factory lives behind the separate `@demli/media/web` entry
 * (see web.ts); the engine takes the room factory via its `createRoom` option,
 * so desktop injects `createLiveKitRoom` while mobile injects its own adapter.
 *
 * Media frames flow over WebRTC/LiveKit only — never the WebSocket gateway.
 */

export type {
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
export {
  connectionQualityLevelFromLiveKit,
  initialVoiceState,
  UNKNOWN_CONNECTION_QUALITY,
  voiceEndedReasonFromEvent,
  voiceErrorMessage,
} from "./state.js";

export type {
  AcquireScreenShare,
  RemoteCamera,
  RemoteScreenShare,
  ScreenShareAssets,
  ScreenSharePublishOptions,
  VoiceEngine,
  VoiceEngineOptions,
  VoiceJoinCredential,
  VoiceTokenGrant,
} from "./engine.js";
export {
  COMMAND_ALLOWED_STATUSES,
  CONNECTION_QUALITY_POLL_MS,
  createVoiceEngine,
  InvalidVoiceCommandError,
  VoiceOperationError,
} from "./engine.js";

export type {
  AudioCaptureOptionsLike,
  AudioPresetLike,
  AudioProcessorOptionsLike,
  AudioTrackProcessorLike,
  ConnectionQualityProbe,
  LocalAudioMeter,
  LocalParticipantLike,
  LocalTrackPublicationLike,
  MicPublishOptionsLike,
  ParticipantLike,
  RemoteParticipantLike,
  RemoteTrackLike,
  RemoteTrackPublicationLike,
  RoomEventName,
  RoomListener,
  SeededRemoteVideoTrack,
  SimulcastLayerLike,
  TrackPublicationLike,
  TrackPublishOptionsLike,
  VideoCaptureOptionsLike,
  VideoEncodingLike,
  VideoPublishOptionsLike,
  VoiceRoomAdapter,
} from "./room-adapter.js";
export type { DisconnectReasonValue, ParticipantAttrKey } from "./room-adapter.js";
export {
  DISCONNECT_REASON,
  isEvictionDisconnect,
  PARTICIPANT_ATTR,
  ROOM_EVENT,
  TRACK_SOURCE,
} from "./room-adapter.js";

export type { AloneCountdown, AloneCountdownPhase, VoiceSurfaceKind } from "./alone-watch.js";
export {
  ALONE_GRACE_MS,
  aloneCountdownAt,
  formatAloneCountdown,
  isAloneEjectableSurface,
} from "./alone-watch.js";

export type {
  ActiveSpeakerSample,
  ActiveSpeakerSnapshot,
  ActiveSpeakerTracker,
  ActiveSpeakerTrackerOptions,
} from "./active-speaker.js";
export {
  createActiveSpeakerTracker,
  DEFAULT_ACTIVE_SPEAKER_ATTACK_MS,
  DEFAULT_ACTIVE_SPEAKER_MAX_RECENT,
  DEFAULT_ACTIVE_SPEAKER_RELEASE_MS,
  EMPTY_ACTIVE_SPEAKERS,
  pickSpeakingSubject,
} from "./active-speaker.js";

export type {
  BuildTilesInput,
  CameraSource,
  GridShape,
  ResolveStageOptions,
  SpeakerFilmstripPolicy,
  StageLayout,
  StageSize,
  StageTile,
} from "./stage.js";
export {
  buildTiles,
  cameraKey,
  computeGridShape,
  isScreenTile,
  isTheaterTile,
  LOCAL_CAMERA_KEY,
  LOCAL_SCREEN_KEY,
  participantKey,
  resolveStage,
  screenKey,
  SPEAKER_FILMSTRIP_MIN_OTHERS,
  tileGradient,
  tileHue,
  tileIdentity,
  WATCH_KEY,
} from "./stage.js";

export type { SpeakingDetector, SpeakingDetectorOptions } from "./speaking.js";
export {
  createSpeakingDetector,
  DEFAULT_SPEAKING_ATTACK_MS,
  DEFAULT_SPEAKING_RELEASE_MS,
  DEFAULT_SPEAKING_THRESHOLD,
  LOCAL_SPEAKING_POLL_MS,
  SPEAKING_SENSITIVITY_MAX_THRESHOLD,
  SPEAKING_SENSITIVITY_MIN_THRESHOLD,
  speakingThresholdForSensitivity,
} from "./speaking.js";

export type {
  ScreenShareFrameRate,
  ScreenShareQuality,
  ScreenShareQualityProfile,
  ScreenShareResolution,
} from "./quality.js";
export {
  DEFAULT_SCREEN_SHARE_QUALITY,
  isScreenShareQuality,
  ANDROID_SCREEN_CAPTURE_MAX_FPS,
  clampScreenShareQualityToFps,
  MIC_BITRATE_STEPS_KBPS,
  micAudioPresetForBitrate,
  normalizeScreenShareQuality,
  SCREEN_SHARE_CONTENT_HINT,
  SCREEN_SHARE_DEGRADATION_PREFERENCE,
  SCREEN_SHARE_FRAME_RATES,
  SCREEN_SHARE_QUALITIES,
  SCREEN_SHARE_QUALITY_PROFILES,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareEncodingForQuality,
  screenShareFrameRateOf,
  screenShareFrameRatesUpTo,
  screenShareQualityId,
  screenShareResolutionOf,
} from "./quality.js";

export type {
  AudioProcessing,
  AudioQuality,
  AudioSettings,
  EchoCancellationChoice,
  InputMode,
  NoiseSuppressionTier,
} from "./audio-settings.js";
export {
  AUDIO_CAPTURE_SAMPLE_RATE,
  AUDIO_QUALITIES,
  AUDIO_QUALITY_BITRATE_KBPS,
  AUDIO_QUALITY_PUBLISH_PROFILE,
  AUDIO_SETTINGS_SCHEMA_VERSION,
  audioBitrateKbpsForSettings,
  audioCaptureOptionsForSettings,
  DEFAULT_AUDIO_PROCESSING,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_NOISE_SUPPRESSION,
  DEFAULT_VAD_THRESHOLD,
  effectiveAudioProcessing,
  effectiveAudioQuality,
  effectiveNoiseSuppression,
  INPUT_MODES,
  isAudioQuality,
  isEchoCancellationOn,
  isInputMode,
  isNoiseSuppressionTier,
  micPublishOptionsForSettings,
  migrateAudioSettings,
  NOISE_SUPPRESSION_TIERS,
  normalizeAudioSettings,
  normalizeVadThreshold,
  resolveMicBitrateKbps,
  wantsNoiseFilter,
  withEchoCancellation,
} from "./audio-settings.js";

export type {
  MicMonitor,
  MicMonitorConfig,
  MonitorAudioSnapshot,
  MonitorRestorePlan,
  MonitorSuppressionPlan,
} from "./mic-monitor.js";
export { monitorRestorePlan, monitorSuppressionPlan } from "./mic-monitor.js";

export type { ParticipantVolumeMap } from "./participant-volume.js";
export {
  clampParticipantVolume,
  DEFAULT_PARTICIPANT_VOLUME,
  ELEMENT_PLAYBACK_MAX_VOLUME,
  isDefaultParticipantVolume,
  MAX_PARTICIPANT_VOLUME,
  MIN_PARTICIPANT_VOLUME,
  normalizeParticipantVolumes,
  PARTICIPANT_VOLUME_STORAGE_KEY,
  SCREEN_SHARE_VOLUME_STORAGE_KEY,
} from "./participant-volume.js";

export type { BandwidthPressureSource } from "./bandwidth.js";
export {
  BANDWIDTH_SOURCE_WATCH_PARTY,
  constrainedCameraCaptureOptions,
  constrainedCameraPublishOptions,
  PRESSURE_CAMERA_CAPTURE,
  PRESSURE_CAMERA_MAX_BITRATE_BPS,
  PRESSURE_SCREEN_SHARE_FLOOR,
} from "./bandwidth.js";

export type { CameraFrameRate, CameraQuality, VideoSettings } from "./video-settings.js";
export {
  CAMERA_DEGRADATION_PREFERENCE,
  CAMERA_FRAME_RATES,
  CAMERA_LOW_SIMULCAST_LAYER,
  CAMERA_QUALITIES,
  CAMERA_QUALITY_MAX_BITRATE_BPS,
  CAMERA_QUALITY_PROFILES,
  cameraCaptureOptionsFor,
  cameraPublishOptionsFor,
  DEFAULT_VIDEO_SETTINGS,
  isCameraFrameRate,
  isCameraQuality,
  MOBILE_CAMERA_CAPTURE_DEFAULT,
  normalizeVideoSettings,
} from "./video-settings.js";
