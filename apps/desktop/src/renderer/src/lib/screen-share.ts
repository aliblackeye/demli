/**
 * Screen-share ACQUISITION — the Electron-specific half of screen sharing.
 *
 * This is the platform seam kept OUT of `@demli/media` (the engine stays
 * platform-agnostic so mobile can reuse it). Here we drive the desktop capture
 * bridge (`window.demli.capture`) + `navigator.mediaDevices.getDisplayMedia`
 * to obtain a screen video track (plus optional system/loopback "film" audio),
 * then hand the raw tracks to `engine.startScreenShare(acquire)` which owns the
 * LiveKit publish + FSM transitions.
 *
 * M8 additions:
 *  - Quality presets (`ScreenShareQuality` from @demli/media): the SAME
 *    profile caps the getDisplayMedia capture here and the encoder ceiling in
 *    the engine, so capture and publish always agree.
 *  - System-audio toggle: `systemAudio: false` arms the source with
 *    `audio: false` and never returns (so never publishes) an audio track.
 *  - Both choices persist in localStorage (see load/saveScreenSharePrefs).
 *
 * Contract reference: `.claude/reports/b-desktop-capture.md`. The selection is
 * single-shot (armed per share), and getDisplayMedia must request audio for the
 * loopback track to arrive.
 */

import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  isScreenShareQuality,
  SCREEN_SHARE_QUALITY_PROFILES,
  type ScreenShareAssets,
  type ScreenShareQuality,
} from "@demli/media";

/** The capture bridge surface exposed by the preload (typed via the global). */
type CaptureBridge = Window["demli"]["capture"];

/** A capturable screen/window, as returned by the bridge (id === engine sourceId). */
export type CaptureSource = Awaited<ReturnType<CaptureBridge["listSources"]>>[number];

/** The user's per-share choices, picked in the SourcePicker (M8). */
export interface ScreenShareStartOptions {
  /** Quality preset — caps capture AND encoder (default "balanced"). */
  quality: ScreenShareQuality;
  /**
   * Whether to capture + publish system/loopback audio (the film's sound).
   * Only effective where loopback is supported (Windows); see
   * {@link isLoopbackAudioSupported}.
   */
  systemAudio: boolean;
}

/** Result of a full acquisition, including system-audio reconciliation. */
export interface AcquiredScreenShare {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  /** True when a system/loopback audio track was actually captured (film sound). */
  hasSystemAudio: boolean;
  /** True when loopback was supported/attempted but no audio track materialized. */
  systemAudioUnavailable: boolean;
  /**
   * Which ladder source is feeding the published film audio — surfaced in the
   * VoicePanel so a silent share is DIAGNOSABLE at a glance (founder remote
   * debugging: "hangi kaynak seçildi?"). Null when no audio is published.
   */
  filmAudioSource: "process" | "loopback" | `mixinput:${string}` | null;
}

/** Thrown when screen capture is used outside Electron (no capture bridge). */
export class ScreenShareUnavailableError extends Error {
  constructor() {
    super("Screen sharing is only available in the desktop app.");
    this.name = "ScreenShareUnavailableError";
  }
}

/** True when the desktop capture bridge is present (i.e. running in Electron). */
export function isScreenCaptureAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.demli?.capture);
}

/**
 * True when system/loopback audio capture is available. Mirrors the main
 * process's own gate (`process.platform === "win32"` in `main/capture.ts`) so
 * the picker can show the right state BEFORE arming a source.
 */
export function isLoopbackAudioSupported(): boolean {
  return isScreenCaptureAvailable() && window.demli.appInfo.platform === "win32";
}

/**
 * True when running as the WEB build (browser), not Electron. The desktop
 * film-audio ladder (per-process WASAPI + endpoint loopback) has NO browser
 * analogue — `window.demli.processAudio` is a shim no-op and there is no
 * `getDisplayMedia` loopback arming — so web screen sharing takes its own path:
 * the browser's native picker already offers a "Share tab/system audio" checkbox,
 * and that audio arrives on the same `getDisplayMedia` stream (see
 * {@link acquireWebScreenShare}). Desktop (win32/darwin) is false, so its proven
 * capture path is completely untouched.
 */
export function isWebPlatform(): boolean {
  // The desktop `window.demli` global types `platform` as `NodeJS.Platform`
  // (the preload sets `process.platform`), but the WEB build reuses this exact
  // renderer with a shim that injects `platform: "web"` at runtime — a value the
  // compile-time type doesn't include. Compare as a widened string so the seam
  // typechecks against the desktop global while still matching the web reality.
  const platform = window.demli?.appInfo?.platform as string | undefined;
  return typeof window !== "undefined" && platform === "web";
}

/**
 * True when the WEB build's browser can deliver the shared tab/system audio on
 * the `getDisplayMedia` stream. Only Chromium engines offer display audio
 * (Chrome/Edge/Opera show a "share audio" checkbox in their picker); Firefox
 * and Safari always return a video-only stream, silently. There is no direct
 * feature probe for display audio, so we detect Chromium via
 * `navigator.userAgentData` — a Chromium-only API (Chrome/Edge 90+) that
 * predates every Chromium build we serve. Honest capability signal for the
 * picker (§35): on a browser where the checkbox will never appear the toggle
 * is disabled with an explainer instead of promising sound that cannot come.
 * Always false on desktop — the native loopback/process ladder owns audio there.
 */
