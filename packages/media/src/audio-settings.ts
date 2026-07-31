/**
 * User-level AUDIO settings model (Ayarlar → Mikrofon) — the single, typed
 * source of truth for input mode, capture processing, music/studio mode, and
 * the audio-quality (mic bitrate) tier. Lives in `@demli/media` so the
 * capture-constraint + bitrate logic is NEVER scattered across the desktop /
 * mobile UIs (CLAUDE.md §11/§23): both clients persist an {@link AudioSettings}
 * and hand it to `engine.configureAudio(settings)`; the engine + these pure
 * resolvers do the rest.
 *
 * Livekit-free and DOM-free (RN-safe, like the rest of the package root): pure
 * data + mapping helpers. The engine maps the resolved processing flags onto the
 * livekit mic-capture constraints (`AudioCaptureOptionsLike`) and the resolved
 * bitrate onto the mic `audioPreset` (see quality.ts / engine.ts).
 */

import type { AudioCaptureOptionsLike, MicPublishOptionsLike } from "./room-adapter.js";

/**
 * How the mic transmits (Ayarlar → Mikrofon → Giriş modu):
 *  - push_to_talk (Bas-Konuş): mic muted until the user HOLDS a control
 *    (desktop hold key / mobile hold-to-talk button). The hold is driven by the
 *    client (voice store) via the engine's existing setMic — this value only
 *    records the CHOICE so the client knows to gate.
 *  - voice_activity (Ses Algılama): mic open; the {@link AudioSettings.vadThreshold}
 *    sensitivity feeds the on-device speaking detector. NOTE: livekit does not
 *    gate transmission by VAD, so this does not stop sending during silence — it
 *    tunes the local speaking indicator's sensitivity (the honest limitation the
 *    task calls out).
 *  - open_mic (Her Zaman Açık): mic open, transmit continuously.
 */
export type InputMode = "push_to_talk" | "voice_activity" | "open_mic";

/** Ordered for UIs. */
export const INPUT_MODES: readonly InputMode[] = [
  "push_to_talk",
  "voice_activity",
  "open_mic",
];

/**
 * Audio-quality tier (Ayarlar → Mikrofon → Ses kalitesi) → mic publish bitrate.
 *  - standard (Standart): 48 kbps mono — clear voice. This is now the FLOOR, not
 *    the old 32 kbps (which snapped DOWN to a 24 kbps telephone preset — the
 *    root cause of the "audio sounds bad" default).
 *  - high (Yüksek): 96 kbps mono — crisp, full voice.
 *  - music (Müzik): 256 kbps STEREO — full-range, for instruments / studio use.
 */
export type AudioQuality = "standard" | "high" | "music";

/** Ordered for UIs (lowest → highest). */
export const AUDIO_QUALITIES: readonly AudioQuality[] = ["standard", "high", "music"];

/**
 * Mic publish bitrate (kbps) for each quality tier. Set DIRECTLY as the livekit
 * `audioPreset.maxBitrate` (Opus accepts any bitrate up to ~510 kbps), NOT snapped
 * to a named `AudioPresets` step — snapping is what quietly capped Standart at
 * 24 kbps and Müzik at 128 kbps before.
 */
export const AUDIO_QUALITY_BITRATE_KBPS: Readonly<Record<AudioQuality, number>> = {
  standard: 48,
  high: 96,
  music: 256,
};

/** The Opus codec flags per tier (see {@link MicPublishOptionsLike}). */
interface AudioPublishProfile {
  /** RED (redundant audio) — loss resilience. On for every tier. */
  red: boolean;
  /** DTX (silence suppression) — on for voice, OFF for music (never gate notes). */
  dtx: boolean;
  /** Publish 2-channel Opus (music/studio). */
  stereo: boolean;
}

/** Per-tier codec profile. Music goes stereo + no DTX; voice tiers stay mono + DTX. */
export const AUDIO_QUALITY_PUBLISH_PROFILE: Readonly<Record<AudioQuality, AudioPublishProfile>> = {
  standard: { red: true, dtx: true, stereo: false },
  high: { red: true, dtx: true, stereo: false },
  music: { red: true, dtx: false, stereo: true },
};

