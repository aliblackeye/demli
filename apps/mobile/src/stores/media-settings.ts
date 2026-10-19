/**
 * Persisted USER media settings (Ayarlar → Mikrofon / görüntü) — the mobile
 * mirror of the desktop renderer's stores/media-settings.ts. Same shape and the
 * same defaults so the two clients behave identically. The MAPPING to livekit
 * capture constraints lives in `@demli/media` (the engine is the single source
 * of truth, CLAUDE.md §11); this store only holds + persists the typed settings,
 * and the voice store pushes them into the engine.
 *
 * Persistence: zustand `persist` backed by `expo-secure-store` — the SAME store
 * the app uses for the locale, session token, and sound settings. Reusing it adds
 * NO native module, keeping OTA delivery to the installed APK intact (the settings
 * are all JS-level livekit/getUserMedia capture constraints).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "../lib/secure-storage";
import {
  DEFAULT_ANDROID_AUDIO_PROFILE,
  normalizeAndroidAudioProfile,
  setActiveAudioProfile,
  type AndroidAudioProfile,
} from "../media/audio-profile";
import {
  AUDIO_SETTINGS_SCHEMA_VERSION,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  migrateAudioSettings,
  normalizeAudioSettings,
  normalizeVideoSettings,
  withEchoCancellation,
  type AudioQuality,
  type AudioSettings,
  type CameraFrameRate,
  type CameraQuality,
  type EchoCancellationChoice,
  type InputMode,
  ANDROID_SCREEN_CAPTURE_MAX_FPS,
  clampScreenShareQualityToFps,
  type NoiseSuppressionTier,
  type ScreenShareQuality,
  type VideoSettings,
} from "@demli/media";

/**
 * Mobile has no RNNoise worklet yet (native module is a 1.7.0 item), so the `high`
 * tier is not offered. Clamp any persisted/incoming `high` down to `standard` so the
 * two-option UI always has a valid selection and the engine never sits on a tier the
 * platform can't honour (it would already degrade `high` → standard NS, but the UI
 * needs a real selection). Off stays off.
 */
function clampMobileNoiseSuppression(audio: AudioSettings): AudioSettings {
  return audio.noiseSuppression === "high"
    ? { ...audio, noiseSuppression: "standard" }
    : audio;
}

/**
 * Android's screen capturer runs at a fixed 30fps, so a persisted `…60` tier is a
 * setting the device cannot honour. The pickers stopped OFFERING 60, which leaves
 * exactly one way in: a value written before that change. Left alone it would show
 * no selected chip AND publish against 60's higher bitrate ceiling — paying uplink
 * for frames the capturer never produces. Clamped here rather than at each reader,
 * so the picker and the publisher cannot disagree about what this phone is doing.
 */
function clampMobileScreenShareFps(video: VideoSettings): VideoSettings {
  const clamped = clampScreenShareQualityToFps(
    video.screenShareQuality,
    ANDROID_SCREEN_CAPTURE_MAX_FPS,
  );
  return clamped === video.screenShareQuality ? video : { ...video, screenShareQuality: clamped };
}

interface MediaSettingsState {
  audio: AudioSettings;
  video: VideoSettings;
  /**
   * Android-only playout profile for the room's remote audio (task #121). Lives
   * OUTSIDE `audio` because it is not a livekit capture constraint: it is the
   * native `AudioSession` configuration, mobile-only, and therefore not part of
   * the shared `AudioSettings` contract in `@demli/media`. Applies at the NEXT
   * connect — see media/audio-profile.ts.
   */
  audioProfile: AndroidAudioProfile;

  setInputMode: (mode: InputMode) => void;
  setVadThreshold: (value: number) => void;
  setNoiseSuppression: (tier: NoiseSuppressionTier) => void;
  setAutoGainControl: (on: boolean) => void;
  /** AEC off only as `"off_headphones"`, after the user confirmed headphones in the UI. */
  setEchoCancellation: (choice: EchoCancellationChoice) => void;
  setMusicMode: (on: boolean) => void;
  setAudioQuality: (quality: AudioQuality) => void;
  setCameraQuality: (quality: CameraQuality) => void;
  setCameraFrameRate: (fps: CameraFrameRate) => void;
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  /**
   * The Medya profile can switch the phone's hardware echo canceller off, so it is
   * reachable only as `"media_headphones"`, after the user confirmed headphones.
   */
  setAudioProfile: (choice: AudioProfileChoice) => void;
}