export function isWebDisplayAudioCapable(): boolean {
  return (
    isWebPlatform() &&
    typeof navigator !== "undefined" &&
    "userAgentData" in navigator &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

function requireCapture(): CaptureBridge {
  if (!isScreenCaptureAvailable()) throw new ScreenShareUnavailableError();
  return window.demli.capture;
}

/** Enumerate capturable screens + windows for the in-app picker. */
export function listScreenSources(): Promise<CaptureSource[]> {
  return requireCapture().listSources();
}

// ---------------------------------------------------------------------------
// Persisted share preferences (M8)
// ---------------------------------------------------------------------------

const QUALITY_STORAGE_KEY = "demli:screen-share:quality";
const SYSTEM_AUDIO_STORAGE_KEY = "demli:screen-share:system-audio";

/**
 * Load the remembered share choices. Defaults: quality "balanced", system
 * audio ON (the film scenario). Unknown/corrupt stored values fall back to
 * the defaults — never trust localStorage blindly.
 */
export function loadScreenSharePrefs(): ScreenShareStartOptions {
  let quality: ScreenShareQuality = DEFAULT_SCREEN_SHARE_QUALITY;
  let systemAudio = true;
  try {
    const storedQuality = window.localStorage.getItem(QUALITY_STORAGE_KEY);
    if (isScreenShareQuality(storedQuality)) quality = storedQuality;
    systemAudio = window.localStorage.getItem(SYSTEM_AUDIO_STORAGE_KEY) !== "false";
  } catch {
    // Storage unavailable (private mode, quota) — use defaults.
  }
  return { quality, systemAudio };
}

/** Persist the share choices for the next share. Best-effort. */
export function saveScreenSharePrefs(prefs: ScreenShareStartOptions): void {
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, prefs.quality);
    window.localStorage.setItem(SYSTEM_AUDIO_STORAGE_KEY, String(prefs.systemAudio));
  } catch {
    // Best-effort — a failed write only loses the remembered preference.
  }
}

// ---------------------------------------------------------------------------
// Film-audio SOURCE MEMORY (speed contract)
// ---------------------------------------------------------------------------

/**
 * Remember which film-audio SOURCE won last time so the NEXT share uses it
 * DIRECTLY, with no probing — the share then starts instantly instead of paying
 * the first-share scan (~1–2s) every time (founder: "yayın bayağı geç açılıyor").
 *
 * Self-healing: the post-publish 4s silence guardian (makeScreenShareAcquire →
 * onSilentLoopback) CLEARS this memory when a published source turns out silent,
 * so a stale winner degrades to a one-off full re-scan rather than a permanent
 * silent share.
 */
const FILM_AUDIO_SOURCE_KEY = "demli:screen-share:film-audio-source";

type FilmAudioMemory =
  | { kind: "process" }
  | { kind: "loopback" }
  | { kind: "mixinput"; label: string };

function loadFilmAudioMemory(): FilmAudioMemory | null {
  try {
    const raw = window.localStorage.getItem(FILM_AUDIO_SOURCE_KEY);
    if (!raw) return null;
    if (raw === "process") return { kind: "process" };
    if (raw === "loopback") return { kind: "loopback" };
    if (raw.startsWith("mixinput:")) {
      const label = raw.slice("mixinput:".length);
      if (label) return { kind: "mixinput", label };
    }
  } catch {
    // Storage unavailable — behave as if nothing is remembered.
  }
  return null;
}

function saveFilmAudioMemory(memory: FilmAudioMemory): void {
  try {
    const value =
      memory.kind === "mixinput" ? `mixinput:${memory.label}` : memory.kind;
    window.localStorage.setItem(FILM_AUDIO_SOURCE_KEY, value);
  } catch {
    // Best-effort — losing the hint only costs one slower share.
  }
}

function clearFilmAudioMemory(): void {
  try {
    window.localStorage.removeItem(FILM_AUDIO_SOURCE_KEY);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

/**
 * getDisplayMedia constrained to the quality profile. The caps here must match
 * the engine's `screenShareEncoding` (same profile) so we never capture pixels
 * the encoder will throw away. `audio` gates whether loopback is requested.
 */
function getDisplayMedia(audio: boolean, quality: ScreenShareQuality): Promise<MediaStream> {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: profile.width },
      height: { max: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    },
    audio,
  });
}

/**
 * Acquire a screen-share stream for `sourceId` with the user's share options.
 * Requests loopback audio only when the user asked for it AND the platform
 * supports it, and falls back to video-only if the combined request is
 * rejected by the audio driver (per the capture report's fallback contract). A
 * genuine permission denial rejects both attempts and propagates so the engine
 * maps it to `permission_denied(screen)`.
 */
/**
 * ONCE-PER-SESSION loopback WARM-UP — the real "yayın sesi gitmiyor" fix.
 * Measured on the founder's machine (standalone Electron probe, 2 runs, both
 * source types): the FIRST WASAPI loopback capture of an Electron process is
 * (near-)silent — peak ~0.003 — while every subsequent capture carries full
 * signal (~0.13), regardless of screen vs window. So the first share of an app
 * session always went out silent. Remedy: before the first real capture, run a
 * throwaway screen+loopback capture for ~450ms and drop it — the real capture
 * is then loopback #2 and carries audio. Best-effort and once per session.
 */
let loopbackWarmedUp = false;

async function warmUpLoopback(capture: ReturnType<typeof requireCapture>): Promise<void> {
  if (loopbackWarmedUp) return;
  loopbackWarmedUp = true; // even a failed attempt counts — never retry-loop
  try {
    const sources = await capture.listSources({ maxThumbnailWidth: 32 });
    const screen = sources.find((s) => s.id.startsWith("screen:"));
    if (!screen) return;
    const armed = await capture.selectSource({ sourceId: screen.id, audio: true });
    if (armed.audio !== "loopback") return;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    await new Promise((resolve) => setTimeout(resolve, 450));
    for (const t of stream.getTracks()) t.stop();
  } catch {
    // Warm-up is best-effort; the silent-probe still warns if capture is dead.
  }
}

