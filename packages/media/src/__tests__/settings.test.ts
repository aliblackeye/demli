/**
 * Media settings resolvers (audio-settings.ts + video-settings.ts) — the pure
 * mapping from user settings to livekit capture constraints / bitrate, and the
 * music-mode override. The engine-level plumbing (configureAudio/configureVideo →
 * publish args) is covered in engine.test.ts; this file pins the resolvers.
 */

import { describe, expect, it } from "vitest";
import {
  AUDIO_QUALITY_BITRATE_KBPS,
  audioBitrateKbpsForSettings,
  audioCaptureOptionsForSettings,
  CAMERA_DEGRADATION_PREFERENCE,
  CAMERA_LOW_SIMULCAST_LAYER,
  cameraCaptureOptionsFor,
  cameraPublishOptionsFor,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_NOISE_SUPPRESSION,
  DEFAULT_VIDEO_SETTINGS,
  effectiveAudioProcessing,
  effectiveAudioQuality,
  effectiveNoiseSuppression,
  isAudioQuality,
  isCameraFrameRate,
  isCameraQuality,
  isInputMode,
  isNoiseSuppressionTier,
  micPublishOptionsForSettings,
  MOBILE_CAMERA_CAPTURE_DEFAULT,
  NOISE_SUPPRESSION_TIERS,
  normalizeAudioSettings,
  normalizeVadThreshold,
  normalizeVideoSettings,
  resolveMicBitrateKbps,
  SCREEN_SHARE_DEGRADATION_PREFERENCE,
  speakingThresholdForSensitivity,
  SPEAKING_SENSITIVITY_MAX_THRESHOLD,
  SPEAKING_SENSITIVITY_MIN_THRESHOLD,
  wantsNoiseFilter,
  type AudioSettings,
} from "../index.js";

const base: AudioSettings = {
  inputMode: "voice_activity",
  vadThreshold: 0.5,
  noiseSuppression: "standard",
  processing: { echoCancellation: true, autoGainControl: true },
  musicMode: false,
  quality: "standard",
};

describe("audio settings — processing + music-mode override", () => {
  it("passes the raw processing flags through when music mode is off (+ 48kHz mono capture)", () => {
    const s: AudioSettings = {
      ...base,
      noiseSuppression: "off",
      processing: { echoCancellation: true, autoGainControl: false },
    };
    expect(effectiveAudioProcessing(s)).toEqual({
      echoCancellation: true,
      autoGainControl: false,
    });
    expect(audioCaptureOptionsForSettings(s)).toEqual({
      noiseSuppression: false,
      echoCancellation: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    });
  });

  it("music mode drops NS + AGC but KEEPS echo cancellation on, captures 48kHz STEREO", () => {
    const s: AudioSettings = {
      ...base,
      musicMode: true,
      // Even with NS standard + AGC on, music mode relaxes them — but AEC never
      // turns off (the movie-night echo-loop fix; a speaker must never feed back).
      noiseSuppression: "standard",
      processing: { echoCancellation: true, autoGainControl: true },
    };
    expect(effectiveNoiseSuppression(s)).toBe("off");
    expect(effectiveAudioProcessing(s)).toEqual({
      echoCancellation: true,
      autoGainControl: false,
    });
    expect(audioCaptureOptionsForSettings(s)).toEqual({
      noiseSuppression: false,
      echoCancellation: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 2,
    });
  });

  it("keeps AEC on in music mode even if the user explicitly disabled echo cancellation", () => {
    const s: AudioSettings = {
      ...base,
      musicMode: true,
      processing: { echoCancellation: false, autoGainControl: true },
    };
    // Music mode forces AEC back ON regardless of the stored toggle — the founder's
    // absolute rule: nothing from the loudspeaker may loop back into the mic.
    expect(effectiveAudioProcessing(s).echoCancellation).toBe(true);
    expect(audioCaptureOptionsForSettings(s).echoCancellation).toBe(true);
  });
});

