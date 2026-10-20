/**
 * Screen-share ACQUISITION — the platform half of screen sharing.
 *
 * This is the platform seam kept OUT of `@demli/media` (the engine stays
 * platform-agnostic so mobile can reuse it). Here we drive the desktop capture
 * bridge (`window.demli.capture`) + `navigator.mediaDevices.getDisplayMedia`
 * to obtain a screen video track plus optional share audio, then hand the raw
 * tracks to `engine.startScreenShare(acquire)`, which owns the LiveKit publish
 * and FSM transitions. DM calls, server voice channels and group calls all
 * share through this one file, so their behaviour cannot drift.
 *
 * SHARE AUDIO — the one hard rule (M16 H1): the published share audio must
 * never contain Demli's own playback of the people in the call, or they hear
 * themselves. So the only desktop sources are the two process-loopback modes:
 *
 *   - "app":    the shared WINDOW's process tree only.
 *   - "system": every process EXCEPT Demli's own tree.
 *
 * Whole-device endpoint loopback and "system mix" recording inputs (Stereo Mix,
 * Voicemeeter Out, CABLE Output…) are gone for good: both carry Demli's own
 * playback, and a mix input can be the user's microphone bus. No path here
 * calls getUserMedia, so a microphone can never be published as share sound.
 * Where process capture is impossible (not Windows, Windows older than build
 * 19041, or Windows refused the capture), the share goes out without sound and
 * the sharer is told why — a share that echoes everyone's voice back is worse
 * than a silent one. An "app" capture that cannot be isolated is never widened
 * to "system" automatically: the sharer chose one app's sound, so everything
 * else on the PC goes out only when they ask for it ({@link captureSystemShareAudio}).
 *
 * On the WEB build the browser owns the picker and the sound: see
 * {@link acquireWebScreenShare}.
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

/**
 * What the sharer asked to send as share sound:
 *  - "none":   video only.
 *  - "app":    only the shared window's app (desktop: process include-tree).
 *  - "system": everything the PC plays except Demli (desktop: process
 *              exclude-tree). On web, "app"/"system" both mean "ask the
 *              browser for sound"; the surface picked decides what comes back.
 */
export type ShareAudioMode = "none" | "app" | "system";

/** The user's per-share choices, picked in the SourcePicker. */
export interface ScreenShareStartOptions {
  /** Quality preset — caps capture AND encoder (default "balanced"). */
  quality: ScreenShareQuality;
  audioMode: ShareAudioMode;
}

/** Which capture feeds the published share audio. */
export type ShareAudioSource =
  | "app"
  | "system"
  | "browser-tab"
  | "browser-window"
  | "browser-system";

/** A display surface as reported by `MediaTrackSettings.displaySurface`. */
export type WebDisplaySurface = "browser" | "window" | "monitor";

/**
 * Something the sharer must be told about the share's sound. Each value maps
 * to its own copy (desktop:shareAudio.notice.*).
 *
 * No sound is published:
 *  - `unsupported_os`:        Windows older than build 19041 (no process capture).
 *  - `unsupported_platform`:  a desktop OS without process capture (macOS/Linux).
 *  - `capture_failed`:        process capture could not start.
 *  - `app_unavailable`:       the shared window's own sound could not be isolated
 *    (its process could not be resolved, its tree contains Demli, or Windows
 *    refused the capture). The sharer may send the system sound instead.
 *  - `web_unsupported_browser`, `web_tab_unticked`, `web_monitor_unticked`,
 *    `web_window_no_audio`, `web_no_audio`: the browser returned no sound, and why.
 * Sound IS published, with a caveat:
 *  - `web_echo_risk`: browser system/window audio without own-audio filtering —
 *    people in the call may hear themselves.
 */
export type ShareAudioNotice =
  | "unsupported_os"
  | "unsupported_platform"
  | "capture_failed"
  | "app_unavailable"
  | "web_unsupported_browser"
  | "web_tab_unticked"
  | "web_monitor_unticked"
  | "web_window_no_audio"
  | "web_no_audio"
  | "web_echo_risk";

