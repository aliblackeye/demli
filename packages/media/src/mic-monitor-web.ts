/**
 * Web/Electron implementation of {@link MicMonitor} — "Kendini dinle".
 *
 * Reachable ONLY through the `@demli/media/web` entry (like livekit.ts): it
 * touches getUserMedia, AudioContext and an <audio> element, so it must never be
 * pulled into the React Native bundle.
 *
 * The graph it builds is deliberately the SAME one the publish path builds:
 *
 *   getUserMedia(config.capture + deviceId)      ← identical DSP constraints
 *        └→ createNoiseFilter().init({track, ctx})  ← the identical RNNoise worklet
 *             └→ processor.processedTrack
 *                  └→ <audio srcObject> (+ setSinkId)  ← the user's ears
 *
 * When `config.createNoiseFilter` is null (Standart / Kapalı tier, or no filter
 * on this platform) the raw capture is played instead — which is CORRECT for
 * those tiers, because that is exactly what the publish sends.
 *
 * HEADPHONES: monitoring plays your mic through your output. On speakers the
 * capture's echo cancellation will chew on that loop and you will hear a gated,
 * unrepresentative version of yourself. The UI says so; nothing here can fix it.
 */

import { AUDIO_CAPTURE_SAMPLE_RATE } from "./audio-settings.js";
import type { MicMonitor, MicMonitorConfig } from "./mic-monitor.js";
import type { AudioTrackProcessorLike } from "./room-adapter.js";

/** `setSinkId` is not in every TS DOM lib version; narrow it structurally. */
type SinkCapableAudio = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

export function createWebMicMonitor(): MicMonitor {
  /** The raw getUserMedia stream we own and must stop (releases the OS mic light). */
  let capture: MediaStream | null = null;
  /** The worklet processor instance we own and must destroy. */
  let processor: AudioTrackProcessorLike | null = null;
  /** Our own 48 kHz context for the worklet (RNNoise's model assumes 48 kHz). */
  let context: AudioContext | null = null;
  /** The playback element; detached + paused on stop so it can be GC'd. */
  let element: HTMLAudioElement | null = null;
  /**
   * Bumped by every start/stop so a slow `start` that lost the race (device
   * switched again mid-getUserMedia, or the user turned monitoring off) tears its
   * own half-built graph down instead of leaking it.
   */
  let generation = 0;

  function stopStream(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Best-effort — the device may already be gone.
      }
    }
  }

  async function release(): Promise<void> {
    if (element) {
      const el = element;
      element = null;
      try {
        el.pause();
        el.srcObject = null;
      } catch {
        // Best-effort — the element may already be detached.
      }
    }
    if (processor) {
      const p = processor;
      processor = null;
      try {
        await p.destroy();
      } catch {
        // Best-effort — the worklet may have failed to init in the first place.
      }
    }
    stopStream(capture);
    capture = null;
    if (context) {
      const ctx = context;
      context = null;
      try {
        await ctx.close();
      } catch {
        // Best-effort — the context may already be closed.
      }
    }
  }

  /**
   * Build the noise-filter stage. Returns the track to PLAY: the worklet's
   * `processedTrack` on success, or the raw capture when the worklet fails to
   * load (WASM/CSP). A failed worklet degrades the monitor to the same fallback
   * the publish uses in that situation (built-in WebRTC NS), so the two still
   * agree — it never leaves the user listening to silence.
   */
  async function attachFilter(
    raw: MediaStreamTrack,
    factory: () => AudioTrackProcessorLike,
  ): Promise<MediaStreamTrack> {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ sampleRate: AUDIO_CAPTURE_SAMPLE_RATE });
    context = ctx;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // A suspended context still builds the graph; it resumes on the next gesture.
      }
    }
    const instance = factory();
    try {
      await instance.init({ track: raw, audioContext: ctx });
    } catch {
      try {
        await instance.destroy();
      } catch {
        // Best-effort.
      }
      try {
        await ctx.close();
      } catch {
        // Best-effort.
      }
      context = null;
      return raw;
    }
    processor = instance;
    return instance.processedTrack ?? raw;
  }

  return {
    async start(config: MicMonitorConfig): Promise<void> {
      const gen = ++generation;
      await release();
      if (gen !== generation) return;

      // Same constraints as the publish, plus the explicit device pin. `exact` so
      // a missing device surfaces as OverconstrainedError instead of silently
      // monitoring a different mic than the one being published.
      const audio: MediaTrackConstraints = { ...(config.capture ?? {}) };
      if (config.inputDeviceId) audio.deviceId = { exact: config.inputDeviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (gen !== generation) {
        stopStream(stream);
        return;
      }
      capture = stream;

      const raw = stream.getAudioTracks()[0];
      if (!raw) {
        await release();
        throw new DOMException("No audio track was captured.", "NotFoundError");
      }

      const playable = config.createNoiseFilter
        ? await attachFilter(raw, config.createNoiseFilter)
        : raw;
      if (gen !== generation) {
        await release();
        return;
      }

      const el = new Audio() as SinkCapableAudio;
      el.autoplay = true;
      // Never let the monitor itself be routed as a "call" element; it is a plain
      // local playback of our own capture.
      el.srcObject = new MediaStream([playable]);
      if (config.outputDeviceId && typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(config.outputDeviceId);
        } catch {
          // Best-effort — an unavailable sink falls back to the default output.
        }
      }
      if (gen !== generation) {
        try {
          el.pause();
          el.srcObject = null;
        } catch {
          // Best-effort.
        }
        await release();
        return;
      }
      element = el;
      try {
        await el.play();
      } catch {
        // Autoplay policy can defer the first play(); the element stays bound and
        // starts on the next user gesture. Never fatal — the graph is live.
      }
    },

    async stop(): Promise<void> {
      generation++;
      await release();
    },
  };
}
