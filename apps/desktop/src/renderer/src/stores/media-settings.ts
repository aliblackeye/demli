/**
 * Persisted USER media settings (Ayarlar → Mikrofon / görüntü) — the desktop
 * renderer's store for audio processing / input mode / music mode / quality and
 * camera + screen-share quality. The MAPPING to livekit capture constraints
 * lives in `@demli/media` (the engine is the single source of truth, CLAUDE.md
 * §11); this store only holds the typed {@link AudioSettings}/{@link VideoSettings}
 * and persists them. The voice store subscribes here and pushes them into the
 * engine (`configureAudio` / `configureVideo`).
 *
 * Persistence: zustand `persist` (localStorage) — renderer-only user prefs, the
 * same home as sound-settings. A corrupt/legacy blob is normalized on load via
 * the media package's guards so we never trust storage blindly.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_VIDEO_SETTINGS,
  normalizeAudioSettings,
  normalizeVideoSettings,
  type AudioProcessing,
  type AudioQuality,
  type AudioSettings,
  type CameraFrameRate,
  type CameraQuality,
  type InputMode,
  type NoiseSuppressionTier,
  type ScreenShareQuality,
  type VideoSettings,
} from "@demli/media";

/** Default desktop push-to-talk hold key (KeyboardEvent.code). Editable in settings. */
export const DEFAULT_PTT_KEY = "Backquote";

interface MediaSettingsState {
  audio: AudioSettings;
  video: VideoSettings;
  /** KeyboardEvent.code held to transmit while in push-to-talk mode (renderer-level). */
  pttKey: string;

  setInputMode: (mode: InputMode) => void;
  setVadThreshold: (value: number) => void;
  setNoiseSuppression: (tier: NoiseSuppressionTier) => void;
  setProcessing: (patch: Partial<AudioProcessing>) => void;
  setMusicMode: (on: boolean) => void;
  setAudioQuality: (quality: AudioQuality) => void;
  setCameraQuality: (quality: CameraQuality) => void;
  setCameraFrameRate: (fps: CameraFrameRate) => void;
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  setPttKey: (key: string) => void;
}

export const useMediaSettings = create<MediaSettingsState>()(
  persist(
    (set) => ({
      audio: { ...DEFAULT_AUDIO_SETTINGS, processing: { ...DEFAULT_AUDIO_SETTINGS.processing } },
      video: { ...DEFAULT_VIDEO_SETTINGS },
      pttKey: DEFAULT_PTT_KEY,

      setInputMode: (inputMode) => set((s) => ({ audio: { ...s.audio, inputMode } })),
      setVadThreshold: (vadThreshold) => set((s) => ({ audio: { ...s.audio, vadThreshold } })),
      setNoiseSuppression: (noiseSuppression) =>
        set((s) => ({ audio: { ...s.audio, noiseSuppression } })),
      setProcessing: (patch) =>
        set((s) => ({ audio: { ...s.audio, processing: { ...s.audio.processing, ...patch } } })),
      setMusicMode: (musicMode) => set((s) => ({ audio: { ...s.audio, musicMode } })),
      setAudioQuality: (quality) => set((s) => ({ audio: { ...s.audio, quality } })),
      setCameraQuality: (cameraQuality) => set((s) => ({ video: { ...s.video, cameraQuality } })),
      setCameraFrameRate: (cameraFrameRate) =>
        set((s) => ({ video: { ...s.video, cameraFrameRate } })),
      setScreenShareQuality: (screenShareQuality) =>
        set((s) => ({ video: { ...s.video, screenShareQuality } })),
      setPttKey: (pttKey) => set({ pttKey }),
    }),
    {
      name: "demli.media-settings",
      partialize: (s) => ({ audio: s.audio, video: s.video, pttKey: s.pttKey }),
      // Normalize untrusted persisted values through the media package's guards.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MediaSettingsState>;
        return {
          ...current,
          audio: normalizeAudioSettings(p.audio),
          video: normalizeVideoSettings(p.video),
          pttKey: typeof p.pttKey === "string" && p.pttKey ? p.pttKey : current.pttKey,
        };
      },
    },
  ),
);
