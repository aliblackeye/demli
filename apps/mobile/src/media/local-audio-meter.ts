/**
 * RN on-device LOCAL mic meter (task #54, mobile) — the React Native counterpart
 * of desktop's WebAudio `createLocalAudioMeter` (packages/media/src/livekit.ts).
 *
 * ⚠️ STATUS: DISABLED (P0 — engine JS-thread saturation). See
 * {@link ON_DEVICE_LOCAL_METER_ENABLED} below.
 *
 * Root cause this file caused: the native plain `VolumeProcessor` behind
 * `createVolumeProcessor` is a WebRTC `AudioTrackSink`; its `onData` fires
 * `emit(LK_VOLUME_PROCESSED)` on EVERY ~10ms audio frame (~100 Hz), UNTHROTTLED,
 * for as long as the mic track is capturing — which on an unmuted mic is the whole
 * session (including the silent outgoing-ring phase, and even while muted since the
 * track is kept alive-but-silent for instant unmute). That is a constant ~100 Hz
 * native→JS bridge storm that runs regardless of whether anyone is talking and
 * regardless of whether any call UI is mounted — it pegged the RN JS thread
 * (`mqt_v_js` ~72-89% on device) and churned GC (a `{volume,id}` object per event),
 * which in turn caused the ~5 s "Leave → real disconnect" lag, the frozen call
 * timer, stale `call.ended` handling, and eventual JS-context death (black screen).
 * Unlike this, desktop's meter (livekit.ts) is PULL-based (a WebAudio analyser
 * sampled at poll time), so it never had this storm — this was mobile-only.
 *
 * Until a native-THROTTLED level source exists (the SDK's
 * `createMultibandVolumeProcessor` takes an `updateInterval` and emits
 * `LK_MULTIBAND_PROCESSED` at that rate — but it is FFT band-magnitude, a different
 * scale than the shared RMS `SpeakingDetector` calibration, so restoring it needs a
 * device-calibrated threshold and is a follow-up), the engine falls back to
 * server-driven local speaking — exactly the pre-task-#54 mobile behaviour: the
 * LOCAL user's own green ring is driven by the SFU's `ActiveSpeakersChanged` (~0.5-2s
 * lag) like every REMOTE ring already is. Remote rings are unaffected.
 *
 * Why: a participant's `speaking` flag is normally driven by the SFU's
 * `ActiveSpeakersChanged`, which lags ~0.5–2s. The shared engine already computes
 * the LOCAL user's ring on-device from a mic-level meter when the room adapter
 * provides `createLocalAudioMeter` — desktop does; mobile did NOT, so the phone's
 * own ring lagged. This wires the meter for RN so the local ring is instant.
 *
 * There is no WebAudio on React Native, so we can't reuse livekit-client's
 * `createAudioAnalyser`. Instead we use the SAME native primitive
 * `@livekit/react-native`'s own `useTrackVolume` hook uses: the
 * `LivekitReactNativeModule.createVolumeProcessor(pcId, trackId)` native volume
 * processor, which emits `LK_VOLUME_PROCESSED` `{ id, volume }` events (0..1). We
 * read them imperatively (the engine's meter contract is a synchronous
 * `level()`), caching the latest value and returning it each poll.
 *
 * Fully DEFENSIVE — a broken/absent native path must degrade to the pre-existing
 * server-driven local speaking, never regress it:
 *  - if the native module or `createVolumeProcessor` is missing, the factory
 *    returns null and the engine keeps server-driven local speaking (exactly
 *    today's mobile behaviour).
 *  - `level()` self-heals: it re-resolves the live mic track every call and
 *    rebinds the processor when the track / peer-connection changes (mute keeps
 *    the track; device switch / reconnect / publish swaps it), and never throws.
 */
import { NativeEventEmitter, NativeModules } from "react-native";
import { Track } from "livekit-client";
import type { Room } from "livekit-client";
import type { LocalAudioMeter } from "@demli/media";

/** The subset of the LiveKit RN native module this meter uses. */
interface VolumeNativeModule {
  createVolumeProcessor(pcId: number, trackId: string): number;
  deleteVolumeProcessor(reactTag: number, pcId: number, trackId: string): void;
  // RCTEventEmitter bookkeeping (present on the LiveKit native module); optional
  // so a NativeEventEmitter can still be constructed defensively.
  addListener?(event: string): void;
  removeListeners?(count: number): void;
}

