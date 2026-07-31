/**
 * Local speaking detection — a pure threshold + hysteresis state machine.
 *
 * Why this exists (task #54): a participant's `speaking` flag is normally driven
 * by livekit's server-computed `ActiveSpeakersChanged` event. The SFU smooths
 * audio levels over `audio.update_interval × audio.smooth_intervals` (defaults
 * 500ms × 4 ≈ a ~2s window) and only THEN broadcasts the change back — so a
 * user's OWN green ring lags 1-2s behind their voice. That lag is the server's
 * detection cadence, NOT network ping.
 *
 * The fix: compute the LOCAL user's speaking state on-device
 * from the raw mic input level, so their own ring reacts in ~one poll (~50ms).
 * Remote participants still come from the server (their audio physically has to
 * cross the network first). This module is the pure core of that computation:
 * livekit-free and DOM-free (RN-safe, like the rest of the package root), fully
 * deterministic, and driven by explicit `(level, now)` samples so it unit-tests
 * with a fake clock.
 *
 * Hysteresis: a fast ATTACK (flip ON after the level has stayed at/above the
 * threshold for `attackMs`) and a slow RELEASE (flip OFF only after it has
 * stayed below for `releaseMs`). The slow release bridges the natural gaps
 * between words so the ring does not strobe on every syllable.
 */

/** Tunables for {@link createSpeakingDetector}. All optional; sane defaults below. */
export interface SpeakingDetectorOptions {
  /**
   * Input level in [0,1] at/above which the user counts as talking. Matched to
   * livekit's `calculateVolume()` RMS output — normal speech sits around
   * 0.05-0.2, silence below ~0.01. Default {@link DEFAULT_SPEAKING_THRESHOLD}.
   */
  threshold?: number;
  /** Sustained at/above-threshold time (ms) before flipping ON. Fast — feels instant. Default 50. */
  attackMs?: number;
  /** Sustained below-threshold time (ms) before flipping OFF. Slow — bridges word gaps. Default 400. */
  releaseMs?: number;
}

/** A running local-speaking decision. Feed it level samples; read `speaking`. */
export interface SpeakingDetector {
  /** Current committed state (no side effects). */
  readonly speaking: boolean;
  /**
   * Feed one input-level sample taken at `nowMs` (a monotonic-ish ms clock,
   * e.g. Date.now()). Returns the (possibly updated) committed speaking state.
   * Non-finite/negative levels are treated as silence.
   */
  push(level: number, nowMs: number): boolean;
  /** Force back to silent immediately and cancel any pending flip (mute / track loss). */
  reset(): void;
  /**
   * Adjust the level threshold at runtime — the voice-activity sensitivity
   * slider (Ses Algılama). A non-finite value is ignored (keeps the current
   * threshold). Lower threshold = more sensitive (picks up quieter sound).
   */
  setThreshold(threshold: number): void;
}

export const DEFAULT_SPEAKING_THRESHOLD = 0.05;
export const DEFAULT_SPEAKING_ATTACK_MS = 50;
export const DEFAULT_SPEAKING_RELEASE_MS = 400;

/**
 * The lowest / highest level thresholds the sensitivity slider spans. Higher
 * sensitivity → LOWER threshold (picks up quieter sound). Chosen around normal
 * speech RMS (~0.05–0.2 from livekit's `calculateVolume`): most sensitive ≈ 0.01
 * (whisper), least sensitive ≈ 0.2 (only clear speech).
 */
export const SPEAKING_SENSITIVITY_MIN_THRESHOLD = 0.01;
export const SPEAKING_SENSITIVITY_MAX_THRESHOLD = 0.2;

/**
 * Map a voice-activity sensitivity in [0,1] (higher = more sensitive) to a
 * speaking-detector level threshold. Sensitivity 1 → the minimum threshold
 * (whisper), 0 → the maximum (only clear speech). Out-of-range/non-finite falls
 * back to the middle (the default sensitivity).
 */
export function speakingThresholdForSensitivity(sensitivity: number): number {
  const s = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
  const span = SPEAKING_SENSITIVITY_MAX_THRESHOLD - SPEAKING_SENSITIVITY_MIN_THRESHOLD;
  return SPEAKING_SENSITIVITY_MAX_THRESHOLD - s * span;
}

/**
 * How often the engine samples the local mic level (ms). 20Hz keeps the ring
 * responsive (attack ≈ one poll) while staying cheap; `setInterval` (not rAF) so
 * it keeps running when the Electron window is hidden.
 */
export const LOCAL_SPEAKING_POLL_MS = 50;

export function createSpeakingDetector(
  options: SpeakingDetectorOptions = {},
): SpeakingDetector {
  let threshold = options.threshold ?? DEFAULT_SPEAKING_THRESHOLD;
  const attackMs = options.attackMs ?? DEFAULT_SPEAKING_ATTACK_MS;
  const releaseMs = options.releaseMs ?? DEFAULT_SPEAKING_RELEASE_MS;

  let speaking = false;
  /** When the level first disagreed with `speaking`; null when steady. */
  let pendingSince: number | null = null;

  return {
    get speaking(): boolean {
      return speaking;
    },
    push(level: number, nowMs: number): boolean {
      const loud = Number.isFinite(level) && level >= threshold;
      if (loud === speaking) {
        // Level agrees with the committed state — cancel any in-progress flip.
        pendingSince = null;
        return speaking;
      }
      // Level disagrees: we may be flipping toward `loud`. Time the sustain.
      if (pendingSince === null) pendingSince = nowMs;
      const delay = loud ? attackMs : releaseMs;
      if (nowMs - pendingSince >= delay) {
        speaking = loud;
        pendingSince = null;
      }
      return speaking;
    },
    reset(): void {
      speaking = false;
      pendingSince = null;
    },
    setThreshold(next: number): void {
      if (Number.isFinite(next)) threshold = next;
    },
  };
}
