/**
 * Desktop "Yüksek (Krisp benzeri)" noise-suppression tier — an RNNoise WASM
 * AudioWorklet inserted between the AEC'd mic capture and the LiveKit publish.
 *
 * This is the PLATFORM half of the media package's noise-filter seam
 * (CLAUDE.md §11): `@demli/media` stays RN-safe and DOM-free and only knows the
 * structural {@link AudioTrackProcessorLike} type; the desktop renderer (which Vite
 * bundles the worklet + WASM into) provides the concrete implementation and injects
 * the factory via `createVoiceEngine({ createNoiseFilter })`. The engine attaches a
 * fresh processor to the LIVE mic whenever the effective NS tier is `high` and
 * detaches it otherwise, via the web adapter's `applyNoiseFilter` (setProcessor).
 *
 * RNNoise is Krisp's open-source class of ML noise suppression. We use
 * `@sapphi-red/web-noise-suppressor` (MIT) for the prebuilt worklet + WASM. The
 * worklet JS and the WASM binaries are imported as Vite `?url` assets so they are
 * emitted into the renderer build and loaded same-origin (`script-src 'self'` for
 * the worklet, `connect-src 'self'` for the WASM fetch).
 *
 * IMPORTANT — WebAssembly under CSP: instantiating the WASM requires
 * `'wasm-unsafe-eval'` in the renderer `script-src`. Without it Chromium blocks the
 * instantiation and this processor's `init` rejects — at which point the media
 * engine latches the filter broken and re-publishes the mic with the built-in
 * WebRTC noise suppression (High degrades to Standard, never to "no suppression").
 * So a missing CSP directive is a QUALITY regression to Standard, never a broken
 * mic. See the handoff report for the exact CSP change.
 *
 * WHY A WET/DRY RESIDUAL MIX (the founder's "High cuts my voice entirely" P0):
 * RNNoise is a per-band ML gate. On some microphones/voices it MIS-CLASSIFIES
 * speech as noise and attenuates the whole signal to near-silence — so the far end
 * hears nothing (the exact symptom once `'wasm-unsafe-eval'` finally let the worklet
 * run for real). Publishing the raw worklet output has NO floor: when RNNoise zeroes
 * a frame, the published audio is zero. The fix is a parallel mix — the destination
 * sums a WET path (RNNoise output) with a small DRY residual of the SAME AEC'd
 * capture, delay-aligned to the worklet's latency so the two don't comb-filter:
 *
 *   source ─┬─→ RnnoiseWorkletNode ─→ wetGain ─┐
 *           └─→ dryDelay ─→ dryGain ───────────┴─→ MediaStreamDestination → publish
 *
 * The residual guarantees speech is ALWAYS audible (worst case: the DRY floor, ~−15
 * dB), while noise is still cut by (1 − DRY). During real speech RNNoise passes the
 * voice, so WET + DRY sum back to roughly unity. See {@link WET_GAIN}/{@link DRY_GAIN}
 * — these are the two calibration knobs (raise DRY if voice is still too quiet, lower
 * it if too much noise leaks through).
 */

import type { AudioProcessorOptionsLike, AudioTrackProcessorLike } from "@demli/media";
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

/**
 * WET (RNNoise-denoised) path gain. Kept at ~unity so, during real speech (RNNoise
 * passes the voice), WET + DRY sum to roughly full level.
 */
const WET_GAIN = 0.85;

/**
 * DRY (residual, un-denoised) path gain — the SAFETY FLOOR that makes it impossible
 * for the tier to fully mute the mic. Even if RNNoise attenuates a frame to zero, the
 * far end still hears the voice at this level (~−15 dB). This is the founder-facing
 * tuning knob: raise it toward ~0.3 if High still sounds too quiet, lower it toward
 * ~0.1 for stronger suppression at the cost of a little residual noise.
 */
const DRY_GAIN = 0.18;

/**
 * The RNNoise worklet's group delay in samples. `@sapphi-red/web-noise-suppressor`'s
 * ring buffer reads its output `(floor(480/128)+1)*128 + 128 = 640` samples behind the
 * input write, so the WET path lags the raw capture by ~13.3 ms at 48 kHz. The DRY
 * residual is delayed by the same amount so the two paths stay time-aligned and don't
 * comb-filter the voice. A small misalignment only matters at high DRY gains; at our
 * residual level it is inaudible.
 */
const WORKLET_LATENCY_SAMPLES = 640;

/**
 * Load the RNNoise WASM binary once and cache it (the engine builds a NEW processor
 * per mic capture, but they can all share one immutable binary). The `?url` imports
 * resolve to same-origin asset URLs the fetch inside `loadRnnoise` reads.
 */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