/** react-native-webrtc tags a track with the PC it is attached to. */
interface RNTrackLike {
  id: string;
  _peerConnectionId?: number;
}

const LKModule = NativeModules.LivekitReactNativeModule as VolumeNativeModule | undefined;

/**
 * Master switch for the on-device local mic meter. FALSE (P0 — see file header):
 * the native plain `VolumeProcessor` emits `LK_VOLUME_PROCESSED` per ~10ms audio
 * frame (~100 Hz), unthrottled, which saturated the RN JS thread and froze active
 * calls. While disabled, `createRNLocalAudioMeter` returns null so the shared
 * engine cleanly falls back to server-driven local speaking (see the engine's
 * `startLocalSpeaking` — a null meter means no processor AND no 20 Hz poll timer).
 *
 * Typed `boolean` (not the literal `false`) on purpose: it keeps the meter
 * implementation below type-reachable (no dead-code error) so restoring the
 * instant local ring is a one-line flip once a native-THROTTLED level source is
 * wired (see the header's `createMultibandVolumeProcessor` note). Any restore MUST
 * pass the AVD/device speaking-ring gate (§32) before shipping.
 */
const ON_DEVICE_LOCAL_METER_ENABLED: boolean = false;

/**
 * Build an on-device local mic meter for `room`, or null when disabled / when the
 * native volume processor is unavailable (→ engine falls back to server-driven
 * local speaking).
 */
export function createRNLocalAudioMeter(room: Room): LocalAudioMeter | null {
  // P0: disabled — never open the ~100 Hz native volume-processor bridge storm.
  if (!ON_DEVICE_LOCAL_METER_ENABLED) return null;
  if (!LKModule || typeof LKModule.createVolumeProcessor !== "function") {
    return null;
  }
  const nativeModule = LKModule;

  // A dedicated NativeEventEmitter on the same module: RN routes native events
  // through the shared device emitter, so this receives LK_VOLUME_PROCESSED
  // alongside the SDK's own emitter (used by useTrackVolume) without conflict.
  const emitter = new NativeEventEmitter(nativeModule as unknown as never);

  let reactTag: number | null = null;
  let boundKey: string | null = null;
  let boundPcId = -1;
  let boundTrackId: string | null = null;
  let lastLevel = 0;

  const subscription = emitter.addListener(
    "LK_VOLUME_PROCESSED",
    (event: { id?: number; volume?: number }) => {
      if (reactTag != null && event?.id === reactTag && typeof event.volume === "number") {
        lastLevel = event.volume;
      }
    },
  );

  /** The live local mic MediaStreamTrack, or null when there is none. */
  function currentTrack(): RNTrackLike | null {
    const audioTrack = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    return (audioTrack?.mediaStreamTrack as unknown as RNTrackLike | undefined) ?? null;
  }

  /** Release the native processor and forget the binding. Best-effort. */
  function teardownProcessor(): void {
    if (reactTag != null && boundTrackId != null) {
      try {
        nativeModule.deleteVolumeProcessor(reactTag, boundPcId, boundTrackId);
      } catch {
        // best-effort — the processor may already be gone.
      }
    }
    reactTag = null;
    boundKey = null;
    boundTrackId = null;
    boundPcId = -1;
    lastLevel = 0;
  }

  return {
    level(): number {
      const track = currentTrack();
      if (!track) {
        teardownProcessor();
        return 0;
      }
      const pcId = track._peerConnectionId ?? -1;
      const trackId = track.id;
      const key = `${pcId}:${trackId}`;
      if (key !== boundKey) {
        // Track / peer-connection changed (publish, device switch, reconnect) —
        // rebind the processor to the current track.
        teardownProcessor();
        try {
          const tag = nativeModule.createVolumeProcessor(pcId, trackId);
          // Guard: only a synchronous numeric reactTag is usable (a Promise or
          // anything else means the native contract differs — stay unbound and
          // retry next poll, returning 0 rather than a bad handle).
          if (typeof tag === "number") {
            reactTag = tag;
            boundKey = key;
            boundPcId = pcId;
            boundTrackId = trackId;
          }
        } catch {
          // Leave unbound; the next poll retries. Never throw (meter contract).
        }
        return 0; // no sample yet on the tick we (re)bound
      }
      return lastLevel;
    },
    close(): void {
      try {
        subscription.remove();
      } catch {
        // best-effort
      }
      teardownProcessor();
    },
  };
}