describe("noise-suppression TIER → capture constraint + worklet request", () => {
  it("standard → built-in WebRTC noiseSuppression ON, no worklet requested", () => {
    const s: AudioSettings = { ...base, noiseSuppression: "standard" };
    expect(effectiveNoiseSuppression(s)).toBe("standard");
    expect(wantsNoiseFilter(s)).toBe(false);
    expect(audioCaptureOptionsForSettings(s).noiseSuppression).toBe(true);
  });

  it("off → no suppression at all", () => {
    const s: AudioSettings = { ...base, noiseSuppression: "off" };
    expect(wantsNoiseFilter(s)).toBe(false);
    expect(audioCaptureOptionsForSettings(s).noiseSuppression).toBe(false);
  });

  it("high WITH a filter available → browser NS OFF (the worklet does it), filter requested", () => {
    const s: AudioSettings = { ...base, noiseSuppression: "high" };
    expect(wantsNoiseFilter(s)).toBe(true);
    expect(audioCaptureOptionsForSettings(s, { noiseFilterAvailable: true }).noiseSuppression).toBe(
      false,
    );
  });

  it("high WITHOUT a filter → degrades to standard NS (never 'no suppression')", () => {
    const s: AudioSettings = { ...base, noiseSuppression: "high" };
    // Still REQUESTS a filter, but the capture keeps browser NS on as the fallback.
    expect(wantsNoiseFilter(s)).toBe(true);
    expect(audioCaptureOptionsForSettings(s, { noiseFilterAvailable: false }).noiseSuppression).toBe(
      true,
    );
    expect(audioCaptureOptionsForSettings(s).noiseSuppression).toBe(true); // default: unavailable
  });

  it("a user who never opened settings gets suppression on EVERY platform", () => {
    // The founder-facing guarantee, stated as one assertion rather than left to be
    // inferred from the default plus the degrade rule: whatever the platform can
    // do, an untouched install suppresses noise. The reason the default could be
    // raised to `high` at all is that this holds on mobile too, where there is no
    // filter factory.
    const fresh = normalizeAudioSettings({});
    expect(fresh.noiseSuppression).toBe("high");
    // Desktop, worklet available → browser NS off because the worklet does it.
    expect(wantsNoiseFilter(fresh)).toBe(true);
    // Mobile / pre-load, no worklet → browser NS carries it. NOT false.
    expect(
      audioCaptureOptionsForSettings(fresh, { noiseFilterAvailable: false }).noiseSuppression,
    ).toBe(true);
    expect(audioCaptureOptionsForSettings(fresh).noiseSuppression).toBe(true);
  });

  it("music mode forces the tier to off (an instrument transmits unfiltered)", () => {
    const s: AudioSettings = { ...base, noiseSuppression: "high", musicMode: true };
    expect(effectiveNoiseSuppression(s)).toBe("off");
    expect(wantsNoiseFilter(s)).toBe(false);
    expect(audioCaptureOptionsForSettings(s, { noiseFilterAvailable: true }).noiseSuppression).toBe(
      false,
    );
  });
});

describe("audio settings — quality → bitrate + music-mode override", () => {
  it("maps each tier to its (raised) bitrate", () => {
    expect(AUDIO_QUALITY_BITRATE_KBPS).toEqual({ standard: 48, high: 96, music: 256 });
    expect(audioBitrateKbpsForSettings({ ...base, quality: "standard" })).toBe(48);
    expect(audioBitrateKbpsForSettings({ ...base, quality: "high" })).toBe(96);
    expect(audioBitrateKbpsForSettings({ ...base, quality: "music" })).toBe(256);
  });

  it("music mode raises the effective quality to music regardless of the tier", () => {
    const s: AudioSettings = { ...base, quality: "standard", musicMode: true };
    expect(effectiveAudioQuality(s)).toBe("music");
    expect(audioBitrateKbpsForSettings(s)).toBe(256);
  });
});

describe("micPublishOptionsForSettings — bitrate + Opus RED/DTX/stereo", () => {
  it("standard: 48 kbps mono, RED + DTX on, no stereo", () => {
    expect(micPublishOptionsForSettings(null, { ...base, quality: "standard" })).toEqual({
      audioPreset: { maxBitrate: 48_000 },
      red: true,
      dtx: true,
      forceStereo: false,
    });
  });
  it("high: 96 kbps mono", () => {
    expect(micPublishOptionsForSettings(null, { ...base, quality: "high" })).toEqual({
      audioPreset: { maxBitrate: 96_000 },
      red: true,
      dtx: true,
      forceStereo: false,
    });
  });
  it("music: 256 kbps STEREO, DTX OFF (never gate sustained notes)", () => {
    expect(micPublishOptionsForSettings(null, { ...base, musicMode: true })).toEqual({
      audioPreset: { maxBitrate: 256_000 },
      red: true,
      dtx: false,
      forceStereo: true,
    });
  });
  it("honours a higher channel floor while keeping the tier's codec flags", () => {
    // Channel floor 320 kbps beats the standard tier's 48 kbps, but stays mono/DTX.
    expect(micPublishOptionsForSettings(320, { ...base, quality: "standard" })).toEqual({
      audioPreset: { maxBitrate: 320_000 },
      red: true,
      dtx: true,
      forceStereo: false,
    });
  });
});