/** Result of a full acquisition. */
export interface AcquiredScreenShare {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  /** Which capture feeds {@link audio}; null when no audio is published. */
  audioSource: ShareAudioSource | null;
  /** What the sharer must be told about the sound, or null. */
  audioNotice: ShareAudioNotice | null;
  /** True when sound was asked for (`audioMode !== "none"`). */
  audioRequested: boolean;
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
 * True when running as the WEB build (browser), not Electron. The desktop
 * process-capture path has no browser analogue, so web screen sharing takes its
 * own path: the browser's picker offers its own "share audio" checkbox, and that
 * audio arrives on the same `getDisplayMedia` stream.
 */
export function isWebPlatform(): boolean {
  // The desktop `window.demli` global types `platform` as `NodeJS.Platform`
  // (the preload sets `process.platform`), but the WEB build reuses this exact
  // renderer with a shim that injects `platform: "web"` at runtime — a value the
  // compile-time type doesn't include. Compare as a widened string.
  const platform = window.demli?.appInfo?.platform as string | undefined;
  return typeof window !== "undefined" && platform === "web";
}

/**
 * True when the WEB build's browser can deliver display audio on the
 * `getDisplayMedia` stream. Only Chromium engines offer it (Chrome/Edge/Opera
 * show a "share audio" checkbox); Firefox and Safari always return video only.
 * There is no direct feature probe, so Chromium is detected via
 * `navigator.userAgentData` (Chromium-only, Chrome/Edge 90+).
 */
export function isWebDisplayAudioCapable(): boolean {
  return (
    isWebPlatform() &&
    typeof navigator !== "undefined" &&
    "userAgentData" in navigator &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * Tell main the local share is over, so this window loses its right to start
 * share-sound captures (main only records sound for a share the user started,
 * see process-audio-policy `processAudioStartAllowed`). Desktop only; a no-op on
 * the web build. Best-effort: a reload or crash releases it in main anyway.
 */
export function releaseShareCapture(): void {
  if (isWebPlatform() || !isScreenCaptureAvailable()) return;
  void window.demli.capture.clearSelection().catch(() => undefined);
}

function requireCapture(): CaptureBridge {
  if (!isScreenCaptureAvailable()) throw new ScreenShareUnavailableError();
  return window.demli.capture;
}

/** Enumerate capturable screens + windows for the in-app picker. */
export function listScreenSources(): Promise<CaptureSource[]> {
  return requireCapture().listSources();
}

/** True for `window:` sources — the only kind "app" sound applies to. */
export function isWindowSource(sourceId: string): boolean {
  return sourceId.startsWith("window:");
}

// ---------------------------------------------------------------------------
// Desktop share-audio capability
// ---------------------------------------------------------------------------

/** Can this desktop capture share sound by process, and if not, why not. */
export type ShareAudioCapability =
  | { supported: true }
  | { supported: false; notice: "unsupported_os" | "unsupported_platform" | "capture_failed" };

/**
 * Ask main whether process capture works on this machine (OS build + helper
 * present). The picker calls it before offering the sound options, so it never
 * offers a choice that cannot work.
 */
export async function getShareAudioCapability(): Promise<ShareAudioCapability> {
  if (isWebPlatform()) return { supported: false, notice: "unsupported_platform" };
  if (!isScreenCaptureAvailable() || !window.demli.processAudio) {
    return { supported: false, notice: "unsupported_platform" };
  }
  try {
    const support = await window.demli.processAudio.support();
    if (support.supported) return { supported: true };
    if (support.reason === "unsupported_os") return { supported: false, notice: "unsupported_os" };
    if (support.reason === "binary_missing") return { supported: false, notice: "capture_failed" };
    return { supported: false, notice: "unsupported_platform" };
  } catch {
    return { supported: false, notice: "capture_failed" };
  }
}

/**
 * The audio mode the picker actually starts a share with. When main has already
 * said this machine cannot capture share sound (macOS, old Windows, missing
 * helper) the picker shows that and starts WITHOUT sound — asking for sound
 * there only produced a false "viewers hear nothing" warning on a share whose
 * silence the sharer was already told about. Web (capability unknown, null) and
 * a still-loading capability keep the remembered choice.
 */
export function pickerStartAudioMode(
  capability: ShareAudioCapability | null,
  remembered: ShareAudioMode,
): ShareAudioMode {
  return capability !== null && !capability.supported ? "none" : remembered;
}

/** The audio mode a source starts with: a window shares its app, a screen the system. */
export function defaultShareAudioMode(sourceId: string): Exclude<ShareAudioMode, "none"> {
  return isWindowSource(sourceId) ? "app" : "system";
}

// ---------------------------------------------------------------------------
// Persisted share preferences
// ---------------------------------------------------------------------------

const QUALITY_STORAGE_KEY = "demli:screen-share:quality";
/** Per source kind, the sharer's last audio choice. */
const AUDIO_MODE_STORAGE_KEY = {
  window: "demli:screen-share:audio-mode:window",
  screen: "demli:screen-share:audio-mode:screen",
} as const;

/**
 * Storage left by builds before M16. `system-audio` was the single on/off
 * toggle; `film-audio-source` remembered the ladder winner and could hold
 * "loopback" or "mixinput:<device>" — sources that carry the call's own voices
 * (or the microphone bus). Both are migrated once and removed, so a poisoned
 * value can never steer a share again.
 */
const LEGACY_SYSTEM_AUDIO_KEY = "demli:screen-share:system-audio";
const LEGACY_FILM_AUDIO_SOURCE_KEY = "demli:screen-share:film-audio-source";

export type ShareSourceKind = keyof typeof AUDIO_MODE_STORAGE_KEY;

export interface ScreenSharePrefs {
  quality: ScreenShareQuality;
  audioMode: Record<ShareSourceKind, ShareAudioMode>;
}

function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * One-time migration of pre-M16 share storage. A user who had switched the old
 * sound toggle OFF keeps "no sound" for both source kinds; everything else
 * starts from the new per-kind defaults. Idempotent.
 */
export function migrateLegacyShareAudioStorage(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LEGACY_FILM_AUDIO_SOURCE_KEY);
    const legacy = store.getItem(LEGACY_SYSTEM_AUDIO_KEY);
    if (legacy !== null) {
      if (legacy === "false") {
        for (const key of Object.values(AUDIO_MODE_STORAGE_KEY)) {
          if (store.getItem(key) === null) store.setItem(key, "none");
        }
      }
      store.removeItem(LEGACY_SYSTEM_AUDIO_KEY);
    }
  } catch {
    // Storage unavailable — nothing to migrate.
  }
}

function parseAudioMode(raw: string | null, kind: ShareSourceKind): ShareAudioMode {
  if (raw === "none" || raw === "system") return raw;
  if (raw === "app" && kind === "window") return "app";
  return kind === "window" ? "app" : "system";
}

/** Load the remembered share choices (unknown/corrupt values fall back to defaults). */
export function loadScreenSharePrefs(): ScreenSharePrefs {
  migrateLegacyShareAudioStorage();
  const store = storage();
  let quality: ScreenShareQuality = DEFAULT_SCREEN_SHARE_QUALITY;
  const audioMode: Record<ShareSourceKind, ShareAudioMode> = { window: "app", screen: "system" };
  try {
    const storedQuality = store?.getItem(QUALITY_STORAGE_KEY) ?? null;
    if (isScreenShareQuality(storedQuality)) quality = storedQuality;
    audioMode.window = parseAudioMode(store?.getItem(AUDIO_MODE_STORAGE_KEY.window) ?? null, "window");
    audioMode.screen = parseAudioMode(store?.getItem(AUDIO_MODE_STORAGE_KEY.screen) ?? null, "screen");
  } catch {
    // Storage unavailable — use defaults.
  }
  return { quality, audioMode };
}

/** Persist the share choices for the next share. Best-effort. */
export function saveScreenSharePrefs(prefs: ScreenSharePrefs): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(QUALITY_STORAGE_KEY, prefs.quality);
    store.setItem(AUDIO_MODE_STORAGE_KEY.window, prefs.audioMode.window);
    store.setItem(AUDIO_MODE_STORAGE_KEY.screen, prefs.audioMode.screen);
  } catch {
    // Best-effort — a failed write only loses the remembered preference.
  }
}