/**
 * FALLBACK loopback capture: if the combined request produced NO audio track
 * (some drivers/platform combos refuse audio alongside a window source), run a
 * second, throwaway SCREEN request armed `loopback`, keep ONLY its audio track
 * and stop its video. Best-effort: null keeps the share video-only (the
 * `systemAudioUnavailable` warning tells the sharer).
 */
async function captureLoopbackAudioViaScreen(
  capture: ReturnType<typeof requireCapture>,
  quality: ScreenShareQuality,
): Promise<MediaStreamTrack | null> {
  try {
    const sources = await capture.listSources({ maxThumbnailWidth: 32 });
    const screen = sources.find((s) => s.id.startsWith("screen:"));
    if (!screen) return null;
    const armed = await capture.selectSource({ sourceId: screen.id, audio: true });
    if (armed.audio !== "loopback") return null;
    const stream = await getDisplayMedia(true, quality);
    for (const v of stream.getVideoTracks()) v.stop();
    const audio = stream.getAudioTracks()[0] ?? null;
    if (audio && audio.readyState === "ended") {
      audio.stop();
      return null;
    }
    return audio;
  } catch {
    return null;
  }
}

/**
 * Virtual system-mix RECORDING devices (Voicemeeter "Out" strips, VB-Cable
 * "CABLE Output", "Stereo Mix", hardware loopback returns). On pro-audio
 * setups the DEFAULT RENDER device is a virtual mixer input (founder's box:
 * default output = "Voicemeeter Input") and WASAPI loopback of it yields
 * SILENCE — while the same mixer exposes the full system mix as an INPUT
 * device. Capturing that input as plain getUserMedia is then the correct
 * film-audio source.
 */
const MIX_INPUT_PATTERN = /voicemeeter out|cable output|stereo mix|loopback/i;

async function captureSystemMixInput(): Promise<{ track: MediaStreamTrack; label: string } | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const candidates = devices.filter(
      (d) => d.kind === "audioinput" && MIX_INPUT_PATTERN.test(d.label),
    );
    // Prefer the system-DEFAULT input when it is itself a mix device — that is
    // exactly "what VoIP apps hear" on a Voicemeeter setup.
    candidates.sort(
      (a, b) => Number(b.deviceId === "default") - Number(a.deviceId === "default"),
    );
    // Probe ALL candidates CONCURRENTLY (a serial scan would cost 1.2s × N —
    // 10+ virtual strips exist on a Voicemeeter box). Winner = the highest-
    // priority device with real signal; every other capture is stopped.
    const probed = await Promise.all(
      candidates.map(async (dev) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: dev.deviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
            },
          });
          const track = stream.getAudioTracks()[0] ?? null;
          if (!track) return null;
          const hasSignal = await probeAudioSignal(track, 1200);
          return { dev, track, hasSignal };
        } catch {
          return null;
        }
      }),
    );
    const winner = probed.find((p) => p?.hasSignal) ?? null;
    for (const p of probed) {
      if (p && p !== winner) p.track.stop();
    }
    if (winner) {
      console.warn(`[voice] film audio via system-mix input: ${winner.dev.label}`);
      return { track: winner.track, label: winner.dev.label };
    }
  } catch {
    // Enumeration failed — no fallback available.
  }
  return null;
}

/**
 * Open a SPECIFIC system-mix input device by label — the remembered-winner fast
 * path (no probing, no scan of every strip). Returns null if the device is gone
 * or capture fails, so the caller can fall back to a full scan.
 */
async function captureMixInputByLabel(label: string): Promise<MediaStreamTrack | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const dev = devices.find((d) => d.kind === "audioinput" && d.label === label);
    if (!dev) return null;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: dev.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    const track = stream.getAudioTracks()[0] ?? null;
    if (track && track.readyState === "ended") {
      track.stop();
      return null;
    }
    return track;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// STEP 1: per-process audio capture (Windows process loopback)
// ---------------------------------------------------------------------------

/** The process-audio bridge surface exposed by the preload (typed via global). */
type ProcessAudioBridge = Window["demli"]["processAudio"];

/** A live process-loopback capture: the rebuilt track + a teardown handle. */
interface ProcessAudioCapture {
  track: MediaStreamTrack;
  stop: () => void;
  /** Bytes of PCM received so far — 0 means the app has not played anything YET. */
  bytesReceived: () => number;
  /** True once the helper process has exited (a genuinely dead capture). */
  ended: () => boolean;
}

/** True for `window:` sources — the only kind a per-process capture applies to
 *  (a full-screen share has no single owning process). */
function isWindowSource(sourceId: string): boolean {
  return sourceId.startsWith("window:");
}

/** True when the process-audio bridge is present AND we are on Windows. */
function isProcessAudioSupported(): boolean {
  return (
    isScreenCaptureAvailable() &&
    Boolean(window.demli.processAudio) &&
    window.demli.appInfo.platform === "win32"
  );
}

