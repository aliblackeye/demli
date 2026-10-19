/**
 * Web-only livekit-client room factory. Reachable ONLY through the
 * `@demli/media/web` entry — never the package root — so importing
 * `@demli/media` from React Native never pulls livekit-client into the
 * bundle. The SDK itself is imported lazily so this file loads in Node too.
 */

import type {
  AudioCaptureOptions,
  AudioPreset,
  AudioProcessorOptions,
  DisconnectReason,
  RoomEvent,
  Track,
  TrackProcessor,
  TrackPublishOptions,
  VideoCaptureOptions,
  VideoCodec,
  VideoEncoding,
  VideoPreset,
} from "livekit-client";
import type {
  AudioCaptureOptionsLike,
  AudioPresetLike,
  AudioTrackProcessorLike,
  ConnectionQualityProbe,
  LocalAudioMeter,
  MicPublishOptionsLike,
  RoomEventName,
  SeededRemoteVideoTrack,
  SimulcastLayerLike,
  VideoCaptureOptionsLike,
  VideoEncodingLike,
  VideoPublishOptionsLike,
  VoiceRoomAdapter,
} from "./room-adapter.js";
import { DISCONNECT_REASON, type TRACK_SOURCE } from "./room-adapter.js";
import { AUDIO_CAPTURE_SAMPLE_RATE } from "./audio-settings.js";
import { connectionQualityLevelFromLiveKit } from "./state.js";

/**
 * Compile-time pin: every ROOM_EVENT value must be a real livekit-client
 * `RoomEvent` value. Type-only import — no SDK code is loaded by this check.
 * Lives here (the web entry) so room-adapter.ts stays livekit-free.
 */
type LiveKitEventName = `${RoomEvent}`;
type _AssertEventsExist = RoomEventName extends LiveKitEventName ? true : never;
const _eventNamesArePinned: _AssertEventsExist = true;
void _eventNamesArePinned;

/**
 * Compile-time pin: every TRACK_SOURCE value (Microphone/Camera/ScreenShare/
 * ScreenShareAudio) must be a real livekit `Track.Source` value — so the camera
 * source (task #18) can never silently drift from the SDK. Type-only.
 */
type LiveKitTrackSource = `${Track.Source}`;
type TrackSourceName = (typeof TRACK_SOURCE)[keyof typeof TRACK_SOURCE];
type _AssertTrackSourcesExist = TrackSourceName extends LiveKitTrackSource ? true : never;
const _trackSourcesArePinned: _AssertTrackSourcesExist = true;
void _trackSourcesArePinned;

/**
 * The primary codec for ALL published video (camera + screen share), set once on the
 * Room's `publishDefaults`. Typed as livekit's `VideoCodec` so a typo (or an SDK enum
 * change) is a compile error, not a silent VP8 fallback. `'vp9'` is the modern-target
 * choice; a legacy subscriber falls back to VP8 via `publishDefaults.backupCodec` (see
 * the Room construction). One-line revert lever if a surface ever misbehaves.
 */
const VIDEO_CODEC: VideoCodec = "vp9";

/**
 * Compile-time pins for the M8 encoding shapes: every value the engine builds
 * for `screenShareEncoding` / `audioPreset` must be a valid livekit
 * `VideoEncoding` / `AudioPreset`. Type-only — no SDK code is loaded.
 */
type _AssertVideoEncodingIsValid = VideoEncodingLike extends VideoEncoding ? true : never;
const _videoEncodingIsPinned: _AssertVideoEncodingIsValid = true;
void _videoEncodingIsPinned;
type _AssertAudioPresetIsValid = AudioPresetLike extends AudioPreset ? true : never;
const _audioPresetIsPinned: _AssertAudioPresetIsValid = true;
void _audioPresetIsPinned;
// The mic PUBLISH options (bitrate + Opus RED/DTX/stereo) and the camera PUBLISH
// options (explicit videoEncoding) the engine builds must be valid livekit
// `TrackPublishOptions`. If the SDK renames dtx/red/forceStereo/videoEncoding one
// of these stops compiling. Type-only — no SDK code is loaded.
type _AssertMicPublishIsValid = MicPublishOptionsLike extends TrackPublishOptions ? true : never;
const _micPublishIsPinned: _AssertMicPublishIsValid = true;
void _micPublishIsPinned;
// `videoSimulcastLayers` is excluded from the direct extends-check because livekit
// types it as `VideoPreset[]` (a class whose instance type includes the `resolution`
// getter our plain `SimulcastLayerLike` deliberately omits). The layer shape is pinned
// separately below.
type _AssertVideoPublishIsValid = Omit<VideoPublishOptionsLike, "videoSimulcastLayers"> extends TrackPublishOptions
  ? true
  : never;