/** Start options for a source from the remembered prefs. */
export function startOptionsFor(sourceId: string, prefs: ScreenSharePrefs): ScreenShareStartOptions {
  const kind: ShareSourceKind = isWindowSource(sourceId) ? "window" : "screen";
  return { quality: prefs.quality, audioMode: prefs.audioMode[kind] };
}

// ---------------------------------------------------------------------------
// Desktop acquisition
// ---------------------------------------------------------------------------

/**
 * getDisplayMedia constrained to the quality profile. The caps here must match
 * the engine's `screenShareEncoding` (same profile) so we never capture pixels
 * the encoder will throw away. Desktop always asks for video only: main serves
 * the armed source without any endpoint audio.
 */
function getDisplayMedia(quality: ScreenShareQuality): Promise<MediaStream> {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: profile.width },
      height: { max: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    },
    audio: false,
  });
}

/**
 * Acquire the screen/window VIDEO track. Throws on a real failure (denied /
 * source closed) so the engine maps it to a typed error; any stray audio track
 * is dropped.
 */
async function acquireVideo(
  capture: CaptureBridge,
  sourceId: string,
  quality: ScreenShareQuality,
): Promise<MediaStreamTrack> {
  await capture.selectSource({ sourceId });
  let stream: MediaStream;
  try {
    stream = await getDisplayMedia(quality);
  } catch (err) {
    await capture.clearSelection().catch(() => undefined);
    throw err;
  }
  const video = stream.getVideoTracks()[0] ?? null;
  for (const t of stream.getAudioTracks()) t.stop();
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("Screen capture produced no video track.");
  }
  return video;
}