/**
 * STEP 1 of the film-audio ladder: capture the shared WINDOW's audio straight
 * from its process via the main-process WASAPI process-loopback helper, then
 * rebuild a MediaStreamTrack from the PCM stream. This bypasses the render
 * endpoint entirely, so it works even on virtual-mixer setups (Voicemeeter /
 * VB-CABLE) where endpoint loopback comes up SILENT — the founder's exact box.
 *
 * Returns null (→ caller falls through to the loopback ladder) ONLY when the
 * capture is genuinely impossible: not a window, unsupported, the helper could
 * not resolve a PID / spawn, or the helper process EXITED within `graceMs`.
 *
 * It deliberately does NOT reject a capture that has produced zero bytes. That
 * was the "yayın sesi gitmiyor" root cause (3rd report): the vendored
 * ApplicationLoopback helper emits NOTHING — not even silence padding — while
 * the target process has no ACTIVE WASAPI render stream, and an app that is
 * merely paused (or not started yet) has none. Measured on the founder's box:
 * `explorer.exe` → 0 bytes forever; a player that starts 5s late → 0 bytes, then
 * full signal at 5.6s. So "0 bytes at t=0" means "the film has not been pressed
 * play yet" — the single most common way a share begins — and tearing the
 * capture down there threw away the ONE definitionally-correct source, leaving
 * the ladder to publish a permanently-silent Voicemeeter endpoint instead.
 * The capture RECOVERS on its own the instant playback starts, so we keep it and
 * let the supervisor ({@link superviseFilmAudio}) confirm or replace it.
 *
 * NOTE: the PCM→track bridge uses a ScriptProcessorNode. It is deprecated but
 * (a) needs no external worklet module — which the renderer's strict CSP
 * (`script-src 'self'`) would block as a blob: URL — and (b) is self-contained
 * in this file. A future AudioWorklet upgrade is a frontend-ui follow-up.
 */
async function captureProcessAudioTrack(
  sourceId: string,
  graceMs = 700,
): Promise<ProcessAudioCapture | null> {
  if (!isProcessAudioSupported() || !isWindowSource(sourceId)) return null;
  const bridge: ProcessAudioBridge = window.demli.processAudio;

  let started: Awaited<ReturnType<ProcessAudioBridge["start"]>>;
  try {
    started = await bridge.start({ sourceId });
  } catch {
    return null;
  }
  if (!started.ok) return null;
  const { captureId, format } = started;
  const { sampleRate, channels } = format;

  const ctx = new AudioContext({ sampleRate });
  // A user gesture (the "share" click) precedes this, so resume() is allowed.
  await ctx.resume().catch(() => undefined);
  const dest = ctx.createMediaStreamDestination();

  // Stereo float ring buffer. Producer (helper WASAPI clock) and consumer
  // (AudioContext clock) drift apart over time; a big buffer lets that drift
  // accumulate as GROWING LATENCY — the film audio slides progressively behind
  // the video (founder: "yayında ses kayması var"). Fix: keep the buffer SMALL
  // around a low TARGET fill (~90ms) and actively RESYNC — if it overfills past
  // the cap (~260ms) snap back to target (drop the excess), if it underflows
  // output silence. Latency then stays low and roughly constant instead of
  // creeping. The occasional resync skip is a few ms, inaudible under motion.
  const targetFrames = Math.max(1, Math.round(sampleRate * 0.09));
  const capacityFrames = Math.max(targetFrames + 1, Math.ceil(sampleRate * 0.26));
  const ring: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(capacityFrames),
  );
  let writeIdx = 0;
  let readIdx = 0;
  let available = 0;
  // A chunk may split a PCM frame (`channels * 2` bytes); carry the remainder to
  // the next chunk so the stream stays sample-aligned.
  let leftover = new Uint8Array(0);

  const pushPcm = (chunk: Uint8Array): void => {
    let data = chunk;
    if (leftover.length) {
      const merged = new Uint8Array(leftover.length + chunk.length);
      merged.set(leftover, 0);
      merged.set(chunk, leftover.length);
      data = merged;
    }
    const frameBytes = channels * 2;
    const frames = Math.floor(data.length / frameBytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 0;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        const chan = ring[c];
        if (chan) chan[writeIdx] = view.getInt16(o, true) / 32768;
        o += 2;
      }
      writeIdx = (writeIdx + 1) % capacityFrames;
      if (available < capacityFrames) available++;
      else readIdx = (readIdx + 1) % capacityFrames; // hard cap → drop oldest
    }
    // Drift RESYNC: if the producer has out-run the consumer past the cap, snap
    // the read cursor forward so only `targetFrames` remain buffered — this keeps
    // playout latency pinned near the target instead of letting it grow toward
    // the cap and stay there. (A pure drop-on-overflow keeps latency AT the cap.)
    if (available > capacityFrames - 1) {
      const drop = available - targetFrames;
      readIdx = (readIdx + drop) % capacityFrames;
      available = targetFrames;
    }
    const consumed = frames * frameBytes;
    leftover = consumed < data.length ? data.slice(consumed) : new Uint8Array(0);
  };

  const node = ctx.createScriptProcessor(2048, 0, channels);
  node.onaudioprocess = (e: AudioProcessingEvent): void => {
    const out = e.outputBuffer;
    const chans: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chans.push(out.getChannelData(c));
    for (let i = 0; i < out.length; i++) {
      if (available > 0) {
        for (let c = 0; c < channels; c++) {
          const dst = chans[c];
          const src = ring[c];
          if (dst && src) dst[i] = src[readIdx] ?? 0;
        }
        readIdx = (readIdx + 1) % capacityFrames;
        available--;
      } else {
        for (let c = 0; c < channels; c++) {
          const dst = chans[c];
          if (dst) dst[i] = 0;
        }
      }
    }
  };
  node.connect(dest);

  let bytesReceived = 0;
  const unsubData = bridge.onData((payload) => {
    if (payload.captureId !== captureId) return;
    bytesReceived += payload.chunk.byteLength;
    pushPcm(payload.chunk);
  });

  let stopped = false;
  let helperEnded = false;
  let watch: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (watch !== null) clearInterval(watch);
    unsubData();
    unsubEnded();
    try {
      node.disconnect();
    } catch {
      // graph already torn down
    }
    for (const t of dest.stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
    void bridge.stop(captureId).catch(() => undefined);
  };
  // The helper exiting on its own (target process closed) ends the capture.
  const unsubEnded = bridge.onEnded((ev) => {
    if (ev.captureId !== captureId) return;
    helperEnded = true;
    stop();
  });

  const track = dest.stream.getAudioTracks()[0] ?? null;
  if (!track) {
    stop();
    return null;
  }
  // When the engine stops our track (share ended) its readyState flips to
  // "ended" — tear the helper down. (Calling stop() locally does not fire the
  // "ended" event, so we poll instead of listening.)
  watch = setInterval(() => {
    if (track.readyState === "ended") stop();
  }, 1000);

  // Startup grace: the ONLY fatal outcome is the helper dying (bad PID, target
  // closed, activation refused). Zero bytes is NOT fatal — see the doc above.
  if (graceMs > 0) {
    await new Promise((r) => setTimeout(r, graceMs));
    if (helperEnded || track.readyState === "ended") {
      stop();
      return null;
    }
  }
  return {
    track,
    stop,
    bytesReceived: () => bytesReceived,
    ended: () => helperEnded,
  };
}