function loadWasmBinary(): Promise<ArrayBuffer> {
  wasmBinaryPromise ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseWasmSimdUrl });
  return wasmBinaryPromise;
}

/**
 * Register the RNNoise worklet module on an AudioContext at most once per context.
 * `addModule` is idempotent but we guard with a WeakMap so repeated joins/republishes
 * don't re-fetch it. Keyed by the context so a rebuilt context re-registers.
 */
const registeredContexts = new WeakMap<BaseAudioContext, Promise<void>>();
function ensureWorkletModule(ctx: BaseAudioContext): Promise<void> {
  let pending = registeredContexts.get(ctx);
  if (!pending) {
    pending = ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    registeredContexts.set(ctx, pending);
  }
  return pending;
}

/**
 * One RNNoise processor instance bound to a single mic track. Implements the LiveKit
 * audio `TrackProcessor` contract (structurally {@link AudioTrackProcessorLike}):
 * livekit calls `init` with the raw AEC'd mic track + an AudioContext, publishes
 * {@link processedTrack} in its place, calls `restart` on a device switch, and
 * `destroy` when the track is torn down.
 *
 * Graph (see file header): the source fans out to a WET path (RNNoise) and a
 * delay-aligned DRY residual; both are summed at a MediaStreamDestination whose track
 * is published. AEC has already run at capture, so RNNoise only cleans the residual
 * noise (the correct ordering — never before AEC).
 */
class RnnoiseNoiseFilter implements AudioTrackProcessorLike {
  readonly name = "demli-rnnoise";
  processedTrack?: MediaStreamTrack;

  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: RnnoiseWorkletNode | null = null;
  private wetGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private dryDelay: DelayNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;

  async init(opts: AudioProcessorOptionsLike): Promise<void> {
    const ctx = opts.audioContext;
    this.context = ctx;
    await ensureWorkletModule(ctx);
    const wasmBinary = await loadWasmBinary();
    // maxChannels: 2 covers both the common mono voice capture AND the edge case where
    // the user pairs High noise suppression with the stereo "Music" audio-quality tier
    // (NS tier and quality tier are independent) — maxChannels: 1 would drop a channel.
    this.node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 2 });
    this.destination = ctx.createMediaStreamDestination();

    // WET path: RNNoise output at ~unity.
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = WET_GAIN;
    this.node.connect(this.wetGain);
    this.wetGain.connect(this.destination);

    // DRY residual path: the same AEC'd capture, delayed to match the worklet's group
    // delay, at a small floor gain so the voice is NEVER fully muted even if RNNoise
    // over-suppresses (the founder's "High cuts my voice" P0). See the file header.
    this.dryDelay = ctx.createDelay(1);
    this.dryDelay.delayTime.value = WORKLET_LATENCY_SAMPLES / ctx.sampleRate;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = DRY_GAIN;
    this.dryDelay.connect(this.dryGain);
    this.dryGain.connect(this.destination);

    this.connectSource(opts.track);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptionsLike): Promise<void> {
    // Device switch: livekit hands us a new raw track on the same context/graph.
    // Swap only the source node; keep the worklet + mix graph (and therefore the
    // published processedTrack identity) intact.
    if (!this.context || !this.node) {
      await this.init(opts);
      return;
    }
    this.connectSource(opts.track);
  }

  async destroy(): Promise<void> {
    try {
      this.source?.disconnect();
      this.wetGain?.disconnect();
      this.dryGain?.disconnect();
      this.dryDelay?.disconnect();
      this.node?.disconnect();
      this.node?.destroy();
    } catch {
      // Best-effort teardown — nodes may already be detached with the context.
    }
    this.source = null;
    this.node = null;
    this.wetGain = null;
    this.dryGain = null;
    this.dryDelay = null;
    this.destination = null;
    this.processedTrack = undefined;
    this.context = null;
  }

  /**
   * (Re)build the source node from a raw mic track and fan it out to BOTH the WET
   * (RNNoise) and DRY (residual) paths.
   */
  private connectSource(track: MediaStreamTrack): void {
    if (!this.context || !this.node) return;
    try {
      this.source?.disconnect();
    } catch {
      // Best-effort — the previous source may already be detached.
    }
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.node);
    if (this.dryDelay) this.source.connect(this.dryDelay);
  }
}

/**
 * The factory injected into the voice engine (`createNoiseFilter`). Returns a NEW
 * processor per mic capture — livekit owns each instance's init/restart/destroy.
 */
export function createRnnoiseFilter(): AudioTrackProcessorLike {
  return new RnnoiseNoiseFilter();
}