/** The process-audio bridge surface exposed by the preload (typed via global). */
type ProcessAudioBridge = Window["demli"]["processAudio"];
type ProcessAudioStartRequest = Parameters<ProcessAudioBridge["start"]>[0];
type ProcessAudioStartResult = Awaited<ReturnType<ProcessAudioBridge["start"]>>;

/** A live process-loopback capture: the rebuilt track + a teardown handle. */
export interface ProcessAudioCapture {
  track: MediaStreamTrack;
  stop: () => void;
}

type ProcessCaptureOutcome =
  | { ok: true; capture: ProcessAudioCapture }
  | { ok: false; reason: Extract<ProcessAudioStartResult, { ok: false }>["reason"] | "bridge_error" };

/**
 * Start a process-loopback capture in main and rebuild a MediaStreamTrack from
 * its PCM stream. Main answers only after the helper reported `ready` (Windows
 * accepted the capture), so a refused capture comes back as `ok: false` here,
 * not as a silent track.
 *
 * A healthy capture can carry ZERO bytes for a while: the helper emits PCM only
 * while the captured tree is actually rendering sound, and the near-universal
 * flow is "start sharing, then press play". That is not a failure.
 *
 * NOTE: the PCM→track bridge uses a ScriptProcessorNode. It is deprecated but
 * needs no external worklet module, which the renderer's strict CSP
 * (`script-src 'self'`) would block as a blob: URL.
 */
async function captureProcessAudio(request: ProcessAudioStartRequest): Promise<ProcessCaptureOutcome> {
  const bridge: ProcessAudioBridge = window.demli.processAudio;

  let started: ProcessAudioStartResult;
  try {
    started = await bridge.start(request);
  } catch {
    return { ok: false, reason: "bridge_error" };
  }
  if (!started.ok) return { ok: false, reason: started.reason };
  const { captureId, format } = started;
  const { sampleRate, channels } = format;

  const ctx = new AudioContext({ sampleRate });
  // A user gesture (the "share" click) precedes this, so resume() is allowed.
  await ctx.resume().catch(() => undefined);
  const dest = ctx.createMediaStreamDestination();

  // Stereo float ring buffer. Producer (helper WASAPI clock) and consumer
  // (AudioContext clock) drift apart over time; keep the buffer SMALL around a
  // low TARGET fill (~90ms) and RESYNC when it overfills past the cap (~260ms),
  // so the sound never slides progressively behind the picture.
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

  const unsubData = bridge.onData((payload) => {
    if (payload.captureId !== captureId) return;
    pushPcm(payload.chunk);
  });

  let stopped = false;
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
  // The helper exiting on its own (Windows ended the capture) ends the track;
  // the supervisor sees readyState "ended" and reports it.
  const unsubEnded = bridge.onEnded((ev) => {
    if (ev.captureId !== captureId) return;
    stop();
  });

  const track = dest.stream.getAudioTracks()[0] ?? null;
  if (!track) {
    stop();
    return { ok: false, reason: "bridge_error" };
  }
  // When the engine stops our track (share ended) its readyState flips to
  // "ended" — tear the helper down. (Calling stop() locally does not fire the
  // "ended" event, so we poll instead of listening.)
  watch = setInterval(() => {
    if (track.readyState === "ended") stop();
  }, 1000);
  return { ok: true, capture: { track, stop } };
}