describe("resolveMicBitrateKbps — channel + user, higher wins", () => {
  it("returns the channel value when no user settings", () => {
    expect(resolveMicBitrateKbps(96, null)).toBe(96);
  });
  it("returns the user value when no channel override", () => {
    expect(resolveMicBitrateKbps(null, { ...base, quality: "high" })).toBe(96);
  });
  it("returns null when neither is set", () => {
    expect(resolveMicBitrateKbps(null, null)).toBeNull();
  });
  it("takes the higher of the two so music mode beats a low channel tier", () => {
    // Channel at 32, user music mode 256 → 256 (the guitar transmits clean).
    expect(resolveMicBitrateKbps(32, { ...base, musicMode: true })).toBe(256);
    // Channel at 96, user standard 48 → 96 (channel floor wins).
    expect(resolveMicBitrateKbps(96, { ...base, quality: "standard" })).toBe(96);
  });
});

describe("cameraPublishOptionsFor — explicit encoding ceiling + degradation", () => {
  it("pins an aggressive bitrate per tier (720p 2.5 Mbps, 1080p 5 Mbps)", () => {
    expect(cameraPublishOptionsFor("hd", 30)).toEqual({
      videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
      simulcast: true,
      videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
      degradationPreference: "balanced",
    });
    expect(cameraPublishOptionsFor("fhd", 60)).toEqual({
      videoEncoding: { maxBitrate: 5_000_000, maxFramerate: 60 },
      simulcast: true,
      videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
      degradationPreference: "balanced",
    });
  });
  it("raises even Auto above livekit's soft default (2.5 Mbps, not ~1.7)", () => {
    expect(cameraPublishOptionsFor("auto", 30)).toEqual({
      videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
      simulcast: true,
      videoSimulcastLayers: [CAMERA_LOW_SIMULCAST_LAYER],
      degradationPreference: "balanced",
    });
  });
  it("publishes CUSTOM 2-layer simulcast (a usable low + the aggressive top) so a weak viewer never stalls", () => {
    // The previous single full-quality layer had no fallback → a weak subscriber froze.
    // Now every tier ships exactly ONE custom low layer (640×360 @ 500 kbps, far above
    // livekit's 320×180 ~160 kbps default) beneath the top `videoEncoding`; livekit reads
    // that one preset + the top into a 2-layer encode. A small/weak tile rides the low
    // layer smoothly; a focused/fullscreen tile pulls the sharp top via adaptiveStream.
    expect(CAMERA_LOW_SIMULCAST_LAYER).toEqual({
      width: 640,
      height: 360,
      encoding: { maxBitrate: 500_000, maxFramerate: 30 },
    });
    for (const quality of ["auto", "hd", "fhd"] as const) {
      for (const fps of [30, 60] as const) {
        const opts = cameraPublishOptionsFor(quality, fps);
        expect(opts.simulcast).toBe(true);
        expect(opts.videoSimulcastLayers).toEqual([CAMERA_LOW_SIMULCAST_LAYER]);
        // Exactly ONE custom layer → livekit produces a 2-layer (low + top) encode.
        expect(opts.videoSimulcastLayers).toHaveLength(1);
      }
    }
  });
  it("uses the BALANCED degradation trade on EVERY tier so a camera can never freeze", () => {
    // The mobile-camera-freeze P0: `maintain-resolution` forbids the encoder to scale
    // down, so a constrained phone could only shed FRAME-RATE — libwebrtc walks that to
    // its ~2fps floor and viewers see a FROZEN camera. `balanced` (livekit's own camera
    // default) drops resolution first and keeps an fps floor per resolution bucket, so
    // the picture always keeps moving. Pinned on every tier INCLUDING fhd: we
    // deliberately deviate from livekit's ≥1080p maintain-resolution heuristic, because
    // a frozen call is never worth sharpness (CLAUDE.md §6).
    expect(CAMERA_DEGRADATION_PREFERENCE).toBe("balanced");
    for (const quality of ["auto", "hd", "fhd"] as const) {
      for (const fps of [30, 60] as const) {
        const pref = cameraPublishOptionsFor(quality, fps).degradationPreference;
        expect(pref).toBe(CAMERA_DEGRADATION_PREFERENCE);
        // Regression guard, both directions: neither absolute may ever come back to
        // the camera. maintain-resolution froze it; maintain-framerate is the FILM
        // trade and would blur a face to mush.
        expect(pref).not.toBe("maintain-resolution");
        expect(pref).not.toBe("maintain-framerate");
      }
    }
  });
  it("keeps the CAMERA profile strictly separate from the SCREEN-SHARE profile", () => {
    // The two are opposite trades and must never be unified: a film holds frame-rate
    // and sheds resolution (maintain-framerate + the `motion` content hint); a face
    // sheds resolution gradually and must never stop moving (balanced, no hint). This
    // pins the separation so a future screen-share quality wave cannot leak into the
    // camera publish path.
    expect(SCREEN_SHARE_DEGRADATION_PREFERENCE).toBe("maintain-framerate");
    expect(CAMERA_DEGRADATION_PREFERENCE).not.toBe(SCREEN_SHARE_DEGRADATION_PREFERENCE);
    for (const quality of ["auto", "hd", "fhd"] as const) {
      for (const fps of [30, 60] as const) {
        const opts = cameraPublishOptionsFor(quality, fps) as Record<string, unknown>;
        // A camera publish must never carry the screen-share encoder ceiling nor the
        // `motion` content hint — those belong to the screen-share path alone.
        expect(opts.screenShareEncoding).toBeUndefined();
        expect(opts.contentHint).toBeUndefined();
      }
    }
  });
});