/**
 * Publish profile for SYSTEM/loopback audio — the film's sound that rides along
 * with a screen share (source `ScreenShareAudio`). It is not speech, so it gets
 * the `music` tier verbatim: 256 kbps STEREO, DTX OFF, RED ON.
 *
 * Before this the track was published with `{ source }` alone, so livekit's own
 * audio defaults applied — ~48 kbps MONO with DTX — i.e. a voice profile on a
 * movie: the stereo mix collapsed, music sat at a quality floor, and DTX gated
 * quiet passages into dropouts. Every listener got that, desktop and mobile
 * alike; on Android it stacked on top of the VoIP playout route (task #113).
 *
 * The extra bandwidth is noise next to the screen-share VIDEO already in flight
 * (multi-Mbps), so there is no tier knob here — a shared film always gets the
 * good profile.
 */
export const SCREEN_SHARE_AUDIO_PUBLISH = {
  audioPreset: { maxBitrate: AUDIO_QUALITY_BITRATE_KBPS.music * 1000 },
  red: AUDIO_QUALITY_PUBLISH_PROFILE.music.red,
  dtx: AUDIO_QUALITY_PUBLISH_PROFILE.music.dtx,
  forceStereo: AUDIO_QUALITY_PUBLISH_PROFILE.music.stereo,
} as const;

/** Capture sample rate pinned for every tier — full-fidelity Opus. */
export const AUDIO_CAPTURE_SAMPLE_RATE = 48_000;

/**
 * Noise-suppression TIER (Ayarlar → Ses → Gürültü Engelleme) — three levels
 * instead of a single on/off toggle:
 *  - high (Yüksek / Krisp benzeri): an ML suppressor (RNNoise, Krisp's
 *    open-source class) runs as a WASM AudioWorklet inserted BETWEEN the AEC'd
 *    getUserMedia track and the publish. It is NOT a getUserMedia capture
 *    constraint — it needs a worklet + WASM, so it is only available where the
 *    platform injects a noise-filter factory (desktop today; mobile pending a
 *    native module, see the media doc). The browser's own NS is turned OFF for
 *    this tier so the two never double-process. If no filter is available the
 *    tier degrades to `standard` (never to "no suppression") — see
 *    {@link audioCaptureOptionsForSettings}.
 *  - standard (Standart): the built-in WebRTC `noiseSuppression: true` capture
 *    constraint — the previous default behaviour.
 *  - off (Kapalı): no suppression at all (Müzik Modu forces this so an
 *    instrument transmits unfiltered).
 */
export type NoiseSuppressionTier = "high" | "standard" | "off";

/** Ordered for UIs (strongest → none). */
export const NOISE_SUPPRESSION_TIERS: readonly NoiseSuppressionTier[] = [
  "high",
  "standard",
  "off",
];

/**
 * Default tier — `high`.
 *
 * Founder's rule, and the reason it is not `standard`: "insanlar ses ayarı
 * yapmayı unutuyor ve beyin sikiyor kulak sikiyorlar". Nobody opens audio
 * settings before a call; whatever ships as the default is what the room hears
 * for the next hour. A keyboard, a fan or a TV in the background is the common
 * case, not the exception, so the strongest suppression has to be the one you
 * get without asking.
 *
 * Safe to default because it degrades rather than fails: with no noise-filter
 * factory (mobile today, and desktop for the moment before the worklet loads)
 * `audioCaptureOptionsForSettings` falls back to `standard` — never to "no
 * suppression". So mobile behaviour is unchanged by this line.
 *
 * Müzik Modu still forces `off`, because an instrument must transmit unfiltered.
 */
export const DEFAULT_NOISE_SUPPRESSION: NoiseSuppressionTier = "high";