const _videoPublishIsPinned: _AssertVideoPublishIsValid = true;
void _videoPublishIsPinned;
// Pin the SIMULCAST LAYER shape the safe direction: every livekit `VideoPreset` must
// still satisfy our `SimulcastLayerLike` (width/height/encoding). We pass plain
// objects of this shape to `videoSimulcastLayers`; livekit reads exactly these fields
// off each layer (see `encodingsFromPresets`), so if the SDK renames width/height/
// encoding this assertion breaks — catching the drift a `VideoPreset[]` literal can't.
type _AssertSimulcastLayerIsValid = VideoPreset extends SimulcastLayerLike ? true : never;
const _simulcastLayerIsPinned: _AssertSimulcastLayerIsValid = true;
void _simulcastLayerIsPinned;

/**
 * Compile-time pins for the media-settings capture shapes: the mic audio-
 * processing constraints and the camera resolution/FPS the engine builds must be
 * valid livekit `AudioCaptureOptions` / `VideoCaptureOptions`. Type-only — no SDK
 * code is loaded by these checks.
 */
type _AssertAudioCaptureIsValid = AudioCaptureOptionsLike extends AudioCaptureOptions
  ? true
  : never;
const _audioCaptureIsPinned: _AssertAudioCaptureIsValid = true;
void _audioCaptureIsPinned;
// The noise-filter processor the engine attaches (the "Yüksek" NS tier's RNNoise
// worklet) must be a valid livekit audio `TrackProcessor`. If the SDK renames
// init/restart/destroy/processedTrack or reshapes AudioProcessorOptions, this stops
// compiling. Type-only — no SDK code is loaded.
type _AssertAudioProcessorIsValid = AudioTrackProcessorLike extends TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
>
  ? true
  : never;
const _audioProcessorIsPinned: _AssertAudioProcessorIsValid = true;
void _audioProcessorIsPinned;
type _AssertVideoCaptureIsValid = VideoCaptureOptionsLike extends VideoCaptureOptions
  ? true
  : never;
const _videoCaptureIsPinned: _AssertVideoCaptureIsValid = true;
void _videoCaptureIsPinned;

/**
 * Compile-time pin: the numeric DISCONNECT_REASON values the engine treats as a
 * clean single-session eviction MUST equal livekit's real `DisconnectReason` enum
 * members. If the SDK ever renumbers them, one of these annotations stops
 * compiling — far better than silently mis-classifying an eviction as a server
 * outage (or vice-versa). Type-only — no SDK code is loaded by this check.
 */
const _pinDuplicateIdentity: DisconnectReason.DUPLICATE_IDENTITY =
  DISCONNECT_REASON.DuplicateIdentity;
const _pinParticipantRemoved: DisconnectReason.PARTICIPANT_REMOVED =
  DISCONNECT_REASON.ParticipantRemoved;
void _pinDuplicateIdentity;
void _pinParticipantRemoved;

type MicDspFlags = Pick<
  AudioCaptureOptionsLike,
  "noiseSuppression" | "echoCancellation" | "autoGainControl"
>;

/**
 * True only when a capture track's `getSettings()` reports every requested DSP flag
 * with the requested value. A flag the track does not report at all counts as NOT
 * applied — without the readback there is no evidence the DSP changed.
 */
export function micDspSettingsMatch(
  settings: Partial<Record<keyof MicDspFlags, unknown>>,
  requested: MicDspFlags,
): boolean {
  return (Object.keys(requested) as (keyof MicDspFlags)[]).every((key) => {
    const want = requested[key];
    return typeof want !== "boolean" || settings[key] === want;
  });
}