describe("MOBILE_CAMERA_CAPTURE_DEFAULT — the phone's default capture floor", () => {
  it("is a solid 720p @ 30fps (react-native-webrtc's raw default can be far lower)", () => {
    // The mobile room hands this to livekit's videoCaptureDefaults.resolution so the
    // default "auto" tier captures HD on the phone instead of an arbitrary low format.
    expect(MOBILE_CAMERA_CAPTURE_DEFAULT).toEqual({ width: 1280, height: 720, frameRate: 30 });
  });
});

describe("audio settings — guards + normalization", () => {
  it("guards untrusted input mode + quality + NS tier", () => {
    expect(isInputMode("push_to_talk")).toBe(true);
    expect(isInputMode("nope")).toBe(false);
    expect(isAudioQuality("music")).toBe(true);
    expect(isAudioQuality(42)).toBe(false);
    expect(isNoiseSuppressionTier("high")).toBe(true);
    expect(isNoiseSuppressionTier("standard")).toBe(true);
    expect(isNoiseSuppressionTier("off")).toBe(true);
    expect(isNoiseSuppressionTier("krisp")).toBe(false);
    expect(NOISE_SUPPRESSION_TIERS).toEqual(["high", "standard", "off"]);
    // `high`, not `standard`. Founder's rule: nobody opens audio settings before
    // a call, so whatever ships as the default is what the room hears. Safe as a
    // default only because it DEGRADES — with no noise-filter factory it falls
    // back to `standard`, never to "no suppression" (asserted below).
    expect(DEFAULT_NOISE_SUPPRESSION).toBe("high");
  });

  it("clamps the VAD sensitivity to [0,1] and falls back on garbage", () => {
    expect(normalizeVadThreshold(0.7)).toBe(0.7);
    expect(normalizeVadThreshold(5)).toBe(1);
    expect(normalizeVadThreshold(-1)).toBe(0);
    expect(normalizeVadThreshold("x")).toBe(DEFAULT_AUDIO_SETTINGS.vadThreshold);
  });

  it("normalizes a corrupt persisted blob to a valid AudioSettings", () => {
    const loaded = normalizeAudioSettings({
      inputMode: "bogus",
      vadThreshold: 2,
      noiseSuppression: "high",
      processing: { echoCancellation: "yes" },
      musicMode: true,
      quality: "music",
    });
    expect(loaded).toEqual({
      inputMode: DEFAULT_AUDIO_SETTINGS.inputMode,
      vadThreshold: 1,
      noiseSuppression: "high",
      processing: { echoCancellation: true, autoGainControl: true },
      musicMode: true,
      quality: "music",
    });
  });

  it("MIGRATES a pre-tier blob: legacy processing.noiseSuppression boolean → tier", () => {
    // Old shape had NS as a boolean inside `processing` and no top-level field.
    // `true` was the OLD DEFAULT, so it says the user never opened the setting —
    // not that they asked for that level. They get today's default rather than
    // being pinned to a choice they never made; these are precisely the people
    // the stronger default exists for.
    expect(
      normalizeAudioSettings({
        processing: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      }).noiseSuppression,
    ).toBe(DEFAULT_NOISE_SUPPRESSION);
    // `false` WAS deliberate — an opt-out survives the migration untouched.
    expect(
      normalizeAudioSettings({
        processing: { noiseSuppression: false, echoCancellation: true, autoGainControl: true },
      }).noiseSuppression,
    ).toBe("off");
    // A valid top-level tier always wins over the legacy boolean.
    expect(
      normalizeAudioSettings({
        noiseSuppression: "high",
        processing: { noiseSuppression: false },
      }).noiseSuppression,
    ).toBe("high");
    // No NS info at all → the default tier.
    expect(normalizeAudioSettings({ quality: "high" }).noiseSuppression).toBe(
      DEFAULT_NOISE_SUPPRESSION,
    );
  });

  it("normalizes null/undefined to the defaults", () => {
    expect(normalizeAudioSettings(undefined)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(normalizeAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
  });
});

describe("speakingThresholdForSensitivity", () => {
  it("maps higher sensitivity to a lower level threshold", () => {
    expect(speakingThresholdForSensitivity(1)).toBeCloseTo(SPEAKING_SENSITIVITY_MIN_THRESHOLD);
    expect(speakingThresholdForSensitivity(0)).toBeCloseTo(SPEAKING_SENSITIVITY_MAX_THRESHOLD);
    const mid = speakingThresholdForSensitivity(0.5);
    expect(mid).toBeGreaterThan(SPEAKING_SENSITIVITY_MIN_THRESHOLD);
    expect(mid).toBeLessThan(SPEAKING_SENSITIVITY_MAX_THRESHOLD);
  });
  it("falls back to the middle on non-finite input", () => {
    expect(speakingThresholdForSensitivity(Number.NaN)).toBeCloseTo(
      speakingThresholdForSensitivity(0.5),
    );
  });
});

describe("video settings — camera capture options", () => {
  it("returns undefined for the pure-default case (auto @ 30fps)", () => {
    expect(cameraCaptureOptionsFor("auto", 30)).toBeUndefined();
  });
  it("pins a 720p base so auto @ 60fps still takes effect", () => {
    expect(cameraCaptureOptionsFor("auto", 60)).toEqual({
      resolution: { width: 1280, height: 720, frameRate: 60 },
    });
  });
  it("maps 720p/1080p tiers with the chosen frame rate", () => {
    expect(cameraCaptureOptionsFor("hd", 30)).toEqual({
      resolution: { width: 1280, height: 720, frameRate: 30 },
    });
    expect(cameraCaptureOptionsFor("fhd", 60)).toEqual({
      resolution: { width: 1920, height: 1080, frameRate: 60 },
    });
  });
});

describe("video settings — guards + normalization", () => {
  it("guards untrusted camera quality + frame rate", () => {
    expect(isCameraQuality("fhd")).toBe(true);
    expect(isCameraQuality("4k")).toBe(false);
    expect(isCameraFrameRate(60)).toBe(true);
    expect(isCameraFrameRate(120)).toBe(false);
  });
  it("normalizes a corrupt persisted blob to a valid VideoSettings", () => {
    expect(normalizeVideoSettings({ cameraQuality: "8k", cameraFrameRate: 24 })).toEqual(
      DEFAULT_VIDEO_SETTINGS,
    );
    // A current matrix id passes through untouched.
    expect(
      normalizeVideoSettings({ cameraQuality: "fhd", cameraFrameRate: 60, screenShareQuality: "1440p60" }),
    ).toEqual({ cameraQuality: "fhd", cameraFrameRate: 60, screenShareQuality: "1440p60" });
    // Legacy tiers (smooth/balanced/cinema) map to their nearest matrix cell so an old
    // persisted settings blob survives the matrix evolution (persist must not break).
    expect(normalizeVideoSettings({ screenShareQuality: "cinema" }).screenShareQuality).toBe(
      "1080p60",
    );
    expect(normalizeVideoSettings({ screenShareQuality: "balanced" }).screenShareQuality).toBe(
      "1080p30",
    );
    expect(normalizeVideoSettings({ screenShareQuality: "smooth" }).screenShareQuality).toBe(
      "720p30",
    );
  });
});
