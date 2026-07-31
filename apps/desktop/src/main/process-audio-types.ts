/**
 * Shared per-process audio-capture contract (Windows process loopback).
 *
 * This module — like `capture-types.ts` — is the ONLY surface that crosses the
 * main <-> preload <-> renderer boundary for the process-audio feature. It is
 * pure TypeScript: it imports NOTHING from `electron` or `node`, so it is safe
 * to import from main (values + types), preload (values + types) and the
 * renderer (types only). Do not add electron/node imports here.
 *
 * WHY this feature exists (founder P0): the shared window's
 * FILM sound is captured straight from that window's PROCESS via the Windows
 * WASAPI process-loopback API (AUDCLNT activation on a process tree, Win10
 * 20348+). That bypasses the render endpoint entirely — so it works even when
 * the default output is a virtual mixer (Voicemeeter Input / VB-CABLE) whose
 * endpoint loopback comes up SILENT. The capture is performed by a small,
 * bundled helper binary (Microsoft's ApplicationLoopback sample) that streams
 * raw PCM to stdout; main reads it and forwards PCM chunks to the renderer,
 * which rebuilds a MediaStreamTrack for the LiveKit publish.
 */

/**
 * IPC channel names for the process-audio feature. Single source of truth —
 * never hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const PROCESS_AUDIO_CHANNELS = {
  /** renderer -> main (invoke): start capturing a window source's process audio. */
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
 * Renderer's request to start a process-audio capture. Only a `sourceId` is
 * passed — never a raw PID. Main resolves the PID itself from the (allow-listed)
 * window source, so the renderer can never point the capture at an arbitrary
 * process.
 */
export interface ProcessAudioStartRequest {
  /** Must equal a `window:` source id returned by a prior capture.listSources(). */
  sourceId: string;
}

/** Why a start request could not begin a capture (renderer falls back to the
 *  existing loopback ladder on any of these — none is fatal to the share). */
export type ProcessAudioUnavailableReason =
  | "unsupported_platform"
  | "not_a_window"
  | "unknown_source"
  | "pid_unresolved"
  | "binary_missing"
  | "spawn_failed";

/** Result of a start request. On success the renderer subscribes to `onData`
 *  for `captureId` and rebuilds a track using `format`. The PID is deliberately
 *  NOT exposed to the renderer (minimal surface). */
export type ProcessAudioStartResult =
  | { ok: true; captureId: number; format: ProcessAudioFormat }
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
  /** Start capturing the given window source's process audio. */
  start(request: ProcessAudioStartRequest): Promise<ProcessAudioStartResult>;
  /** Stop a capture by id. Best-effort; safe to call more than once. */
  stop(captureId: number): Promise<void>;
  /** Subscribe to PCM chunks (all captures; filter by captureId). Returns unsubscribe. */
  onData(listener: (chunk: ProcessAudioChunk) => void): () => void;
  /** Subscribe to capture-ended events. Returns unsubscribe. */
  onEnded(listener: (event: ProcessAudioEndedEvent) => void): () => void;
}
