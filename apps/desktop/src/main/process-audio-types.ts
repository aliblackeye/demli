/**
 * Shared per-process audio-capture contract (Windows process loopback).
 *
 * This module — like `capture-types.ts` — is the ONLY surface that crosses the
 * main <-> preload <-> renderer boundary for the process-audio feature. It is
 * pure TypeScript: it imports NOTHING from `electron` or `node`, so it is safe
 * to import from main (values + types), preload (values + types) and the
 * renderer (types only). Do not add electron/node imports here.
 *
 * WHY: screen-share sound must never contain Demli's own playback of the other
 * people in the call, or they hear themselves (M16 H1). The Windows WASAPI
 * process-loopback API (AUDCLNT activation on a process tree, build 19041+)
 * captures by PROCESS, not by output device, which gives two echo-free modes:
 *
 *   - "app":    INCLUDE the shared window's process tree — only that app's sound.
 *   - "system": EXCLUDE Demli's own main process tree — everything the PC plays
 *               except Demli. Electron renders all audio in its audio-service
 *               utility process, a child of the main process, so the tree covers
 *               every remote voice Demli plays (measured by
 *               scripts/verify-process-audio.mjs --electron).
 *
 * Limit: "system" removes only what Demli's own processes render. A mixer that
 * takes Demli's output and renders it again from its own process (Voicemeeter
 * on an MME/WDM output, SteelSeries Sonar, Windows "Listen to this device")
 * can put the call back into the capture, outside Demli's tree. The capture runs
 * in Demli's own helper (`native/process-audio`, built from source), which
 * streams raw PCM to stdout; main forwards the chunks to the renderer, which
 * rebuilds a MediaStreamTrack for the LiveKit publish.
 */

/**
 * IPC channel names for the process-audio feature. Single source of truth —
 * never hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const PROCESS_AUDIO_CHANNELS = {
  /** renderer -> main (invoke): can this machine capture process audio at all? */
  support: "demli:process-audio:support",
  /** renderer -> main (invoke): start an "app" or "system" capture. */
  start: "demli:process-audio:start",
  /** renderer -> main (invoke): stop a capture by id. */
  stop: "demli:process-audio:stop",
  /** main -> renderer (send): a raw PCM chunk for an active capture. */
  data: "demli:process-audio:data",
  /** main -> renderer (send): a capture ended (exe exited / error / stopped). */
  ended: "demli:process-audio:ended",
} as const;

export type ProcessAudioChannel =
  (typeof PROCESS_AUDIO_CHANNELS)[keyof typeof PROCESS_AUDIO_CHANNELS];

/**
 * PCM wire format emitted by the helper binary and reconstructed in the
 * renderer. Empirically verified on Windows (WASAPI shared-mode mix format):
 * 48 kHz, 16-bit signed little-endian, 2 channels, interleaved (L,R,L,R…).
 * 48 kHz is the WebRTC-native rate, so no resampling is needed downstream.
 */
export interface ProcessAudioFormat {
  /** Samples per second per channel. */
  sampleRate: number;
  /** Interleaved channel count. */
  channels: number;
  /** Bits per sample (signed little-endian PCM). */
  bitDepth: number;
}

/** The single, fixed format the helper binary produces. */
export const PROCESS_AUDIO_FORMAT: ProcessAudioFormat = {
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
} as const;

/**
 * Lowest Windows build on which a process-loopback capture is attempted:
 * Windows 10 2004 (19041). Microsoft documents 20348, but the activation type
 * is present from 19041 on, and OBS (application audio capture) and GStreamer
 * (wasapi2 include/exclude loopback) both gate on 19041. Below the documented
 * floor the helper's activation result decides: a refusal becomes
 * `activation_failed`, never a silent capture. Older builds have no such
 * activation type at all.
 */
export const PROCESS_LOOPBACK_MIN_WINDOWS_BUILD = 19041;

/** Which process tree the capture follows. See the module doc. */
export type ProcessAudioMode = "app" | "system";

/**
 * Renderer's request to start a process-audio capture. Never a raw PID:
 *   - "app" names a `window:` source from a prior capture.listSources(); main
 *     resolves the owning PID itself, so the renderer can never point the
 *     capture at an arbitrary process.
 *   - "system" takes no target — main always excludes its OWN process tree.
 */
export type ProcessAudioStartRequest =
  | { mode: "app"; sourceId: string }
  | { mode: "system" };

/** Why a capture cannot run. None is fatal to the share: it goes out without
 *  sound and the sharer is told why. */
export type ProcessAudioUnavailableReason =
  /** Not Windows. */
  | "unsupported_platform"
  /** Windows older than {@link PROCESS_LOOPBACK_MIN_WINDOWS_BUILD}. */
  | "unsupported_os"
  /** "app" mode on a source that is not a window. */
  | "not_a_window"
  /** The source id was not in main's latest enumeration. */
  | "unknown_source"
  /**
   * The process rendering the window could not be found: the window closed, or
   * it is a packaged (UWP) app frame whose app is minimized or suspended.
   */
  | "pid_unresolved"
  /**
   * The window belongs to Demli itself or to one of Demli's ancestors (for
   * example Explorer, which launched Demli). Its process tree CONTAINS Demli,
   * so "app" mode would capture the call's voices — refused.
   */
  | "includes_demli"
  | "binary_missing"
  | "spawn_failed"
  /** The helper started but Windows refused the capture. */
  | "activation_failed";

/** Whether process capture can work on this machine, asked before a share so
 *  the picker never offers an option that cannot work. */
export type ProcessAudioSupport =
  | { supported: true }
  | { supported: false; reason: "unsupported_platform" | "unsupported_os" | "binary_missing" };

/** Result of a start request. On success the renderer subscribes to `onData`
 *  for `captureId` and rebuilds a track using `format`. The PID is deliberately
 *  NOT exposed to the renderer (minimal surface). */
export type ProcessAudioStartResult =
  | { ok: true; captureId: number; mode: ProcessAudioMode; format: ProcessAudioFormat }
  | { ok: false; reason: ProcessAudioUnavailableReason };

/** A raw PCM chunk for an active capture (main -> renderer). */
export interface ProcessAudioChunk {
  captureId: number;
  /** Raw interleaved PCM bytes in {@link PROCESS_AUDIO_FORMAT}. */
  chunk: Uint8Array;
}

/** Notification that a capture ended (main -> renderer). */
export interface ProcessAudioEndedEvent {
  captureId: number;
  /** Short machine reason, e.g. "exit", "error", "stopped". */
  reason: string;
}

/**
 * The preload bridge surface for process audio. Mirrors the capture bridge
 * idioms: fixed channels, main-re-validated payloads, subscribe methods that
 * forward ONLY the sanitized payload (never the raw IPC event) and return an
 * unsubscribe function.
 */
export interface ProcessAudioBridge {
  /** Can this machine capture process audio? */
  support(): Promise<ProcessAudioSupport>;
  /** Start an "app" (one window's process tree) or "system" (all but Demli) capture. */
  start(request: ProcessAudioStartRequest): Promise<ProcessAudioStartResult>;
  /** Stop a capture by id. Best-effort; safe to call more than once. */
  stop(captureId: number): Promise<void>;
  /** Subscribe to PCM chunks (all captures; filter by captureId). Returns unsubscribe. */
  onData(listener: (chunk: ProcessAudioChunk) => void): () => void;
  /** Subscribe to capture-ended events. Returns unsubscribe. */
  onEnded(listener: (event: ProcessAudioEndedEvent) => void): () => void;
}