/**
 * The two remaining getUserMedia/LiveKit audio-capture DSP toggles (Ses işleme),
 * default ON. Unlike noise suppression (now a {@link NoiseSuppressionTier}, since
 * the `high` tier is a worklet rather than a capture constraint) these still map
 * 1:1 onto the mic-capture constraints.
 */
export interface AudioProcessing {
  /** Yankı Engelleme — echoCancellation capture constraint. */
  echoCancellation: boolean;
  /** Otomatik Seviye — autoGainControl capture constraint. */
  autoGainControl: boolean;
}

export const DEFAULT_AUDIO_PROCESSING: AudioProcessing = {
  echoCancellation: true,
  autoGainControl: true,
};

/** Default voice-activity sensitivity (0..1, higher = more sensitive). */
export const DEFAULT_VAD_THRESHOLD = 0.5;

/** The full persisted audio-settings shape. */
export interface AudioSettings {
  inputMode: InputMode;
  /**
   * Voice-activity sensitivity in [0,1] (higher = picks up quieter sound).
   * Feeds the local speaking detector's level threshold via
   * {@link speakingThresholdForSensitivity}. Only meaningful for `voice_activity`.
   */
  vadThreshold: number;
  /**
   * Gürültü Engelleme tier (Yüksek/Standart/Kapalı). Forced to `off` while
   * {@link musicMode}. Separate from {@link processing} because the `high` tier is
   * an out-of-band worklet, not a capture constraint (see {@link NoiseSuppressionTier}).
   */
  noiseSuppression: NoiseSuppressionTier;
  /** The two remaining DSP toggles; AEC forced ON, AGC forced OFF while {@link musicMode}. */
  processing: AudioProcessing;
  /**
   * Müzik Modu — a single studio toggle. When ON it forces {@link noiseSuppression}
   * to `off` and {@link processing} auto-gain to OFF (so a guitar transmits
   * unfiltered — the founder's requirement) — but KEEPS echo cancellation on — AND
   * raises the effective quality to `music`. Overrides the individual processing
   * toggles, the NS tier, and the `quality` tier while set.
   */
  musicMode: boolean;
  /** Base audio-quality tier; raised to `music` while {@link musicMode}. */
  quality: AudioQuality;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  inputMode: "voice_activity",
  vadThreshold: DEFAULT_VAD_THRESHOLD,
  noiseSuppression: DEFAULT_NOISE_SUPPRESSION,
  processing: { ...DEFAULT_AUDIO_PROCESSING },
  musicMode: false,
  quality: "standard",
};

// ---------------------------------------------------------------------------
// Resolvers — the music-mode override lives HERE (pure + unit-tested).
// ---------------------------------------------------------------------------

/**
 * Effective DSP flags after the music-mode override.
 *
 * Music/studio mode drops AUTO GAIN (and, via {@link effectiveNoiseSuppression},
 * noise suppression) so an instrument/voice transmits unfiltered (the founder's
 * guitar requirement) — but ACOUSTIC ECHO CANCELLATION stays ON. AEC and NS/AGC
 * are INDEPENDENT axes: they were being turned off together, and disabling AEC is
 * what let a phone's loudspeaker output (voices + the shared film's sound) leak
 * back into its own mic and loop forever during a movie night. The rule is
 * absolute — NOTHING coming out of the speaker may go back to the room — so AEC is
 * on in EVERY mode; music mode only relaxes NS/AGC. (Hardware AEC on Android needs
 * MODE_IN_COMMUNICATION too; the mobile AudioSession already uses the communication
 * preset.)
 */
export function effectiveAudioProcessing(settings: AudioSettings): AudioProcessing {
  if (settings.musicMode) {
    return { echoCancellation: true, autoGainControl: false };
  }
  return settings.processing;
}

/**
 * Effective noise-suppression tier after the music-mode override. Müzik Modu forces
 * `off` (an instrument must transmit unfiltered — no NS may chew on sustained notes).
 */
export function effectiveNoiseSuppression(settings: AudioSettings): NoiseSuppressionTier {
  return settings.musicMode ? "off" : settings.noiseSuppression;
}