/**
 * Acquire the screen/window VIDEO track only (arms the source video-only).
 * Throws on a real failure (denied / source closed); any stray audio track is
 * dropped. Used by the process- and mix-input paths, where the film audio comes
 * from a SEPARATE source, not the display-media stream.
 */
async function acquireVideoOnly(
  capture: ReturnType<typeof requireCapture>,
  sourceId: string,
  quality: ScreenShareQuality,
): Promise<MediaStreamTrack> {
  await capture.selectSource({ sourceId, audio: false });
  const stream = await getDisplayMedia(false, quality);
  const video = stream.getVideoTracks()[0] ?? null;
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("Screen capture produced no video track.");
  }
  for (const t of stream.getAudioTracks()) t.stop();
  return video;
}

/** Bind a process capture's teardown to the share's video and report film audio. */
function withProcessAudio(
  video: MediaStreamTrack,
  pc: ProcessAudioCapture,
): AcquiredScreenShare {
  video.addEventListener("ended", () => pc.stop(), { once: true });
  return { video, audio: pc.track, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: "process" };
}

/**
 * FAST PATH: use the remembered winning film-audio source DIRECTLY, with no
 * probing, so the share starts instantly. Returns null when there is no memory
 * or the remembered source no longer yields audio (→ caller does a full scan).
 * The video is acquired in parallel with the audio wherever they don't share the
 * single-shot getDisplayMedia handshake.
 */
async function tryRememberedFilmAudio(
  capture: ReturnType<typeof requireCapture>,
  sourceId: string,
  options: ScreenShareStartOptions,
  memory: FilmAudioMemory | null,
): Promise<AcquiredScreenShare | null> {
  if (!memory) return null;

  if (memory.kind === "process") {
    if (!isWindowSource(sourceId) || !isProcessAudioSupported()) return null;
    // Process capture (exe) and video (getDisplayMedia) don't conflict — run
    // both at once. graceMs = 0 → return the track the instant the pipe opens.
    const [pc, videoResult] = await Promise.all([
      captureProcessAudioTrack(sourceId, 0),
      acquireVideoOnly(capture, sourceId, options.quality)
        .then((v) => ({ ok: true as const, v }))
        .catch((e: unknown) => ({ ok: false as const, e })),
    ]);
    if (!videoResult.ok) {
      pc?.stop();
      throw videoResult.e;
    }
    if (!pc) {
      videoResult.v.stop();
      return null; // remembered process capture failed → full scan
    }
    return withProcessAudio(videoResult.v, pc);
  }

  if (memory.kind === "mixinput") {
    // Mix input (getUserMedia) and video (getDisplayMedia) don't conflict either.
    const [track, videoResult] = await Promise.all([
      captureMixInputByLabel(memory.label),
      acquireVideoOnly(capture, sourceId, options.quality)
        .then((v) => ({ ok: true as const, v }))
        .catch((e: unknown) => ({ ok: false as const, e })),
    ]);
    if (!videoResult.ok) {
      track?.stop();
      throw videoResult.e;
    }
    if (!track) {
      videoResult.v.stop();
      return null; // remembered device gone → full scan
    }
    return { video: videoResult.v, audio: track, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: `mixinput:${memory.label}` };
  }

  // Loopback: video + loopback come from ONE combined getDisplayMedia call.
  await warmUpLoopback(capture);
  const selection = await capture.selectSource({ sourceId, audio: true });
  if (selection.audio !== "loopback") {
    await capture.clearSelection().catch(() => undefined);
    return null;
  }
  let stream: MediaStream;
  try {
    stream = await getDisplayMedia(true, options.quality);
  } catch {
    await capture.clearSelection().catch(() => undefined);
    return null;
  }
  const video = stream.getVideoTracks()[0] ?? null;
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    return null;
  }
  let audio = stream.getAudioTracks()[0] ?? null;
  if (audio && audio.readyState === "ended") {
    audio.stop();
    audio = null;
  }
  if (!audio) {
    // Remembered loopback no longer yields a track — heal and go video-only; the
    // next share re-scans. (We already spent the video; keep it.)
    clearFilmAudioMemory();
    return { video, audio: null, hasSystemAudio: false, systemAudioUnavailable: true, filmAudioSource: null };
  }
  return { video, audio, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: "loopback" };
}

/**
 * ENDPOINT SCAN (process capture unavailable or genuinely dead): choose the film
 * audio between the endpoint loopback and a system-mix input.
 *
 * The per-process tier is deliberately NOT retried here — {@link acquireScreenShare}
 * always attempts it first, and repeating it spawned the helper TWICE per share
 * (visible as duplicate `start` lines ~40ms apart in the founder's
 * process-audio.log) and doubled the startup delay for nothing.
 *
 * The loopback signal-probe and the mix-input scan run CONCURRENTLY (~1.2s each,
 * so they overlap instead of adding up).
 */
