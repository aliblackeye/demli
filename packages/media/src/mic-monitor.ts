/**
 * "Kendini dinle" — LOCAL MIC MONITORING (Ayarlar → Ses → Kendini dinle).
 *
 * The point of the feature is NOT "hear my microphone". It is: hear the signal
 * EXACTLY as the far end receives it, so the Gürültü Engelleme tier
 * (Yüksek / Standart / Kapalı) can be judged by ear. That means the monitored
 * audio must come out of the SAME processing chain the publish uses:
 *
 *   getUserMedia(audioCaptureOptionsForSettings(...))   ← same DSP constraints
 *        └→ RNNoise worklet (AudioTrackProcessorLike)   ← same worklet, same tier
 *             └→ processedTrack                          ← what livekit publishes
 *
 * A monitor that plays the RAW capture would LIE: the user would flip the tier,
 * hear no difference (or hear noise the far end never gets), and mistrust the
 * setting. So this module's contract is explicit — the platform implementation
 * MUST play the output of the noise-filter chain when the effective tier asks for
 * one (see `createWebMicMonitor` in mic-monitor-web.ts).
 *
 * WHY A PARALLEL CHAIN RATHER THAN A TAP ON THE PUBLISHED TRACK: while
 * monitoring inside a voice room the engine FORCE-MUTES the mic (see the
 * anti-feedback policy below), and livekit mute disables the underlying capture
 * track — so the published track carries digital silence by design. Tapping it
 * would deliver nothing. The monitor therefore builds its own capture + filter
 * instance from the very same resolvers the engine hands livekit
 * (`audioCaptureOptionsForSettings` + the injected `createNoiseFilter` factory),
 * so the configuration is identical even though the instance is separate.
 *
 * ── ANTI-FEEDBACK POLICY (founder requirement) ────────────────────────────────
 * Monitoring plays your mic out of your speakers. Inside a voice room that is a
 * loop: speakers → mic → far end → (and your own AEC fighting it). So turning
 * monitoring ON while in a room MUTES the mic and DEAFENS, and turning it OFF
 * restores EXACTLY the state that was there before — an already-muted or
 * already-deafened user must NOT come back unmuted/undeafened. That restore is
 * the fiddly part, so it lives here as two PURE functions the engine drives and
 * the tests pin ({@link monitorSuppressionPlan} / {@link monitorRestorePlan}) —
 * no scattered booleans (CLAUDE.md §11).
 *
 * This module is RN-SAFE: types + pure policy only. No DOM, no livekit. The
 * concrete WebAudio implementation lives behind the `@demli/media/web` entry.
 */

import type { AudioCaptureOptionsLike, AudioTrackProcessorLike } from "./room-adapter.js";

/**
 * Everything the platform monitor needs to reproduce the publish chain. Built by
 * the engine from the CURRENT audio settings + device preferences, so a settings
 * or device change simply re-issues `start` with a fresh config.
 */
export interface MicMonitorConfig {
  /**
   * getUserMedia audio constraints — the SAME object shape the engine passes to
   * `setMicrophoneEnabled` (echo cancellation / auto gain / built-in NS / sample
   * rate / channel count). `undefined` means "no user settings configured yet",
   * i.e. platform defaults.
   */
  capture: AudioCaptureOptionsLike | undefined;
  /** Preferred microphone, or null for the system default. */
  inputDeviceId: string | null;
  /** Where to PLAY the monitor, or null for the system default output. */
  outputDeviceId: string | null;
  /**
   * Factory for the noise-suppression worklet, or null when the effective tier
   * does not want one (Standart / Kapalı) or no filter is available on this
   * platform. When non-null the implementation MUST route the capture through it
   * and play `processedTrack` — otherwise the feature misreports the tier.
   */
  createNoiseFilter: (() => AudioTrackProcessorLike) | null;
}

/**
 * A live self-monitoring session. `start` is idempotent-by-replacement: calling
 * it again with a new config tears the previous graph down first, so the engine
 * re-arms on a device / settings change without tracking sub-state.
 */
export interface MicMonitor {
  /**
   * Open (or re-open) the monitor. Rejects with the raw getUserMedia error so the
   * engine can map it to a typed {@link import("./state.js").VoiceError} (§26).
   * On rejection the implementation must leave NOTHING running.
   */
  start(config: MicMonitorConfig): Promise<void>;
  /**
   * Stop and release EVERY resource: the capture track (so the OS mic indicator
   * clears), the worklet processor, the AudioContext, and the playback element.
   * Safe to call more than once and safe to call when never started.
   */
  stop(): Promise<void>;
}

/**
 * The mic/deafen state captured the moment self-monitoring suppressed it, so it
 * can be put back byte-for-byte when monitoring ends.
 */
export interface MonitorAudioSnapshot {
  micEnabled: boolean;
  deafened: boolean;
}

/**
 * What the engine must do to silence the local audio path before opening the
 * monitor. Deafen already implies a mic mute (see `engine.setDeafened`), so the
 * two are never both needed.
 */
export interface MonitorSuppressionPlan {
  /** Issue `setDeafened(true)`. */
  deafen: boolean;
  /** Issue `setMic(false)` — only relevant when deafen is already on. */
  mute: boolean;
}

/**
 * Plan the anti-feedback suppression for a user who is about to start monitoring
 * inside a voice room.
 *
 *  - Not deafened → deafen. That single call also mutes the mic AND records the
 *    pre-deafen mic preference inside the engine, which is what the undeafen
 *    later restores.
 *  - Already deafened → nothing to deafen; only mute if (defensively) the mic is
 *    somehow still on.
 */
export function monitorSuppressionPlan(
  current: MonitorAudioSnapshot,
): MonitorSuppressionPlan {
  if (!current.deafened) return { deafen: true, mute: false };
  return { deafen: false, mute: current.micEnabled };
}

/**
 * What the engine must do to put the audio path back when monitoring ends.
 * `mic: null` means "issue no mic call at all".
 */
export interface MonitorRestorePlan {
  /** Issue `setDeafened(false)`. */
  undeafen: boolean;
  /** Then reconcile the mic to this value; null = leave the mic alone. */
  mic: boolean | null;
}

/**
 * Plan the restore. The rule the founder asked for is "put it back how it was —
 * if they were already muted, do NOT unmute them":
 *
 *  - We deafened them (saved.deafened === false, they are deafened now) → a
 *    single `setDeafened(false)`. The engine's undeafen restores the mic to the
 *    value it saved when WE deafened, which IS `saved.micEnabled` — so no second
 *    mic call is needed, and none is issued (a redundant `setMic` would be a
 *    visible flicker).
 *  - They were ALREADY deafened → deafen stays on, and the mic must stay muted
 *    with it. Restoring a mic under a live deafen would silently UNDEAFEN them
 *    (that is what `setMic(true)` does), so we never touch it.
 *  - Nobody is deafened → only the mute needs reconciling, and only when it
 *    actually differs.
 */
export function monitorRestorePlan(
  saved: MonitorAudioSnapshot,
  current: MonitorAudioSnapshot,
): MonitorRestorePlan {
  if (current.deafened && !saved.deafened) return { undeafen: true, mic: null };
  if (current.deafened) return { undeafen: false, mic: null };
  return {
    undeafen: false,
    mic: current.micEnabled === saved.micEnabled ? null : saved.micEnabled,
  };
}