/** Process-capture request for a share mode; null when the mode cannot apply. */
function processRequestFor(
  mode: Exclude<ShareAudioMode, "none">,
  sourceId: string,
): ProcessAudioStartRequest | null {
  if (mode === "system") return { mode: "system" };
  return isWindowSource(sourceId) ? { mode: "app", sourceId } : null;
}

/**
 * Get the share sound for `mode`. Exactly one capture is tried: "app" that
 * cannot be isolated (the window's process could not be resolved, its tree
 * contains Demli, Windows refused it) sends no sound and says so — it is never
 * widened to the whole system behind the sharer's back.
 */
async function acquireShareAudio(
  mode: Exclude<ShareAudioMode, "none">,
  sourceId: string,
): Promise<{
  capture: ProcessAudioCapture | null;
  source: ShareAudioSource | null;
  notice: ShareAudioNotice | null;
}> {
  const capability = await getShareAudioCapability();
  if (!capability.supported) return { capture: null, source: null, notice: capability.notice };

  const request = processRequestFor(mode, sourceId);
  if (!request) return { capture: null, source: null, notice: "app_unavailable" };
  const outcome = await captureProcessAudio(request);
  if (outcome.ok) return { capture: outcome.capture, source: request.mode, notice: null };
  return {
    capture: null,
    source: null,
    notice: request.mode === "app" ? "app_unavailable" : "capture_failed",
  };
}

/**
 * The system sound (Demli excluded) for a share that is already live — only
 * ever called on the sharer's explicit request, after "app" could not be
 * isolated. Null when the capture cannot start.
 */
export async function captureSystemShareAudio(): Promise<ProcessAudioCapture | null> {
  const capability = await getShareAudioCapability();
  if (!capability.supported) return null;
  const outcome = await captureProcessAudio({ mode: "system" });
  return outcome.ok ? outcome.capture : null;
}

export async function acquireScreenShare(
  sourceId: string,
  options: ScreenShareStartOptions,
): Promise<AcquiredScreenShare> {
  if (isWebPlatform()) {
    return acquireWebScreenShare(sourceId, options);
  }

  const capture = requireCapture();
  const mode = options.audioMode;

  if (mode === "none") {
    const video = await acquireVideo(capture, sourceId, options.quality);
    return { video, audio: null, audioSource: null, audioNotice: null, audioRequested: false };
  }

  // Video (getDisplayMedia) and the process helper do not share anything, so
  // both start at once.
  const [videoResult, sound] = await Promise.all([
    acquireVideo(capture, sourceId, options.quality)
      .then((v) => ({ ok: true as const, v }))
      .catch((e: unknown) => ({ ok: false as const, e })),
    acquireShareAudio(mode, sourceId),
  ]);
  if (!videoResult.ok) {
    sound.capture?.stop();
    throw videoResult.e;
  }
  const video = videoResult.v;
  if (sound.capture) {
    const pc = sound.capture;
    video.addEventListener("ended", () => pc.stop(), { once: true });
  }
  return {
    video,
    audio: sound.capture?.track ?? null,
    audioSource: sound.source,
    audioNotice: sound.notice,
    audioRequested: true,
  };
}

// ---------------------------------------------------------------------------
// Web acquisition
// ---------------------------------------------------------------------------

/** Synthetic web source ids carry the surface the browser picker should open on. */
export function webPreferredSurface(sourceId: string): WebDisplaySurface {
  const match = /^web:display:(browser|window|monitor)$/.exec(sourceId);
  return (match?.[1] as WebDisplaySurface | undefined) ?? "browser";
}

/**
 * The WEB build's `getDisplayMedia` request.
 *
 *  - `video.displaySurface`: which pane the browser picker opens on. "browser"
 *    (a tab) is the default because a tab is the one surface whose sound every
 *    Chromium browser shares, with the box ticked by default.
 *  - `selfBrowserSurface: "exclude"`: Demli's own tab is not offered — sharing it
 *    would send the call's voices straight back.
 *  - `surfaceSwitching: "include"`: the user may switch tabs mid-share.
 *  - Audio: DSP off (this is film sound, not speech), `restrictOwnAudio: true`
 *    so system/window audio leaves out what THIS page plays (the call's
 *    voices; Chrome 141+), `suppressLocalAudioPlayback: false` so a shared tab
 *    keeps playing locally, and the `systemAudio` / `windowAudio` hints so the
 *    browser offers sound on screen and window panes where it can.
 *  Unknown members are ignored by browsers that do not implement them.
 */