async function scanFilmAudio(
  capture: ReturnType<typeof requireCapture>,
  sourceId: string,
  options: ScreenShareStartOptions,
): Promise<AcquiredScreenShare> {
  // Loopback then mix input. Video + loopback come from one
  // combined call; warm the pipeline first (first WASAPI loopback is silent).
  await warmUpLoopback(capture);
  const selection = await capture.selectSource({ sourceId, audio: true });
  const attemptLoopback = selection.audio === "loopback";

  let stream: MediaStream;
  try {
    stream = await getDisplayMedia(attemptLoopback, options.quality);
  } catch (firstErr) {
    if (!attemptLoopback) {
      await capture.clearSelection().catch(() => undefined);
      throw firstErr;
    }
    // Some drivers fail the WHOLE request rather than just dropping audio.
    await capture.selectSource({ sourceId, audio: false });
    try {
      stream = await getDisplayMedia(false, options.quality);
    } catch (secondErr) {
      await capture.clearSelection().catch(() => undefined);
      throw secondErr;
    }
  }

  const video = stream.getVideoTracks()[0] ?? null;
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("Screen capture produced no video track.");
  }

  let loopback = stream.getAudioTracks()[0] ?? null;
  if (!loopback) {
    // Combined request refused audio — pull loopback from a screen-armed capture.
    loopback = await captureLoopbackAudioViaScreen(capture, options.quality);
  }
  if (loopback && loopback.readyState === "ended") {
    loopback.stop();
    loopback = null;
  }

  // Probe the loopback for signal AND scan the mix inputs concurrently.
  const [loopbackHasSignal, mix] = await Promise.all([
    loopback ? probeAudioSignal(loopback, 1200) : Promise.resolve(false),
    captureSystemMixInput(),
  ]);

  // Priority 2: loopback carrying signal.
  if (loopback && loopbackHasSignal) {
    if (mix) mix.track.stop();
    return { video, audio: loopback, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: "loopback" };
  }
  // Priority 3: a system-mix input carrying signal.
  if (mix) {
    if (loopback) loopback.stop();
    return { video, audio: mix.track, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: `mixinput:${mix.label}` };
  }
  // Neither carried signal. Keep a live (silent) loopback — it may just be
  // "nothing playing yet"; the 4s guardian warns. Nothing to remember.
  if (loopback) {
    return { video, audio: loopback, hasSystemAudio: true, systemAudioUnavailable: false, filmAudioSource: "loopback" };
  }
  return { video, audio: null, hasSystemAudio: false, systemAudioUnavailable: true, filmAudioSource: null };
}

/**
 * WEB screen-share acquisition (browser). The browser owns the source picker and,
 * on Chromium, can capture the shared TAB's or the whole SYSTEM's audio right on
 * the `getDisplayMedia` stream when the request asks for `audio: true` and the user
 * ticks "Share tab/system audio". That is the ONLY film-audio route on web (no
 * WASAPI loopback, no per-process capture), so we take both tracks straight from
 * the single display-media call — one native picker, no probing ladder.
 *
 * Graceful degradation (Firefox/Safari don't offer display audio; the user may
 * leave the box unchecked; a WINDOW surface carries no audio): the request simply
 * returns no audio track → the share goes out video-only and the sharer sees the
 * same "viewers hear nothing" warning as the desktop loopback-miss case (§26/§35).
 */
/**
 * The WEB build's `getDisplayMedia` request. Differs from the desktop helper in
 * two audio-only ways (video constraints stay identical to the shared profile):
 *
 *  - The audio request carries explicit DSP-off constraints. This is FILM sound,
 *    not speech — echo cancellation / noise suppression / AGC would duck and
 *    garble music (the same reasoning as `SCREEN_SHARE_AUDIO_PUBLISH` on the
 *    publish side). Desktop must NOT get these: its `audio` flag is only the
 *    loopback-arming signal for Electron's capture handler, which builds the
 *    WASAPI capture itself and ignores track constraints.
 *  - `systemAudio: "include"` asks Chromium to offer the "also share system
 *    audio" checkbox on whole-screen shares (Windows/ChromeOS). Non-Chromium
 *    engines ignore the unknown member per WebIDL, so this is a pure hint.
 */
function getWebDisplayMedia(
  wantAudio: boolean,
  quality: ScreenShareQuality,
): Promise<MediaStream> {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
  const request: DisplayMediaStreamOptions & { systemAudio?: "include" | "exclude" } = {
    video: {
      width: { max: profile.width },
      height: { max: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    },
    audio: wantAudio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false,
  };
  if (wantAudio) request.systemAudio = "include";
  return navigator.mediaDevices.getDisplayMedia(request);
}

async function acquireWebScreenShare(
  options: ScreenShareStartOptions,
): Promise<AcquiredScreenShare> {
  const wantAudio = options.systemAudio;
  const stream = await getWebDisplayMedia(wantAudio, options.quality);
  const video = stream.getVideoTracks()[0] ?? null;
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("Screen capture produced no video track.");
  }
  // Keep the display audio only when the user asked for it; drop any stray track
  // (and a dead one) so screenShareHasAudio stays honest.
  let audio = wantAudio ? (stream.getAudioTracks()[0] ?? null) : null;
  if (!wantAudio) {
    for (const a of stream.getAudioTracks()) a.stop();
  }
  if (audio && audio.readyState === "ended") {
    audio.stop();
    audio = null;
  }
  return {
    video,
    audio,
    hasSystemAudio: Boolean(audio),
    // Asked for system audio but the browser delivered none (box unchecked, window
    // surface, or an engine that doesn't support display audio) → video-only.
    systemAudioUnavailable: wantAudio && !audio,
    // "loopback" is the film-audio bucket the VoicePanel diagnostic already knows;
    // the browser's tab/system audio is exactly that, captured by the browser.
    filmAudioSource: audio ? "loopback" : null,
  };
}