/** The only two legal audio-profile transitions; there is deliberately no plain "media". */
export type AudioProfileChoice = "communication" | "media_headphones";

export const useMediaSettings = create<MediaSettingsState>()(
  persist(
    (set) => ({
      audio: { ...DEFAULT_AUDIO_SETTINGS, processing: { ...DEFAULT_AUDIO_SETTINGS.processing } },
      video: { ...DEFAULT_VIDEO_SETTINGS },
      audioProfile: DEFAULT_ANDROID_AUDIO_PROFILE,

      setInputMode: (inputMode) => set((s) => ({ audio: { ...s.audio, inputMode } })),
      setVadThreshold: (vadThreshold) => set((s) => ({ audio: { ...s.audio, vadThreshold } })),
      setNoiseSuppression: (noiseSuppression) =>
        set((s) => ({ audio: { ...s.audio, noiseSuppression } })),
      setAutoGainControl: (autoGainControl) =>
        set((s) => ({
          audio: { ...s.audio, processing: { ...s.audio.processing, autoGainControl } },
        })),
      setEchoCancellation: (choice) =>
        set((s) => ({ audio: withEchoCancellation(s.audio, choice) })),
      setMusicMode: (musicMode) => set((s) => ({ audio: { ...s.audio, musicMode } })),
      setAudioQuality: (quality) => set((s) => ({ audio: { ...s.audio, quality } })),
      setCameraQuality: (cameraQuality) => set((s) => ({ video: { ...s.video, cameraQuality } })),
      setCameraFrameRate: (cameraFrameRate) =>
        set((s) => ({ video: { ...s.video, cameraFrameRate } })),
      setScreenShareQuality: (screenShareQuality) =>
        set((s) => ({ video: { ...s.video, screenShareQuality } })),
      setAudioProfile: (choice) =>
        set({ audioProfile: choice === "media_headphones" ? "media" : "communication" }),
    }),
    {
      name: "demli.media-settings",
      storage: createJSONStorage(() => secureStorage),
      version: AUDIO_SETTINGS_SCHEMA_VERSION,
      // Runs once per install when the stored version is older (a store written
      // before `version` existed reads as 0): turns echo cancellation back on and
      // moves a Medya profile, picked before it asked about headphones, back to
      // Görüşme.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as { audio?: unknown; audioProfile?: unknown };
        const audioProfile =
          version < AUDIO_SETTINGS_SCHEMA_VERSION ? DEFAULT_ANDROID_AUDIO_PROFILE : p.audioProfile;
        return { ...p, audio: migrateAudioSettings(p.audio, version), audioProfile };
      },
      partialize: (s) => ({ audio: s.audio, video: s.video, audioProfile: s.audioProfile }),
      // Normalize untrusted persisted values through the media package's guards.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MediaSettingsState>;
        return {
          ...current,
          audio: clampMobileNoiseSuppression(normalizeAudioSettings(p.audio)),
          video: clampMobileScreenShareFps(normalizeVideoSettings(p.video)),
          audioProfile: normalizeAndroidAudioProfile(p.audioProfile),
        };
      },
    },
  ),
);

/**
 * Push the selected Android audio profile to the media layer (task #121). The
 * room adapter reads it synchronously inside `connect()`, so `media/` stays free
 * of store imports. Runs once now (default) and again on every change — including
 * the ASYNC SecureStore rehydration, which zustand applies with a `set()` and
 * therefore notifies subscribers. Changing it while a room is live deliberately
 * does NOT touch the running session: `AudioSession.configureAudio` only takes
 * effect before `Room.connect()`, so it applies at the next join (the settings UI
 * says exactly that).
 */
setActiveAudioProfile(useMediaSettings.getState().audioProfile);
useMediaSettings.subscribe((s) => setActiveAudioProfile(s.audioProfile));