export function webDisplayMediaRequest(
  wantAudio: boolean,
  quality: ScreenShareQuality,
  preferredSurface: WebDisplaySurface,
): DisplayMediaStreamOptions & Record<string, unknown> {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[quality];
  const request: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: {
      width: { max: profile.width },
      height: { max: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
      displaySurface: preferredSurface,
    } as MediaTrackConstraints,
    audio: wantAudio
      ? ({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
          restrictOwnAudio: true,
        } as MediaTrackConstraints)
      : false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  };
  if (wantAudio) {
    request.systemAudio = "include";
    request.windowAudio = "window";
  }
  return request;
}

/**
 * What to tell the sharer after a web capture, from what the browser actually
 * returned. Pure — the per-surface guidance table lives here.
 */
export function webShareAudioOutcome(input: {
  wantAudio: boolean;
  audioCapable: boolean;
  surface: WebDisplaySurface | null;
  hasAudio: boolean;
  restrictOwnAudioApplied: boolean;
}): { source: ShareAudioSource | null; notice: ShareAudioNotice | null } {
  const { wantAudio, audioCapable, surface, hasAudio, restrictOwnAudioApplied } = input;
  if (!wantAudio) return { source: null, notice: null };
  if (hasAudio) {
    if (surface === "browser") return { source: "browser-tab", notice: null };
    const source: ShareAudioSource = surface === "window" ? "browser-window" : "browser-system";
    return { source, notice: restrictOwnAudioApplied ? null : "web_echo_risk" };
  }
  if (!audioCapable) return { source: null, notice: "web_unsupported_browser" };
  if (surface === "window") return { source: null, notice: "web_window_no_audio" };
  if (surface === "monitor") return { source: null, notice: "web_monitor_unticked" };
  if (surface === "browser") return { source: null, notice: "web_tab_unticked" };
  return { source: null, notice: "web_no_audio" };
}

function readDisplaySurface(video: MediaStreamTrack): WebDisplaySurface | null {
  try {
    const surface = (video.getSettings() as MediaTrackSettings & { displaySurface?: string })
      .displaySurface;
    return surface === "browser" || surface === "window" || surface === "monitor" ? surface : null;
  } catch {
    return null;
  }
}

function readRestrictOwnAudio(audio: MediaStreamTrack): boolean {
  try {
    return (audio.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean })
      .restrictOwnAudio === true;
  } catch {
    return false;
  }
}

/**
 * WEB screen-share acquisition (browser). The browser owns the source picker
 * and the sound; both come from one `getDisplayMedia` call. After capture we
 * read which surface was actually picked and whether sound came back, so the
 * sharer gets guidance for THAT surface instead of a generic warning.
 */
async function acquireWebScreenShare(
  sourceId: string,
  options: ScreenShareStartOptions,
): Promise<AcquiredScreenShare> {
  const wantAudio = options.audioMode !== "none";
  const stream = await navigator.mediaDevices.getDisplayMedia(
    webDisplayMediaRequest(wantAudio, options.quality, webPreferredSurface(sourceId)),
  );
  const video = stream.getVideoTracks()[0] ?? null;
  if (!video) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("Screen capture produced no video track.");
  }
  let audio = wantAudio ? (stream.getAudioTracks()[0] ?? null) : null;
  if (!wantAudio) {
    for (const a of stream.getAudioTracks()) a.stop();
  }
  if (audio && audio.readyState === "ended") {
    audio.stop();
    audio = null;
  }
  const outcome = webShareAudioOutcome({
    wantAudio,
    audioCapable: isWebDisplayAudioCapable(),
    surface: readDisplaySurface(video),
    hasAudio: audio !== null,
    restrictOwnAudioApplied: audio ? readRestrictOwnAudio(audio) : false,
  });
  return {
    video,
    audio,
    audioSource: outcome.source,
    audioNotice: outcome.notice,
    audioRequested: wantAudio,
  };
}

// ---------------------------------------------------------------------------
// SHARE-AUDIO SUPERVISOR — watch-only
// ---------------------------------------------------------------------------

/**
 * What the sharer is told about the share sound (§35 — never claim viewers hear
 * something they cannot):
 *  - `unavailable`: no share-audio track is published.
 *  - `waiting`:     a track is published but has not carried sound yet — the
 *                   NORMAL state right after starting, before play is pressed.
 *  - `live`:        real signal measured — viewers are hearing it.
 *  - `failed`:      the capture ended mid-share; viewers hear nothing now.
 */