export async function acquireScreenShare(
  sourceId: string,
  options: ScreenShareStartOptions,
): Promise<AcquiredScreenShare> {
  // WEB: the browser owns the picker AND the (tab/system) audio — take both from a
  // single getDisplayMedia call. Desktop's native loopback/process ladder below is
  // never reached on web (it has no browser analogue), and web never reaches it, so
  // neither path can regress the other.
  if (isWebPlatform()) {
    return acquireWebScreenShare(options);
  }

  const capture = requireCapture();

  // Video-only share (system audio off): nothing to probe.
  if (!options.systemAudio) {
    const video = await acquireVideoOnly(capture, sourceId, options.quality);
    return { video, audio: null, hasSystemAudio: false, systemAudioUnavailable: false, filmAudioSource: null };
  }

  // PRIORITY 1 ALWAYS WINS: per-process capture is strictly better than any
  // endpoint source (it bypasses the render device entirely) AND it is fast —
  // the helper spawns in milliseconds, so there is no speed reason to skip it.
  // It must therefore NOT be overridden by a remembered endpoint winner: a
  // stale `loopback` memory once pinned the founder's shares to a silent
  // endpoint and process capture was never even attempted again (P0). Memory
  // now only accelerates the ENDPOINT tiers below.
  const memory = loadFilmAudioMemory();
  if (isWindowSource(sourceId) && isProcessAudioSupported()) {
    const pc = await captureProcessAudioTrack(sourceId, memory?.kind === "process" ? 0 : 700);
    if (pc) {
      let video: MediaStreamTrack;
      try {
        video = await acquireVideoOnly(capture, sourceId, options.quality);
      } catch (err) {
        pc.stop();
        throw err;
      }
      return withProcessAudio(video, pc);
    }
  }

  // FAST PATH (endpoint tiers only): a remembered endpoint winner is used
  // directly (no probing) so the share still starts instantly when process
  // capture is unavailable (screen sources / non-Windows). The 4s silence
  // guardian self-heals a stale memory.
  const fast =
    memory && memory.kind !== "process"
      ? await tryRememberedFilmAudio(capture, sourceId, options, memory)
      : null;
  if (fast) return fast;

  // FULL SCAN: first share / memory miss / remembered source failed.
  return scanFilmAudio(capture, sourceId, options);
}

/**
 * Probe a live loopback audio track for REAL signal. A Windows WASAPI loopback
 * can come up "live" (readyState never ends) yet deliver only zero-filled
 * frames — classic when the source app holds the endpoint in EXCLUSIVE mode or
 * the driver refuses loopback taps. The 0.0.41 dead-track guard cannot see
 * this ("yayın sesi gitmiyor" with hasSystemAudio=true and no warning). We
 * sample the track via WebAudio for `ms`; ANY non-zero sample proves signal.
 * Zero-for-the-whole-window is reported as silent — the caller shows an
 * ADVISORY warning (it may legitimately mean "nothing is playing yet").
 */
export async function probeAudioSignal(track: MediaStreamTrack, ms: number): Promise<boolean> {
  const ctx = new AudioContext();
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const started = performance.now();
    while (performance.now() - started < ms) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (track.readyState === "ended") return false;
      analyser.getFloatTimeDomainData(buf);
      for (const sample of buf) {
        // Threshold sits ABOVE a typical endpoint noise floor. Measured on the
        // founder's Voicemeeter box: a SILENT loopback still carries ~0.003 peak,
        // while real film audio hits ~0.13. A 0.001 threshold mistook that noise
        // for signal → the ladder crowned a silent loopback the "winner" and
        // every later share went out silent (P0 regression). 0.02 separates
        // noise from any audible content, which a multi-second peak scan
        // reaches even in quiet passages.
        if (Math.abs(sample) > 0.02) return true;
      }
    }
    return false;
  } catch {
    // Probe failures must never affect the share — assume signal.
    return true;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// FILM-AUDIO SUPERVISOR — audibility is verified WHILE the share runs
// ---------------------------------------------------------------------------

/**
 * What the sharer is actually told about their film sound (§35 — the panel must
 * never claim viewers can hear something they cannot):
 *  - `searching`: a track is published but has not carried sound yet. This is the
 *    NORMAL state right after starting a share, because the user has not pressed
 *    play. Not an error.
 *  - `live`: real signal observed — the film IS reaching viewers.
 *  - `unavailable`: no film-audio track at all (loopback refused / user shared
 *    without system audio), so viewers definitely hear nothing.
 */
export type FilmAudioStatus = "searching" | "live" | "unavailable";

/** How long a silent published source is tolerated before we look elsewhere. */
const RESCAN_DELAY_MS = 8000;
/** How many times we go looking for a better source before giving up scanning. */
const MAX_RESCANS = 6;

/**
 * Watch a live track and invoke `onSignal` the first time it carries audible
 * sound. Returns a stop handle. Unlike {@link probeAudioSignal} this is
 * CONTINUOUS: the film may start minutes after the share does, and a one-shot
 * probe that happened to run during silence is exactly what made the old code
 * report a permanent failure for a share that was merely not playing yet.
 */
function watchForSignal(track: MediaStreamTrack, onSignal: () => void): () => void {
  let stopped = false;
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    void ctx?.close().catch(() => undefined);
    ctx = null;
  };

  try {
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      if (stopped) return;
      if (track.readyState === "ended") {
        stop();
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      for (const sample of buf) {
        // Same noise floor as probeAudioSignal: a SILENT endpoint on the
        // founder's Voicemeeter box still carries ~0.003 peak, real content ~0.13.
        if (Math.abs(sample) > 0.02) {
          stop();
          onSignal();
          return;
        }
      }
    }, 250);
  } catch {
    // A broken watcher must never break the share. Assume we cannot verify and
    // leave the status as-is rather than falsely reporting failure.
    stop();
  }
  return stop;
}