/**
 * Whether this settings object asks for the WORKLET noise filter (RNNoise) — i.e.
 * the effective tier is `high`. The engine consults this to decide whether to
 * attach its injected `createNoiseFilter` processor to the mic capture. Purely a
 * REQUEST: whether a filter actually runs also depends on the platform providing a
 * factory (see the `noiseFilterAvailable` argument to
 * {@link audioCaptureOptionsForSettings}).
 */
export function wantsNoiseFilter(settings: AudioSettings): boolean {
  return effectiveNoiseSuppression(settings) === "high";
}

/** Effective quality tier after the music-mode override (music → "music"). */
export function effectiveAudioQuality(settings: AudioSettings): AudioQuality {
  return settings.musicMode ? "music" : settings.quality;
}

/** Effective mic publish bitrate (kbps) for the settings, after the override. */
export function audioBitrateKbpsForSettings(settings: AudioSettings): number {
  return AUDIO_QUALITY_BITRATE_KBPS[effectiveAudioQuality(settings)];
}

/**
 * The livekit mic-capture constraints for the settings (post-override DSP flags).
 *
 * The `noiseSuppression` capture constraint (the browser's/native built-in WebRTC
 * NS) is derived from the {@link NoiseSuppressionTier}, NOT a stored boolean:
 *  - `standard` → ON.
 *  - `high` → OFF when a worklet filter (RNNoise) will run instead — pass
 *    `noiseFilterAvailable: true` — so the two never double-process. When NO filter
 *    is available (mobile today, or before the desktop factory loads) it FALLS BACK
 *    to ON, so `high` degrades to `standard` rather than to "no suppression at all".
 *  - `off` → OFF.
 * Echo cancellation + auto gain come straight from the effective processing flags,
 * and AEC is on in every mode (music included). The worklet, when used, processes
 * the already-AEC'd capture track — AEC runs first, the filter cleans the residual.
 */
export function audioCaptureOptionsForSettings(
  settings: AudioSettings,
  opts?: { noiseFilterAvailable?: boolean },
): AudioCaptureOptionsLike {
  const dsp = effectiveAudioProcessing(settings);
  const tier = effectiveNoiseSuppression(settings);
  // Capture stereo only when the effective tier is music (a stereo publish needs a
  // stereo source); voice tiers stay mono. 48 kHz always, so Opus runs full-band.
  const stereo = AUDIO_QUALITY_PUBLISH_PROFILE[effectiveAudioQuality(settings)].stereo;
  const noiseSuppression =
    tier === "standard" || (tier === "high" && !opts?.noiseFilterAvailable);
  return {
    noiseSuppression,
    echoCancellation: dsp.echoCancellation,
    autoGainControl: dsp.autoGainControl,
    sampleRate: AUDIO_CAPTURE_SAMPLE_RATE,
    channelCount: stereo ? 2 : 1,
  };
}

/**
 * The full livekit mic PUBLISH options for the settings + optional channel floor:
 * the effective bitrate (higher of the channel floor and the user tier) plus the
 * tier's Opus codec flags (RED / DTX / stereo). This is what actually makes audio
 * sound good — and, unlike a getUserMedia capture constraint, changing it requires
 * REPUBLISHING the mic track (see engine.configureAudio). The bitrate is set as a
 * raw `audioPreset.maxBitrate` (no lossy snapping to a named preset step).
 */
export function micPublishOptionsForSettings(
  channelKbps: number | null,
  settings: AudioSettings,
): MicPublishOptionsLike {
  const profile = AUDIO_QUALITY_PUBLISH_PROFILE[effectiveAudioQuality(settings)];
  const kbps = resolveMicBitrateKbps(channelKbps, settings) ?? audioBitrateKbpsForSettings(settings);
  return {
    audioPreset: { maxBitrate: Math.round(kbps * 1000) },
    red: profile.red,
    dtx: profile.dtx,
    forceStereo: profile.stereo,
  };
}