export type FilmAudioStatus = "unavailable" | "waiting" | "live" | "failed";

/** Peak above which a sample counts as sound (a silent capture idles at ~0.003). */
const SIGNAL_THRESHOLD = 0.02;
const WATCH_INTERVAL_MS = 250;
const LIVENESS_INTERVAL_MS = 1000;

/** Params for {@link superviseFilmAudio}. */
export interface FilmAudioSupervisorParams {
  /** The share-audio track published with the share (null when there is none). */
  track: MediaStreamTrack | null;
  /** Report status changes to the UI. */
  onStatus: (status: FilmAudioStatus) => void;
}

/**
 * Watch the published share audio for as long as the share runs and REPORT
 * what is happening — waiting for sound, live, or failed. It never changes the
 * published source: the source the sharer chose is the only correct one, and
 * a silent stretch just means nothing is playing yet. (Earlier builds swapped a
 * silent source for any "system mix" input with signal; that input carried the
 * call's own voices and could be the microphone bus — M16 H1/H3.)
 *
 * Returns a stop handle — the caller MUST call it when the share ends.
 */
export function superviseFilmAudio(params: FilmAudioSupervisorParams): () => void {
  const { track, onStatus } = params;
  let stopped = false;
  let ctx: AudioContext | null = null;
  let signalTimer: ReturnType<typeof setInterval> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let status: FilmAudioStatus | null = null;

  const report = (next: FilmAudioStatus): void => {
    if (stopped || status === next) return;
    status = next;
    onStatus(next);
  };

  const stopSignalWatch = (): void => {
    if (signalTimer !== null) clearInterval(signalTimer);
    signalTimer = null;
    void ctx?.close().catch(() => undefined);
    ctx = null;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stopSignalWatch();
    if (livenessTimer !== null) clearInterval(livenessTimer);
    livenessTimer = null;
  };

  if (!track) {
    report("unavailable");
    return stop;
  }

  report("waiting");

  livenessTimer = setInterval(() => {
    if (track.readyState === "ended") {
      stopSignalWatch();
      report("failed");
      if (livenessTimer !== null) clearInterval(livenessTimer);
      livenessTimer = null;
    }
  }, LIVENESS_INTERVAL_MS);

  try {
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    signalTimer = setInterval(() => {
      if (stopped || track.readyState === "ended") return;
      analyser.getFloatTimeDomainData(buf);
      for (const sample of buf) {
        if (Math.abs(sample) > SIGNAL_THRESHOLD) {
          stopSignalWatch();
          report("live");
          return;
        }
      }
    }, WATCH_INTERVAL_MS);
  } catch {
    // A broken watcher must never break the share; liveness is still watched.
    stopSignalWatch();
  }
  return stop;
}

// ---------------------------------------------------------------------------
// Engine acquire callback
// ---------------------------------------------------------------------------

/** What the acquisition decided about the share sound, reported to the store. */
export interface ShareAudioAcquisition {
  audioSource: ShareAudioSource | null;
  audioNotice: ShareAudioNotice | null;
  audioRequested: boolean;
}

/**
 * Build the engine's `acquire` callback for a source + share options. The
 * engine invokes it inside `startScreenShare` so acquisition failures map to
 * typed FSM errors. `onAcquired` reports the share-sound decision; audibility
 * is the supervisor's job, because acquisition happens before play is pressed.
 */
export function makeScreenShareAcquire(
  sourceId: string,
  options: ScreenShareStartOptions,
  onAcquired?: (info: ShareAudioAcquisition, video: MediaStreamTrack) => void,
): () => Promise<ScreenShareAssets> {
  return async () => {
    const acquired = await acquireScreenShare(sourceId, options);
    onAcquired?.(
      {
        audioSource: acquired.audioSource,
        audioNotice: acquired.audioNotice,
        audioRequested: acquired.audioRequested,
      },
      acquired.video,
    );
    console.warn(
      `[voice] share audio: mode=${options.audioMode} source=${acquired.audioSource ?? "none"}` +
        (acquired.audioNotice ? ` notice=${acquired.audioNotice}` : ""),
    );
    return { video: acquired.video, audio: acquired.audio };
  };
}