export async function createLiveKitRoom(): Promise<VoiceRoomAdapter> {
  const { Room, RoomEvent, Track, VideoQuality, createAudioAnalyser } = await import(
    "livekit-client"
  );
  const room = new Room({
    // Scale received video to what the UI renders — but measured in PHYSICAL pixels.
    //
    // `pixelDensity: 'screen'` is load-bearing, not a tweak. adaptiveStream asks the
    // SFU for a layer sized by `element.clientWidth/Height`, which are CSS pixels.
    // Left unset, livekit multiplies those by 1 unless `devicePixelRatio > 2` — so on
    // every ordinary scaled display (Windows at 125/150%, a 4K panel at 200%, any
    // Retina Mac: ratios 1.25…2, none of them `> 2`) it asks for HALF the pixels the
    // tile actually occupies. The SFU then honestly serves a lower spatial layer and
    // the browser upscales it, which is the "camera looks soft in the grid" report.
    // Focusing a tile grew it past the threshold, so the picture sharpened — the exact
    // symptom pattern that pointed here.
    //
    // 'screen' asks for what the tile really is. This costs the PUBLISHER nothing: the
    // camera is VP9 SVC (`L3T3_KEY`, see publishDefaults), a SINGLE encode that always
    // contains all three spatial layers, so uplink is byte-for-byte unchanged — only
    // which layer each subscriber is forwarded moves, and only for tiles genuinely
    // large enough to need it. That is the whole point of the ladder existing.
    adaptiveStream: { pixelDensity: "screen" },
    // Let the SFU pause publishing layers nobody subscribes to.
    dynacast: true,
    publishDefaults: {
      // VP9 for ALL published video (camera + screen share). VP9 is ~30-50% more
      // efficient than libwebrtc's VP8 default, so at 2K the same uplink budget buys
      // a visibly sharper picture — or the same picture for a smaller, gentler stream
      // (which also eases the publisher-uplink bufferbloat behind the ping spikes).
      // Chromium (desktop Electron + web Chrome) and libwebrtc (react-native) decode
      // VP9 natively; VP9 also uses SVC (single encode, spatial+temporal layers) which
      // dynacast/adaptiveStream select per-subscriber — strictly better than the VP8
      // 3-layer simulcast it replaces for the primary stream.
      videoCodec: VIDEO_CODEC,
      // Legacy-decoder safety net: a subscriber that can't decode VP9 (Safari 12 — the
      // web target's floor — and any old client) gets an on-demand VP8 BACKUP stream
      // instead of a black tile. So "VP9 on the modern target, never a broken video on
      // an old one" (the founder's codec-fallback requirement). No cost until such a
      // subscriber actually appears.
      backupCodec: true,
    },
    // Note: publishDefaults.stopMicTrackOnMute stays at its default (false)
    // so mute keeps the track alive-but-silent for instant unmute.
  });

  // ── REMOTE AUDIO PLAYBACK (the P0 "masaüstü karşı tarafı duymuyor" fix) ──
  // livekit-client does NOT play remote audio by itself: `RemoteTrack.start()`
  // only enables the receiver, and playback happens exclusively through
  // elements the APP attaches (their React kit ships RoomAudioRenderer for
  // exactly this). React-native-webrtc DOES route subscribed audio natively,
  // which is why mobile listeners always heard everyone while a desktop
  // listener heard only local sound effects. Attach every subscribed remote
  // audio track (mic + screen-share film audio) to an SDK-managed <audio>
  // element; detach + drop the element when it unsubscribes. Volume, deafen
  // and output-device routing keep working unchanged: `participant.setVolume`
  // and `switchActiveDevice("audiooutput")` both act on attached elements.
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      try {
        track.attach();
      } catch {
        // Playback attach must never break the join path; blocked playback is
        // handled by the autoplay recovery below.
      }
      // A newly attached element can be the one the browser refuses to start.
      void recoverBlockedAudio();
    }
  });

  /**
   * AUTOPLAY RECOVERY (browser/web build).
   *
   * Chromium refuses to start audio playback until the document has a qualifying
   * user gesture. A listener who lands in a voice room without one gets
   * `canPlaybackAudio === false` and hears NOTHING — not voices, not the shared
   * film — with no error anywhere: the tracks subscribe fine and every state flag
   * says healthy. That is a silent failure of exactly the kind §35 forbids, and
   * until now nothing in the codebase listened for it (the old comment pointed at
   * "AudioPlaybackStatusChanged monitoring" that did not exist).
   *
   * Electron is unaffected (its renderer autoplays unconditionally), so this is a
   * no-op there — but the web build shares this engine.
   *
   * Recovery: ask livekit to start audio immediately; if the browser still
   * refuses, arm a ONE-SHOT listener on the next real user gesture and retry
   * then. Cheap, silent when unnecessary, and needs no UI.
   */
  let gestureListenerArmed = false;
  async function recoverBlockedAudio(): Promise<void> {
    if (room.canPlaybackAudio) return;
    try {
      await room.startAudio();
    } catch {
      // Still blocked — fall through to the gesture retry.
    }
    if (room.canPlaybackAudio || gestureListenerArmed) return;
    if (typeof document === "undefined") return;
    gestureListenerArmed = true;
    const retry = (): void => {
      void room.startAudio().catch(() => undefined);
      document.removeEventListener("pointerdown", retry);
      document.removeEventListener("keydown", retry);
      gestureListenerArmed = false;
    };
    document.addEventListener("pointerdown", retry, { once: true });
    document.addEventListener("keydown", retry, { once: true });
  }

  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    void recoverBlockedAudio();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      try {
        for (const el of track.detach()) el.remove();
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  /**
   * On-device meter for the LOCAL mic level (task #54). Resolves the current
   * mic track on every `level()` call and rebuilds its WebAudio analyser only
   * when the underlying MediaStreamTrack changes (mute keeps the track, so it
   * stays bound; device switch / reconnect swaps it, so it rebinds). Muting
   * zeroes the level naturally (alive-but-silent track), so we do NOT use
   * `cloneTrack` — a muted mic must read as silent, not as "trying to speak".
   */
  const createLocalAudioMeter = (): LocalAudioMeter => {
    let boundTrack: MediaStreamTrack | null = null;
    let analyser: { calculateVolume: () => number; cleanup: () => void } | null = null;
    const teardown = (): void => {
      if (analyser) {
        try {
          analyser.cleanup();
        } catch {
          // Best-effort — the audio context may already be closed.
        }
        analyser = null;
      }
      boundTrack = null;
    };
    return {
      level(): number {
        const track = room.localParticipant.getTrackPublication(
          Track.Source.Microphone,
        )?.audioTrack;
        const msTrack = track?.mediaStreamTrack ?? null;
        if (!track || !msTrack) {
          teardown();
          return 0;
        }
        if (msTrack !== boundTrack || !analyser) {
          if (analyser) {
            try {
              analyser.cleanup();
            } catch {
              // Best-effort — the previous context may already be closed.
            }
          }
          // The meter contract is "level() must not throw" — analyser creation
          // spins up an AudioContext, which can fail (context limits, teardown
          // races). Read as silence and retry on the next poll.
          try {
            const created = createAudioAnalyser(track, { cloneTrack: false });
            analyser = {
              calculateVolume: created.calculateVolume,
              cleanup: created.cleanup,
            };
            boundTrack = msTrack;
          } catch {
            analyser = null;
            boundTrack = null;
            return 0;
          }
        }
        const current = analyser;
        if (!current) return 0;
        try {
          return current.calculateVolume();
        } catch {
          return 0;
        }
      },
      close(): void {
        teardown();
      },
    };
  };

  /**
   * Probe for the local connection quality + RTT (task #55).
   *  - level: the LOCAL participant's server-computed `ConnectionQuality`
   *    (excellent/good/poor/lost/unknown), which folds packet loss, jitter AND
   *    RTT into one coarse bucket — a better bar signal than RTT alone.
   *  - rttMs: the ICE candidate-pair round-trip time from `getStats()`, falling
   *    back to livekit's signal-channel RTT only when WebRTC has not measured one
   *    yet (very early in a session, or on an adapter without a pcManager).
   *
   * WHY NOT `engine.client.rtt` AS THE PRIMARY (this used to be the only source).
   * That value is computed as `Date.now() - lastPingTimestamp` inside the signal
   * WebSocket's `pongResp` handler — BOTH timestamps are taken in main-thread JS.
   * Any renderer long task that lands between the ping going out and the pong
   * being handled is therefore added to the reported RTT 1:1, and the number the
   * ping indicator shows spikes even though the network never moved. Measured on a
   * real loopback socket with the pong held for a fixed 40 ms: idle reported a
   * clean 41 ms p95, while injecting 350 ms main-thread long tasks pushed the SAME
   * formula to 381 ms p95 / 385 ms max with the true RTT still 40 ms. That is the
   * "watch party → ping spikes" report: every viewer runs the film in a local
   * iframe, and the resulting renderer jank was being displayed as network latency.
   * It also fed the adaptive screen-share controller (`ADAPTIVE_RTT_POOR_MS`), so
   * jank could silently downgrade a stream that the link was carrying fine.
   *
   * `candidate-pair.currentRoundTripTime` is measured by libwebrtc's own network
   * thread from STUN binding request/response, so it is immune to main-thread
   * scheduling: a blocked renderer delays WHEN we read the value, never WHAT it
   * is. It also measures the MEDIA path, which is the one that matters for voice.
   *
   * Sampling is async but the probe contract is sync, so each `rttMs()` read kicks
   * off a refresh for the NEXT read and returns the last sample (the engine polls
   * at 1 Hz, so the value is at most one tick stale). Only one sample is ever in
   * flight. Neither read may throw, so both are wrapped defensively.
   */
  const createConnectionQualityProbe = (): ConnectionQualityProbe => {
    /** Last measured media-path RTT in ms; null until WebRTC reports one. */
    let mediaRttMs: number | null = null;
    /** Guards against piling up getStats() calls if one is slow. */
    let sampling = false;
    let closed = false;

    const sampleMediaRtt = async (): Promise<void> => {
      if (sampling || closed) return;
      sampling = true;
      try {
        // Prefer the PUBLISHER transport: it carries our uplink, so its queue is
        // the one that bloats when we over-send. Fall back to the subscriber when
        // the publisher has not connected (nothing published yet).
        const pcManager = room.engine?.pcManager;
        const transport = pcManager?.publisher ?? pcManager?.subscriber;
        const stats = await transport?.getStats();
        let next: number | null = null;
        stats?.forEach((report) => {
          const stat = report as RTCIceCandidatePairStats & { nominated?: boolean };
          if (
            stat.type === "candidate-pair" &&
            (stat.nominated === true || stat.state === "succeeded") &&
            typeof stat.currentRoundTripTime === "number"
          ) {
            next = Math.round(stat.currentRoundTripTime * 1000);
          }
        });
        if (!closed) mediaRttMs = next;
      } catch {
        // Best-effort: keep the previous sample rather than blanking the indicator.
      } finally {
        sampling = false;
      }
    };

    return {
      level() {
        try {
          return connectionQualityLevelFromLiveKit(room.localParticipant.connectionQuality);
        } catch {
          return "unknown";
        }
      },
      rttMs() {
        void sampleMediaRtt(); // refresh for the next tick; never awaited here
        if (mediaRttMs !== null && mediaRttMs > 0) return mediaRttMs;
        try {
          // Fallback only — see the jank caveat above. Better than showing nothing
          // before the first STUN round trip has been measured.
          const rtt = room.engine.client.rtt;
          return typeof rtt === "number" && rtt > 0 ? Math.round(rtt) : null;
        } catch {
          return null;
        }
      },
      close() {
        closed = true;
      },
    };
  };

  /**
   * Re-acquire the LIVE mic track with new capture constraints (audio-settings
   * change: music mode / a DSP toggle) so it applies without a rejoin. livekit's
   * `LocalAudioTrack.restartTrack` swaps the underlying getUserMedia track in
   * place, keeping the same publication (and its bitrate). No-op when the mic
   * isn't currently published.
   *
   * The CURRENT device is carried over. livekit fills a missing `deviceId` with
   * `{ ideal: "default" }`, so restarting with the DSP flags alone would silently
   * move a user who picked a specific microphone back to the system default.
   */
  const restartAudioTrack = async (
    captureOptions: AudioCaptureOptionsLike,
  ): Promise<void> => {
    const audioTrack = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    if (!audioTrack) return;
    const deviceId = audioTrack.constraints?.deviceId;
    await audioTrack.restartTrack(deviceId ? { ...captureOptions, deviceId } : captureOptions);
  };

  /**
   * Retune the LIVE mic capture's DSP constraints in place — see
   * `VoiceRoomAdapter.applyMicCaptureConstraints`. The ZERO-interruption path: no
   * re-acquire, no `replaceTrack`, no renegotiation, so listeners hear nothing at all.
   *
   * Two hard preconditions, both returning `false` rather than doing something wrong:
   *  - A PROCESSOR must not be attached. `LocalTrack.mediaStreamTrack` returns
   *    `processor.processedTrack ?? _mediaStreamTrack`, so with the RNNoise worklet
   *    live we would be applying mic constraints to the worklet's
   *    MediaStreamDestination output — silently meaningless. The engine always
   *    detaches the worklet BEFORE retuning constraints, so in practice this guard
   *    only catches ordering mistakes.
   *  - The track must still be live (a dead device can't be retuned).
   *
   * Only the three DSP booleans are sent. `sampleRate`/`channelCount` are structural
   * and are NOT passed here — the engine routes those to a re-acquire.
   *
   * A resolved promise is NOT proof. Measured on Electron 33.4.11 (Chromium
   * 130.0.6723.191), real Voicemeeter input and the fake device alike:
   * `applyConstraints({ echoCancellation: false, noiseSuppression: false,
   * autoGainControl: false })` RESOLVES while `getSettings()` still reports all three
   * true (and `{ exact: false }` rejects with OverconstrainedError); the reverse
   * direction behaves the same. A fresh getUserMedia with the new flags does report
   * them. So success is decided by reading `getSettings()` back: any requested flag
   * the track does not report means the DSP did not move, and the engine re-acquires.
   */
  const applyMicCaptureConstraints = async (
    captureOptions: AudioCaptureOptionsLike,
  ): Promise<boolean> => {
    const audioTrack = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    if (!audioTrack || audioTrack.getProcessor()) return false;
    const raw = audioTrack.mediaStreamTrack;
    if (!raw || raw.readyState !== "live") return false;
    const requested = {
      noiseSuppression: captureOptions.noiseSuppression,
      echoCancellation: captureOptions.echoCancellation,
      autoGainControl: captureOptions.autoGainControl,
    };
    try {
      await raw.applyConstraints(requested);
    } catch {
      // OverconstrainedError / unsupported constraint — let the engine take the
      // heavier re-acquire path rather than leaving the user on stale settings.
      return false;
    }
    return micDspSettingsMatch(raw.getSettings(), requested);
  };

  /**
   * Fully RE-PUBLISH the mic with new capture + PUBLISH options so an audio-quality
   * change (bitrate / RED-DTX / stereo) actually takes effect mid-call — the
   * bitrate/codec live on the publication, so `restartTrack` (which keeps the old
   * publication) can't move them. Unpublish+stop the current mic track, then
   * re-enable with the new options. No-op when the mic isn't published.
   *
   * This is the HEAVY path (full renegotiation, every listener re-subscribes). The
   * engine reserves it for changes that genuinely live on the publication — never
   * for a plain noise-suppression switch.
   */
  const republishMicTrack = async (
    captureOptions: AudioCaptureOptionsLike | undefined,
    publishOptions: MicPublishOptionsLike | undefined,
  ): Promise<void> => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (pub?.track) {
      await room.localParticipant.unpublishTrack(pub.track, true);
    }
    await room.localParticipant.setMicrophoneEnabled(true, captureOptions, publishOptions);
  };

  /**
   * A dedicated 48 kHz AudioContext for the RNNoise worklet. livekit needs an
   * AudioContext set on the LocalAudioTrack before a processor can run, and RNNoise's
   * model assumes 48 kHz (our capture is pinned to it too), so we own one here rather
   * than borrow livekit's (whose rate follows the hardware default). Lazily created +
   * resumed; reused across joins (one context, like livekit's own).
   */
  let noiseFilterContext: AudioContext | null = null;
  const getNoiseFilterContext = async (): Promise<AudioContext> => {
    if (!noiseFilterContext || noiseFilterContext.state === "closed") {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      noiseFilterContext = new Ctor({ sampleRate: AUDIO_CAPTURE_SAMPLE_RATE });
    }
    if (noiseFilterContext.state === "suspended") {
      try {
        await noiseFilterContext.resume();
      } catch {
        // A suspended context still lets setProcessor build the graph; it resumes on
        // the next user gesture. Best-effort.
      }
    }
    return noiseFilterContext;
  };

  /**
   * Attach (`processor`) or detach (`null`) the RNNoise worklet on the LIVE mic — the
   * "Yüksek" NS tier. Set the track's AudioContext FIRST (livekit throws
   * "Audio context needs to be set" otherwise — it builds the mic track before
   * assigning one), then `setProcessor`; `null` stops any current processor. No-op
   * when the mic isn't published. Best-effort — the engine leaves the built-in WebRTC
   * NS fallback in place if this rejects, so the mic is never left silent.
   */
  const applyNoiseFilter = async (
    processor: AudioTrackProcessorLike | null,
  ): Promise<void> => {
    const audioTrack = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    if (!audioTrack) return;
    if (processor) {
      audioTrack.setAudioContext(await getNoiseFilterContext());
      await audioTrack.setProcessor(processor as TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>);
    } else if (audioTrack.getProcessor()) {
      await audioTrack.stopProcessor();
    }
  };

  /**
   * Pin/release the preferred simulcast layer for a remote camera (focus → HIGH,
   * unfocus → LOW). Only a `RemoteTrackPublication` exposes `setVideoQuality`; the
   * unfocus LOW is transient — adaptiveStream reclaims control as soon as the
   * element resizes/reattaches to a small tile. Best-effort, never throws.
   */
  const setRemoteCameraQuality = (identity: string, quality: "high" | "auto"): void => {
    try {
      const pub = room.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.Camera);
      if (pub && typeof pub.setVideoQuality === "function") {
        pub.setVideoQuality(quality === "high" ? VideoQuality.HIGH : VideoQuality.LOW);
      }
    } catch {
      // best-effort — adaptiveStream still drives the layer by element size.
    }
  };

  /**
   * Subscribe/unsubscribe from a remote camera's video track — the bandwidth
   * lever. Only a `RemoteTrackPublication` exposes `setSubscribed`; passing
   * `false` when the UI hides the camera makes the SFU stop forwarding the stream
   * entirely (stronger than pinning the low layer). Best-effort, never throws.
   */
  const setRemoteCameraSubscribed = (identity: string, subscribed: boolean): void => {
    try {
      const pub = room.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.Camera);
      if (pub && typeof pub.setSubscribed === "function") {
        pub.setSubscribed(subscribed);
      }
    } catch {
      // best-effort — bandwidth optimisation only.
    }
  };

  /**
   * Late-joiner SEED — see VoiceRoomAdapter.seedRemoteVideoTracks. Walk each remote
   * participant's camera + screen-share publication: force-subscribe any that
   * autoSubscribe/adaptiveStream hasn't subscribed yet (best-effort), and collect the
   * ones already carrying a live track for the engine to replay. Never throws.
   */
  const seedRemoteVideoTracks = (): SeededRemoteVideoTrack[] => {
    const out: SeededRemoteVideoTrack[] = [];
    try {
      for (const participant of room.remoteParticipants.values()) {
        for (const source of [Track.Source.Camera, Track.Source.ScreenShare]) {
          const pub = participant.getTrackPublication(source);
          if (!pub) continue;
          const track = pub.track;
          if (track && pub.isSubscribed) {
            out.push({ track, publication: pub, participant } as unknown as SeededRemoteVideoTrack);
          } else if (!pub.isSubscribed && typeof pub.setSubscribed === "function") {
            pub.setSubscribed(true);
          }
        }
      }
    } catch {
      // best-effort — the late-joiner visibility seed must never throw.
    }
    return out;
  };

  /**
   * Publish ONE attribute on the local participant — the deafen-flag broadcast
   * (see VoiceRoomAdapter.setLocalAttribute). livekit's `setAttributes` MERGES,
   * so passing only `{ [key]: value }` never disturbs other attributes; an
   * empty-string value deletes the key. Peers receive `ParticipantAttributesChanged`.
   */
  const setLocalAttribute = async (key: string, value: string): Promise<void> => {
    await room.localParticipant.setAttributes({ [key]: value });
  };

  /**
   * AUDIO half of the late-joiner seed — force-subscribe any pre-existing remote
   * audio publication (voice + the host's film/screen-share audio) not subscribed
   * yet, so a viewer who joined after a share started actually HEARS it. On the web
   * SDK autoSubscribe already covers pre-existing tracks, so this is normally a
   * no-op; kept for parity with RN (where it is the real fix) and as belt-and-
   * suspenders. Best-effort — never throws.
   */
  const ensureRemoteAudioSubscribed = (): void => {
    try {
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.audioTrackPublications.values()) {
          if (!pub.isSubscribed && typeof pub.setSubscribed === "function") {
            pub.setSubscribed(true);
          }
        }
      }
    } catch {
      // best-effort — the late-joiner audio seed must never throw.
    }
  };

  // VoiceRoomAdapter is a structural subset of Room; only the event-name
  // parameter types are looser (string constants instead of the RoomEvent
  // enum), and room-adapter.ts pins those names to the enum at compile time.
  // We attach the factories for the bits the adapter Room itself does not
  // provide (the local-audio meter, the connection-quality probe, and the live
  // mic-capture restart for audio-settings changes).
  const adapter = room as unknown as VoiceRoomAdapter & {
    createLocalAudioMeter: () => LocalAudioMeter | null;
    createConnectionQualityProbe: () => ConnectionQualityProbe | null;
    restartAudioTrack: (captureOptions: AudioCaptureOptionsLike) => Promise<void>;
    applyMicCaptureConstraints: (
      captureOptions: AudioCaptureOptionsLike,
    ) => Promise<boolean>;
    republishMicTrack: (
      captureOptions: AudioCaptureOptionsLike | undefined,
      publishOptions: MicPublishOptionsLike | undefined,
    ) => Promise<void>;
    applyNoiseFilter: (processor: AudioTrackProcessorLike | null) => Promise<void>;
    setRemoteCameraQuality: (identity: string, quality: "high" | "auto") => void;
    setRemoteCameraSubscribed: (identity: string, subscribed: boolean) => void;
    seedRemoteVideoTracks: () => SeededRemoteVideoTrack[];
    ensureRemoteAudioSubscribed: () => void;
    setLocalAttribute: (key: string, value: string) => Promise<void>;
  };
  adapter.createLocalAudioMeter = createLocalAudioMeter;
  adapter.createConnectionQualityProbe = createConnectionQualityProbe;
  adapter.restartAudioTrack = restartAudioTrack;
  adapter.applyMicCaptureConstraints = applyMicCaptureConstraints;
  adapter.republishMicTrack = republishMicTrack;
  adapter.applyNoiseFilter = applyNoiseFilter;
  adapter.setRemoteCameraQuality = setRemoteCameraQuality;
  adapter.setRemoteCameraSubscribed = setRemoteCameraSubscribed;
  adapter.seedRemoteVideoTracks = seedRemoteVideoTracks;
  adapter.ensureRemoteAudioSubscribed = ensureRemoteAudioSubscribed;
  adapter.setLocalAttribute = setLocalAttribute;
  return adapter;
}