/**
 * Resolve the mic publish bitrate (kbps) from BOTH a channel-configured bitrate
 * (M7c, owner-set) and the user's audio settings: the HIGHER wins, so the
 * channel guarantees a floor while the user's Müzik Modu / Yüksek tier can raise
 * above it (the guitar must transmit clean even in a 32 kbps channel). Either
 * input may be null; null user settings falls back to the channel value (the
 * pre-settings behavior), and null channel falls back to the user value.
 */
export function resolveMicBitrateKbps(
  channelKbps: number | null,
  settings: AudioSettings | null,
): number | null {
  const settingsKbps = settings ? audioBitrateKbpsForSettings(settings) : null;
  if (channelKbps == null) return settingsKbps;
  if (settingsKbps == null) return channelKbps;
  return Math.max(channelKbps, settingsKbps);
}

// ---------------------------------------------------------------------------
// Type guards + normalization for untrusted persisted values (localStorage /
// SecureStore). Never trust storage blindly — a corrupt field falls back.
// ---------------------------------------------------------------------------

export function isInputMode(value: unknown): value is InputMode {
  return value === "push_to_talk" || value === "voice_activity" || value === "open_mic";
}

export function isAudioQuality(value: unknown): value is AudioQuality {
  return value === "standard" || value === "high" || value === "music";
}

export function isNoiseSuppressionTier(value: unknown): value is NoiseSuppressionTier {
  return value === "high" || value === "standard" || value === "off";
}

/** Clamp an untrusted sensitivity to [0,1]; non-finite falls back to the default. */
export function normalizeVadThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_VAD_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function normalizeProcessing(raw: unknown): AudioProcessing {
  const r = (raw ?? {}) as Partial<Record<keyof AudioProcessing, unknown>>;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  return {
    echoCancellation: bool(r.echoCancellation, DEFAULT_AUDIO_PROCESSING.echoCancellation),
    autoGainControl: bool(r.autoGainControl, DEFAULT_AUDIO_PROCESSING.autoGainControl),
  };
}

/**
 * Resolve the persisted noise-suppression tier, MIGRATING a pre-tier blob. Before
 * this wave NS was a boolean living at `processing.noiseSuppression`; a returning
 * user has no top-level `noiseSuppression` string yet. Map the old boolean
 * true→`standard` / false→`off` so their choice survives the update; a fresh/corrupt
 * blob falls back to the default tier.
 */
function normalizeNoiseSuppression(raw: unknown, legacyProcessing: unknown): NoiseSuppressionTier {
  if (isNoiseSuppressionTier(raw)) return raw;
  const legacy = (legacyProcessing ?? {}) as { noiseSuppression?: unknown };
  if (typeof legacy.noiseSuppression === "boolean") {
    // `false` was a deliberate opt-out, so it is preserved. `true` was the OLD
    // DEFAULT — it tells us the user never opened the setting, not that they
    // asked for that level, so they get today's default instead of being pinned
    // to a choice they never made. These are exactly the people the change is
    // for: the ones who never touch audio settings.
    return legacy.noiseSuppression ? DEFAULT_NOISE_SUPPRESSION : "off";
  }
  return DEFAULT_NOISE_SUPPRESSION;
}

/** Build a valid {@link AudioSettings} from an untrusted persisted blob. */
export function normalizeAudioSettings(raw: unknown): AudioSettings {
  const r = (raw ?? {}) as Partial<Record<keyof AudioSettings, unknown>>;
  return {
    inputMode: isInputMode(r.inputMode) ? r.inputMode : DEFAULT_AUDIO_SETTINGS.inputMode,
    vadThreshold: normalizeVadThreshold(r.vadThreshold),
    noiseSuppression: normalizeNoiseSuppression(r.noiseSuppression, r.processing),
    processing: normalizeProcessing(r.processing),
    musicMode: typeof r.musicMode === "boolean" ? r.musicMode : false,
    quality: isAudioQuality(r.quality) ? r.quality : DEFAULT_AUDIO_SETTINGS.quality,
  };
}