/** Params for {@link superviseFilmAudio}. */
export interface FilmAudioSupervisorParams {
  /** The film-audio track published with the share (null when there is none). */
  initialTrack: MediaStreamTrack | null;
  /** Which ladder tier produced {@link initialTrack}. */
  initialSource: AcquiredScreenShare["filmAudioSource"];
  /** Hot-swap the published film audio (engine.replaceScreenShareAudio). */
  replaceAudio: (track: MediaStreamTrack | null) => Promise<boolean>;
  /** Report status/source changes to the UI. */
  onUpdate: (update: {
    status: FilmAudioStatus;
    filmAudioSource: AcquiredScreenShare["filmAudioSource"];
  }) => void;
}

/**
 * Keep the share's film audio HONEST and SELF-CORRECTING for as long as it runs.
 *
 * Why this exists (the real fix for the recurring "yayın sesi gitmiyor"): the
 * source ladder can only ever be resolved at share START, but the near-universal
 * flow is "start sharing, THEN press play". At t=0 every candidate is silent, so
 * no ladder — however clever — can pick the right one. The old code resolved it
 * anyway against that silence, published whatever it had, claimed success, and
 * NEVER looked again. On a virtual-mixer box that froze a permanently-silent
 * Voicemeeter endpoint in place for the whole film.
 *
 * So: watch the published track. The instant it carries sound, report `live`.
 * While it stays silent, periodically look for a source that DOES carry sound
 * and hot-swap to it. A swap only ever happens toward a PROVEN-audible source,
 * so supervision can never make a working share worse.
 *
 * Returns a stop handle — the caller MUST call it when the share ends.
 */
export function superviseFilmAudio(params: FilmAudioSupervisorParams): () => void {
  const { replaceAudio, onUpdate } = params;
  let stopped = false;
  let current = params.initialTrack;
  let source = params.initialSource;
  let rescans = 0;
  let unwatch: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unwatch?.();
    unwatch = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  if (!current) {
    onUpdate({ status: "unavailable", filmAudioSource: null });
    return stop;
  }

  const goLive = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    onUpdate({ status: "live", filmAudioSource: source });
    // Remember the winner only once it has PROVEN itself audible. The old code
    // remembered a source the moment it was picked, which is how a silent
    // endpoint became the permanent fast-path choice.
    if (source === "process") saveFilmAudioMemory({ kind: "process" });
    else if (source === "loopback") saveFilmAudioMemory({ kind: "loopback" });
    else if (source?.startsWith("mixinput:")) {
      saveFilmAudioMemory({ kind: "mixinput", label: source.slice("mixinput:".length) });
    }
    stop();
  };

  const watch = (track: MediaStreamTrack): void => {
    unwatch?.();
    unwatch = watchForSignal(track, goLive);
  };

  /**
   * Look for a source that is audible RIGHT NOW and switch to it. Uses only the
   * system-mix INPUT devices (plain getUserMedia): unlike a loopback re-arm it
   * cannot disturb the live getDisplayMedia video, and on a virtual-mixer box
   * (the founder's) it is exactly the tier that carries the system mix.
   */
  const rescan = async (): Promise<void> => {
    if (stopped) return;
    rescans++;
    const mix = await captureSystemMixInput();
    if (stopped) {
      mix?.track.stop();
      return;
    }
    if (mix) {
      const swapped = await replaceAudio(mix.track);
      if (stopped) return;
      if (swapped) {
        current = mix.track;
        source = `mixinput:${mix.label}`;
        onUpdate({ status: "searching", filmAudioSource: source });
        watch(mix.track);
        // The new source was chosen BECAUSE it carries signal, so the watcher
        // confirms it almost immediately.
      } else {
        mix.track.stop();
      }
    }
    schedule();
  };

  const schedule = (): void => {
    if (stopped || rescans >= MAX_RESCANS) return;
    timer = setTimeout(() => {
      void rescan();
    }, RESCAN_DELAY_MS);
  };

  onUpdate({ status: "searching", filmAudioSource: source });
  watch(current);
  schedule();
  return stop;
}

/**
 * Build the engine's `acquire` callback for a source + share options. The
 * engine invokes it inside `startScreenShare` so acquisition failures map to
 * typed FSM errors. `onAudioReconciled` reports which tier won and whether a
 * film-audio track exists at all.
 *
 * NOTE: audibility is deliberately NOT judged here. Acquisition happens before
 * the user presses play, so any verdict taken at this moment is meaningless —
 * that is what {@link superviseFilmAudio} is for.
 */
export function makeScreenShareAcquire(
  sourceId: string,
  options: ScreenShareStartOptions,
  onAudioReconciled?: (info: {
    hasSystemAudio: boolean;
    systemAudioUnavailable: boolean;
    filmAudioSource: AcquiredScreenShare["filmAudioSource"];
  }) => void,
): () => Promise<ScreenShareAssets> {
  return async () => {
    const acquired = await acquireScreenShare(sourceId, options);
    onAudioReconciled?.({
      hasSystemAudio: acquired.hasSystemAudio,
      systemAudioUnavailable: acquired.systemAudioUnavailable,
      filmAudioSource: acquired.filmAudioSource,
    });
    console.warn(`[voice] film audio source: ${acquired.filmAudioSource ?? "none"}`);
    return { video: acquired.video, audio: acquired.audio };
  };
}
