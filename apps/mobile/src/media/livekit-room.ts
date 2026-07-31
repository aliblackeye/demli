/**
 * Mobile `VoiceRoomAdapter` — the React Native counterpart of desktop's
 * `packages/media/src/livekit.ts` (`createLiveKitRoom`).
 *
 * The shared voice FSM (`@demli/media`) talks ONLY to the structural
 * `VoiceRoomAdapter` interface; it never imports a LiveKit SDK. Desktop injects
 * a `livekit-client` (browser/Electron) room; mobile injects THIS adapter, built
 * on an `@livekit/react-native` `Room`. We import the engine from the package
 * ROOT only (`@demli/media`), never `@demli/media/web`, so the web SDK
 * factory never enters the RN graph.
 *
 * Note on `livekit-client`: `@livekit/react-native` IS livekit-client running on
 * native WebRTC — the RN SDK re-exposes the same `Room`/`RemoteParticipant`
 * classes made to work over `@livekit/react-native-webrtc` via `registerGlobals`.
 * So `livekit-client` is a required, first-class dependency of the RN SDK (its
 * own source imports it). The `Room` constructor therefore comes from
 * `livekit-client`; the RN-specific pieces (`AudioSession`, `registerGlobals`,
 * the `VideoTrack` component) come from `@livekit/react-native`. This is the one
 * place mobile touches livekit-client, and it is livekit-client-on-RN, NOT the
 * desktop web adapter. (See the E2 report for why E1's blanket
 * "livekit-client out of the bundle" guard had to be relaxed to the web entry.)
 *
 * RN-specific seams this adapter adds over a bare `Room`:
 *  - AudioSession lifecycle (configure the VoIP profile + start on connect /
 *    stop on disconnect) so mic capture + remote playback (incl. the film's
 *    SCREEN_SHARE_AUDIO) route through the phone's audio hardware and keep audio
 *    focus when backgrounded.
 *  - Microphone permission + error normalization (see ./permissions) so the
 *    unchanged engine emits the correct §26 errors.
 *  - Output routing mapped to the native audio-route picker (speaker / earpiece
 *    / bluetooth) instead of the web's arbitrary `setSinkId`.
 */
import { AudioSession } from "@livekit/react-native";
import { Room, RoomEvent, Track, VideoQuality } from "livekit-client";
import type {
  LocalTrackPublication,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RoomConnectOptions,
  RoomOptions,
  TrackPublication,
} from "livekit-client";
import type {
  AudioCaptureOptionsLike,
  ConnectionQualityProbe,
  LocalParticipantLike,
  LocalTrackPublicationLike,
  MicPublishOptionsLike,
  RemoteParticipantLike,
  RoomEventName,
  RoomListener,
  SeededRemoteVideoTrack,
  TrackPublishOptionsLike,
  VideoCaptureOptionsLike,
  VideoPublishOptionsLike,
  VoiceRoomAdapter,
} from "@demli/media";
import type { LocalAudioMeter } from "@demli/media";
import { connectionQualityLevelFromLiveKit, MOBILE_CAMERA_CAPTURE_DEFAULT } from "@demli/media";
import { androidAudioTypeOptionsFor, getActiveAudioProfile } from "./audio-profile";
import { ensureLiveKitGlobals } from "./livekit-globals";
import { createRNLocalAudioMeter } from "./local-audio-meter";
import {
  ensureCameraPermission,
  ensureMicPermission,
  normalizeMediaError,
} from "./permissions";

/** The live local camera track (a livekit `LocalVideoTrack`) or null when off. */
export type LocalCameraTrack = LocalVideoTrack;

// ---------------------------------------------------------------------------
// Local camera self-preview surfacing (task #18)
//
// The shared engine surfaces REMOTE cameras (getCameras/subscribeCameras) but
// deliberately NEVER exposes LOCAL tracks as React state (§27). The mobile
// self-preview tile still needs the live `LocalVideoTrack` to render, so the
// adapter surfaces it imperatively here — the same getSnapshot/subscribe shape
// `useSyncExternalStore` wants (mirroring the engine's remote-camera pair).
//
// `getLocalCameraTrack` reads the LIVE publication, so it returns a STABLE
// reference: livekit keeps the `LocalVideoTrack` object identity for as long as
// it is published (and returns undefined → null when the camera is off). That
// stability is required or `useSyncExternalStore` would loop.
// ---------------------------------------------------------------------------
let activeRoom: Room | null = null;
const localCameraListeners = new Set<() => void>();

function notifyLocalCameraChanged(): void {
  for (const listener of localCameraListeners) listener();
}

/** Snapshot of the live local camera track (null when the camera is off/muted). */
export function getLocalCameraTrack(): LocalCameraTrack | null {
  const publication = activeRoom?.localParticipant.getTrackPublication(
    Track.Source.Camera,
  );
  // Turning the camera off MUTES the track (livekit keeps the publication for an
  // instant re-enable), so `videoTrack` stays non-null while off. Returning that
  // stale, frozen track is what left the self-preview showing a black/last frame;
  // treat a muted publication as "no camera" so the UI renders the avatar instead.
  if (!publication || publication.isMuted) return null;
  return publication.videoTrack ?? null;
}

/** Subscribe to local-camera publish/unpublish — `useSyncExternalStore`-ready. */
export function subscribeLocalCamera(listener: () => void): () => void {
  localCameraListeners.add(listener);
  return () => {
    localCameraListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Audio output routing (audit D1)
//
// This module is the one place mobile touches the `@livekit/react-native`
// AudioSession (see the file header), so enumerating output routes lives here
// too — the UI never imports the SDK directly. Selecting a route already flows
// through the engine (`setOutputDevice` → switchActiveDevice("audiooutput") →
// AudioSession.selectAudioOutput above); this is only the read side.
// ---------------------------------------------------------------------------

/**
 * The audio output routes currently available for {@link AudioSession.selectAudioOutput}
 * (Android: some of speaker/earpiece/headset/bluetooth; iOS: default/force_speaker).
 * Requires a started audio session (we start one on connect), so this returns []
 * until the room is connected — the caller simply shows nothing to pick then.
 * Defensive: never throws (the picker treats [] as "nothing to choose").
 */
export async function getAudioOutputRoutes(): Promise<string[]> {
  try {
    return await AudioSession.getAudioOutputs();
  } catch {
    return [];
  }
}

/**
 * Wraps a `Room`'s local participant to add the RN mic-permission gate and error
 * normalization. Reads `room.localParticipant` lazily so it always reflects the
 * live participant (LiveKit keeps a stable object, but this stays correct even
 * if that ever changes).
 */
class LocalParticipantAdapter implements LocalParticipantLike {
  constructor(private readonly room: Room) {}

  get identity(): string {
    return this.room.localParticipant.identity;
  }
  get isMicrophoneEnabled(): boolean {
    return this.room.localParticipant.isMicrophoneEnabled;
  }
  get isScreenShareEnabled(): boolean {
    return this.room.localParticipant.isScreenShareEnabled;
  }

  async setMicrophoneEnabled(
    enabled: boolean,
    captureOptions?: AudioCaptureOptionsLike,
    publishOptions?: MicPublishOptionsLike,
  ): Promise<unknown> {
    if (enabled) await ensureMicPermission(); // throws NotAllowedError if denied
    try {
      // Forward the audio-processing capture constraints + bitrate preset to
      // native WebRTC (Ayarlar → Mikrofon). Loose-cast (as the file already does
      // for publishTrack) so the structural *Like subsets satisfy livekit's types.
      const set = this.room.localParticipant.setMicrophoneEnabled.bind(
        this.room.localParticipant,
      ) as (
        e: boolean,
        c?: AudioCaptureOptionsLike,
        p?: MicPublishOptionsLike,
      ) => Promise<unknown>;
      return await set(enabled, captureOptions, publishOptions);
    } catch (err) {
      throw normalizeMediaError(err);
    }
  }

  /**
   * Enable/disable the local CAMERA (task #18) — the camera counterpart of
   * `setMicrophoneEnabled`. Gate the OS camera permission first (RN needs the
   * explicit runtime request; react-native-webrtc does not prompt for us), then
   * let livekit acquire and publish the camera track itself (source `camera`).
   * Denials/failures are normalized to the DOMException-named errors the engine
   * classifies into §26 messages (`permission_denied`/`device_not_found`/...).
   * Wiring this optional method up is what lets the shared engine's `setCamera`
   * run on mobile instead of degrading to "camera unsupported".
   */
  async setCameraEnabled(
    enabled: boolean,
    captureOptions?: VideoCaptureOptionsLike,
    publishOptions?: VideoPublishOptionsLike,
  ): Promise<LocalTrackPublicationLike | undefined> {
    if (enabled) await ensureCameraPermission(); // throws NotAllowedError if denied
    if (enabled && __DEV__) {
      // Prove the phone requests a HIGH capture resolution (the founder's quality
      // report). For the default "auto" tier the engine passes no captureOptions —
      // the room's videoCaptureDefaults (MOBILE_CAMERA_CAPTURE_DEFAULT, 720p) apply —
      // so log that fallback when none is given. Dev-only (no production noise, §27).
      const res = captureOptions?.resolution ?? MOBILE_CAMERA_CAPTURE_DEFAULT;
      console.log(
        `[media] camera capture request ${res.width}x${res.height}@${res.frameRate ?? 30}fps ` +
          `bitrate=${publishOptions?.videoEncoding?.maxBitrate ?? "default"} ` +
          `degradation=${publishOptions?.degradationPreference ?? "default"}`,
      );
    }
    try {
      // Forward the camera capture constraints (resolution/FPS — Kamera kalitesi)
      // AND the explicit publish encoding (bitrate ceiling — the sharpness fix) to
      // native WebRTC. Loose-cast so the structural subsets satisfy livekit's
      // VideoCaptureOptions / TrackPublishOptions types (same pattern as publishTrack).
      const set = this.room.localParticipant.setCameraEnabled.bind(
        this.room.localParticipant,
      ) as (
        e: boolean,
        c?: VideoCaptureOptionsLike,
        p?: VideoPublishOptionsLike,
      ) => Promise<LocalTrackPublicationLike | undefined>;
      const publication = await set(enabled, captureOptions, publishOptions);
      return publication as LocalTrackPublicationLike | undefined;
    } catch (err) {
      throw normalizeMediaError(err);
    }
  }

  /**
   * Publishing a screen FROM mobile is OUT OF SCOPE for E2 (the host shares from
   * desktop; mobile only watches + talks). The engine only calls these from
   * `startScreenShare`, which the mobile UI never invokes. We delegate anyway so
   * the interface stays honest and a future mobile-as-host build slots in.
   */
  async publishTrack(
    track: MediaStreamTrack,
    options: TrackPublishOptionsLike,
  ): Promise<LocalTrackPublicationLike> {
    const publish = this.room.localParticipant.publishTrack.bind(
      this.room.localParticipant,
    ) as (t: unknown, o: unknown) => Promise<unknown>;
    const pub = await publish(track, options);
    return pub as LocalTrackPublicationLike;
  }

  async unpublishTrack(
    track: MediaStreamTrack,
    stopOnUnpublish?: boolean,
  ): Promise<LocalTrackPublicationLike | undefined> {
    const unpublish = this.room.localParticipant.unpublishTrack.bind(
      this.room.localParticipant,
    ) as (t: unknown, stop?: boolean) => Promise<unknown>;
    const pub = await unpublish(track, stopOnUnpublish);
    return pub as LocalTrackPublicationLike | undefined;
  }
}

class LiveKitMobileRoom implements VoiceRoomAdapter {
  private readonly local: LocalParticipantLike;
  private audioActive = false;
  /** Deafen state — remote audio is muted while true (see setRemoteAudioMuted). */
  private deafened = false;
  /**
   * Last per-share (film) volume the engine asked us to apply, keyed by the sharer's
   * identity. Remembered so we can RE-APPLY it the moment that remote's
   * `screen_share_audio` track (re)subscribes — the film track is a second, flakily-
   * subscribed remote audio publication, so a live slider drag can land before the
   * track is bound (see setRemoteScreenShareVolume / onRemoteTrackSubscribed).
   */
  private readonly screenShareVolumes = new Map<string, number>();

  constructor(private readonly room: Room) {
    this.local = new LocalParticipantAdapter(room);
    // This adapter owns the current session's room; the local self-preview reads
    // its camera publication (task #18). A fresh room is created per join, so the
    // latest constructed adapter wins — the store leaves the old room before
    // joining a new one, so `disconnect` has already cleared the previous ref.
    activeRoom = room;
    room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackChanged);
    room.on(RoomEvent.LocalTrackUnpublished, this.onLocalTrackChanged);
    // Turning the camera off MUTES (not unpublishes) the track, so the two events
    // above never fire on a toggle — only TrackMuted/TrackUnmuted do. Bind them too
    // or the self-preview never learns the camera went off (getLocalCameraTrack now
    // returns null while muted, but the subscriber must be told to re-read).
    room.on(RoomEvent.TrackMuted, this.onLocalTrackMuteChanged);
    room.on(RoomEvent.TrackUnmuted, this.onLocalTrackMuteChanged);
    // Deafen must also silence remotes who (un)mute or JOIN while deafened. We mute
    // at the SUBSCRIPTION level (setEnabled) for a robust binary deafen that also
    // stops the SFU forwarding; per-user "User Volume" (a gradient 0..2) instead
    // rides livekit's native per-track gain — see setRemoteAudioMuted.
    room.on(RoomEvent.TrackSubscribed, this.onRemoteTrackSubscribed);
  }

  /** While deafened, silence any remote AUDIO publication the moment it subscribes. */
  private readonly onRemoteTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    if (track.kind === Track.Kind.Audio) {
      // Dev-only evidence for the "film/broadcast audio doesn't reach mobile" report:
      // a `screen_share_audio` source here PROVES the host's system-audio track was
      // published and this client subscribed it (native playout then handles it). If
      // this never logs while a desktop shares WITH system audio, the drop is on the
      // DESKTOP loopback side (surfaced there as screenShareSystemAudioFailed), not
      // here. No production noise (§27).
      if (__DEV__) {
        console.log(
          `[media] audio TrackSubscribed source=${publication.source} sid=${publication.trackSid} deafened=${this.deafened}`,
        );
      }
      if (this.deafened) {
        this.muteRemotePublication(publication, true);
        return;
      }
      // Re-apply the LISTENER's saved per-share (film) volume the instant the
      // `screen_share_audio` track binds. livekit's volumeMap re-applies on
      // addSubscribedMediaTrack too, but the RN force-subscribe path is exactly where
      // the film track has historically been unreliable (ensureRemoteAudioSubscribed);
      // a live slider drag can also have landed while this pub had no `.track` yet, so
      // the value only lived in our map. This is the belt-and-suspenders that makes the
      // saved level actually reach the freshly-bound native gain. Skipped while deafened
      // (handled above — deafen is a master mute that setEnabled already enforces).
      if (publication.source === Track.Source.ScreenShareAudio) {
        const level = this.screenShareVolumes.get(participant.identity);
        if (level !== undefined) {
          this.applyScreenShareVolume(participant, level);
        }
      }
    }
  };

  /**
   * Push a per-share (film) volume to a remote's `screen_share_audio` playout via
   * BOTH livekit paths, best-effort:
   *  - `RemoteParticipant.setVolume(v, ScreenShareAudio)` sets livekit's per-source
   *    volumeMap so the value survives a later (re)subscribe, and
   *  - a DIRECT `pub.track.setVolume(v)` on the film publication reaches the native
   *    `AudioTrack.setVolume` immediately when the track is already bound.
   * On RN, `RemoteAudioTrack.setVolume` routes to `_mediaStreamTrack._setVolume` →
   * native `mediaStreamTrackSetVolume` → `AudioTrack.setVolume` (a 0..10 gain), the
   * same mechanism the per-user voice slider uses. Never throws.
   */
  private applyScreenShareVolume(participant: RemoteParticipant, volume: number): void {
    let pub: RemoteTrackPublication | undefined;
    for (const p of participant.audioTrackPublications.values()) {
      if (p.source === Track.Source.ScreenShareAudio) {
        pub = p;
        break;
      }
    }
    if (__DEV__) {
      console.log(
        `[media] applyScreenShareVolume id=${participant.identity} vol=${volume} pub=${
          pub ? "yes" : "no"
        } subscribed=${pub?.isSubscribed ?? false} track=${pub?.track ? "yes" : "no"}`,
      );
    }
    try {
      participant.setVolume(volume, Track.Source.ScreenShareAudio);
    } catch {
      // best-effort — volumeMap set path.
    }
    try {
      (pub?.track as { setVolume?: (v: number) => void } | undefined)?.setVolume?.(volume);
    } catch {
      // best-effort — a publication may be mid-teardown.
    }
  }

  /**
   * Mute/unmute ONE remote audio publication for DEAFEN. `setEnabled(false)`
   * disables the local subscription so the SDK stops rendering it (and the SFU
   * stops forwarding) — a clean, bandwidth-saving binary mute, and the lever the
   * deafen fix has always used on RN.
   *
   * On MUTE we ALSO zero the native gain (belt-and-suspenders). On UNMUTE we must
   * NOT force the gain back to 1: deafen composes with the per-user "User Volume"
   * (0..2), and the engine's `applyRemoteVolumes(false)` runs BEFORE this and has
   * already restored each remote's personal level via `RemoteParticipant.setVolume`
   * (which livekit re-applies through its `volumeMap` when the re-enabled
   * subscription resubscribes). Forcing 1 here would clobber a custom level, so
   * undeafen would reset every User Volume to 100% (a real bug — the contract says
   * undeafen restores the PERSONAL level, not a blanket 100%). Best-effort — never throws.
   */
  private muteRemotePublication(pub: RemoteTrackPublication, muted: boolean): void {
    try {
      pub.setEnabled(!muted);
      // Belt-and-suspenders on MUTE only (never on unmute — see above).
      if (muted) {
        (pub.track as { setVolume?: (v: number) => void } | undefined)?.setVolume?.(0);
      }
    } catch {
      // best-effort — a publication may be mid-teardown.
    }
  }

  /**
   * Notify the self-preview when the LOCAL camera track is (un)published. We
   * filter to camera publications so mic/screen-share publish churn never
   * ripples into the camera tile.
   */
  private readonly onLocalTrackChanged = (
    publication: LocalTrackPublication,
  ): void => {
    if (publication.source === Track.Source.Camera) notifyLocalCameraChanged();
  };

  /**
   * Notify the self-preview when the LOCAL camera is MUTED/UNMUTED (the on/off
   * toggle path — livekit mutes rather than unpublishes). TrackMuted/TrackUnmuted
   * fire for remotes too, so filter to our own local camera publication.
   */
  private readonly onLocalTrackMuteChanged = (
    publication: TrackPublication,
    participant: Participant,
  ): void => {
    if (
      participant === this.room.localParticipant &&
      publication.source === Track.Source.Camera
    ) {
      notifyLocalCameraChanged();
    }
  };

  // The engine subscribes with `ROOM_EVENT` string values (RoomEventName), whose
  // literals equal livekit's `RoomEvent` enum values. LiveKit's EventEmitter keys
  // on those same strings, so we forward through a string-typed view of on/off —
  // no need to import the RoomEvent enum.
  on(event: RoomEventName, listener: RoomListener): unknown {
    const on = this.room.on.bind(this.room) as (
      e: string,
      l: (...args: never[]) => void,
    ) => unknown;
    return on(event, listener);
  }
  off(event: RoomEventName, listener: RoomListener): unknown {
    const off = this.room.off.bind(this.room) as (
      e: string,
      l: (...args: never[]) => void,
    ) => unknown;
    return off(event, listener);
  }

  async connect(url: string, token: string): Promise<void> {
    // Start the native audio session BEFORE connecting so captured mic + remote
    // playback (voice AND the film's screen-share audio) are routed correctly.
    if (!this.audioActive) {
      // Apply the audio profile FIRST (configureAudio must precede connect). The
      // DEFAULT is the VoIP profile: audioMode=inCommunication,
      // usage=voiceCommunication, audioFocus=GAIN. That is the correct profile for
      // a comms app and — because a VoIP audio focus is prioritized by the OS — is
      // what best keeps remote playout alive while the app is backgrounded (B3,
      // JS-side maximum). NOTE: this does NOT by itself keep the MICROPHONE
      // capturing in the background; Android requires a foreground service
      // (foregroundServiceType=microphone) for that, which the installed LiveKit RN
      // stack does not expose from JS. See the mobile-voice handoff report for the
      // escalation on true background-mic parity.
      //
      // Task #121: the user may opt into the `media` profile (Ayarlar → Ses
      // profili) so a shared film/music plays on the media stream instead of the
      // call stream. Read at connect time and never mid-session — the RN SDK
      // offers no live switch, and the settings UI states that plainly. See
      // ./audio-profile for the tradeoffs the UI discloses.
      await AudioSession.configureAudio({
        android: { audioTypeOptions: androidAudioTypeOptionsFor(getActiveAudioProfile()) },
      });
      await AudioSession.startAudioSession();
      this.audioActive = true;
    }
    try {
      // autoSubscribe (the default) ensures we receive remote voice + the host's
      // SCREEN_SHARE video and SCREEN_SHARE_AUDIO tracks without asking.
      const options: RoomConnectOptions = { autoSubscribe: true };
      await this.room.connect(url, token, options);
    } catch (err) {
      await this.stopAudio();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.room.disconnect();
    } finally {
      this.room.off(RoomEvent.LocalTrackPublished, this.onLocalTrackChanged);
      this.room.off(RoomEvent.LocalTrackUnpublished, this.onLocalTrackChanged);
      this.room.off(RoomEvent.TrackMuted, this.onLocalTrackMuteChanged);
      this.room.off(RoomEvent.TrackUnmuted, this.onLocalTrackMuteChanged);
      this.room.off(RoomEvent.TrackSubscribed, this.onRemoteTrackSubscribed);
      // Drop the self-preview: clear the room ref and tell subscribers the local
      // camera is gone (getLocalCameraTrack now returns null).
      if (activeRoom === this.room) activeRoom = null;
      notifyLocalCameraChanged();
      await this.stopAudio();
    }
  }

  private async stopAudio(): Promise<void> {
    if (!this.audioActive) return;
    this.audioActive = false;
    try {
      await AudioSession.stopAudioSession();
    } catch {
      // Best effort — the session may already be torn down.
    }
  }

  get localParticipant(): LocalParticipantLike {
    return this.local;
  }

  get remoteParticipants(): ReadonlyMap<string, RemoteParticipantLike> {
    // livekit `RemoteParticipant` is structurally a `RemoteParticipantLike`
    // (identity / isMicrophoneEnabled / isScreenShareEnabled / setVolume). The
    // engine reads this map for the participant list, active-speaker sync, and
    // deafen (per-remote setVolume(0|1)).
    return this.room.remoteParticipants as unknown as ReadonlyMap<
      string,
      RemoteParticipantLike
    >;
  }

  async switchActiveDevice(
    kind: "audioinput" | "audiooutput" | "videoinput",
    deviceId: string,
  ): Promise<unknown> {
    if (kind === "audiooutput") {
      // RN has no arbitrary output sink ids; it routes to a named audio output
      // (speaker / earpiece / bluetooth) through the native session. Output-switch
      // failures are treated as non-fatal by the engine.
      return AudioSession.selectAudioOutput(deviceId);
    }
    // audioinput + videoinput (camera device select, task #18) both go through
    // livekit's own device switch on native WebRTC.
    return this.room.switchActiveDevice(kind, deviceId);
  }

  /**
   * Ping / connection-quality probe (task #55) — full parity with the desktop
   * web adapter, no new native module: `@livekit/react-native` IS livekit-client
   * on native WebRTC, so the SAME synchronous getters exist here.
   *  - level: the LOCAL participant's server-computed `ConnectionQuality`.
   *  - rttMs: the ICE candidate-pair round-trip time from `getStats()`, falling
   *    back to livekit's signal-channel RTT only until WebRTC has measured one.
   *
   * The signal RTT was the ONLY source here until the desktop measurement showed
   * it is not a network reading at all: it is `Date.now() - lastPingTimestamp`
   * with both stamps taken in main-thread JS, so a long task landing between the
   * ping and the pong is added to the reported value 1:1. Measured on a real
   * socket with the pong pinned at 40 ms, injecting 350 ms of main-thread work
   * pushed that formula to 355 ms p95 while the true RTT never moved. The
   * candidate-pair value comes from libwebrtc's own network thread (STUN
   * request/response) and measures the MEDIA path, so a busy JS thread delays
   * WHEN we read it, never WHAT it says.
   *
   * Both reads are wrapped defensively (the probe contract forbids throwing).
   */
  /**
   * Re-acquire the LIVE mic track with new capture constraints (audio-settings
   * change: music mode / a DSP toggle) so it applies WITHOUT a rejoin — full
   * parity with the desktop web adapter (`@livekit/react-native` IS
   * livekit-client on native WebRTC, so `LocalAudioTrack.restartTrack` exists).
   * No-op when the mic isn't currently published. JS-only → OTA-safe.
   */
  async restartAudioTrack(captureOptions: AudioCaptureOptionsLike): Promise<void> {
    const audioTrack = this.room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    if (audioTrack) await audioTrack.restartTrack(captureOptions);
  }

  /**
   * Full mic RE-PUBLISH (bitrate/RED/DTX/stereo change) — parity with the desktop
   * web adapter. `restartTrack` keeps the old publication's bitrate/codec, so a
   * quality-tier change needs an actual unpublish + republish to take effect
   * mid-call (the "changed the audio settings and nothing changed" fix). JS-only →
   * OTA-safe. No-op when the mic isn't published.
   */
  async republishMicTrack(
    captureOptions: AudioCaptureOptionsLike | undefined,
    publishOptions: MicPublishOptionsLike | undefined,
  ): Promise<void> {
    const lp = this.room.localParticipant;
    const pub = lp.getTrackPublication(Track.Source.Microphone);
    if (pub?.track) await lp.unpublishTrack(pub.track, true);
    const set = lp.setMicrophoneEnabled.bind(lp) as (
      e: boolean,
      c?: AudioCaptureOptionsLike,
      p?: MicPublishOptionsLike,
    ) => Promise<unknown>;
    await set(true, captureOptions, publishOptions);
  }

  /**
   * Pin (`"high"`) or release (`"auto"`) the preferred simulcast layer for one
   * remote camera — the subscriber half of the sharpness fix. A focused/fullscreen
   * `<VideoTrack>` is large so adaptiveStream already leans high; asserting HIGH
   * makes it deterministic. "auto" drops to LOW (an unfocused tile is small) and
   * adaptiveStream reclaims control on the next element resize. Best-effort.
   */
  setRemoteCameraQuality(identity: string, quality: "high" | "auto"): void {
    try {
      const pub = this.room.remoteParticipants
        .get(identity)
        ?.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
      // Dev-only evidence for the custom 2-layer simulcast: confirms a focus/fullscreen
      // pins HIGH (top layer) and a shrink releases to LOW — the switch the founder's
      // "camera stalls on a weak network" fix relies on. No production noise (§27).
      if (__DEV__ && pub) {
        console.log(`[media] setRemoteCameraQuality ${identity} → ${quality} (layer pin)`);
      }
      pub?.setVideoQuality(quality === "high" ? VideoQuality.HIGH : VideoQuality.LOW);
    } catch {
      // best-effort — adaptiveStream still drives the layer by element size.
    }
  }

  /**
   * Subscribe/unsubscribe from one remote camera's video track — the bandwidth
   * lever. Where setRemoteCameraQuality only pins a simulcast LAYER, this toggles
   * the whole SUBSCRIPTION: `false` (the UI hid the camera — fullscreen PiP closed
   * / strip collapsed) makes the SFU stop forwarding the stream; `true` resumes it
   * and the next TrackSubscribed re-seeds the camera. Best-effort — never throws.
   */
  setRemoteCameraSubscribed(identity: string, subscribed: boolean): void {
    try {
      const pub = this.room.remoteParticipants
        .get(identity)
        ?.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
      pub?.setSubscribed(subscribed);
    } catch {
      // best-effort — bandwidth optimisation only.
    }
  }

  /**
   * Late-joiner SEED — RN half of the P0 fix (see VoiceRoomAdapter.seedRemoteVideoTracks).
   * A remote already sharing/on-camera when we connect may never re-fire TrackSubscribed
   * on native, so walk each remote's camera + screen-share publication: force-subscribe
   * any not subscribed yet, and return the ones already carrying a live track for the
   * engine to replay. Best-effort — never throws.
   */
  seedRemoteVideoTracks(): SeededRemoteVideoTrack[] {
    const out: SeededRemoteVideoTrack[] = [];
    try {
      for (const participant of this.room.remoteParticipants.values()) {
        for (const source of [Track.Source.Camera, Track.Source.ScreenShare]) {
          const pub = (participant as RemoteParticipant).getTrackPublication(source) as
            | RemoteTrackPublication
            | undefined;
          if (!pub) continue;
          const track = pub.track;
          if (track && pub.isSubscribed) {
            out.push({ track, publication: pub, participant } as unknown as SeededRemoteVideoTrack);
          } else if (!pub.isSubscribed) {
            pub.setSubscribed(true);
          }
        }
      }
    } catch {
      // best-effort — the late-joiner visibility seed must never throw.
    }
    return out;
  }

  /**
   * AUDIO half of the late-joiner seed (see VoiceRoomAdapter.ensureRemoteAudioSubscribed)
   * — the RN "hear the ongoing film" P0. On React Native, connecting to a room whose
   * tracks were published BEFORE we joined does not reliably subscribe those pre-existing
   * publications (the same gap {@link seedRemoteVideoTracks} force-subscribes for video).
   * The host's SCREEN-SHARE / film audio (`screen_share_audio`) and everyone's mic are
   * separate audio publications, so a viewer who joins AFTER the host starts the film
   * would SEE the video (seeded) but never subscribe the film-audio track → total silence.
   * Force-subscribe every remote AUDIO publication not subscribed yet; the native audio
   * device then plays it automatically (no engine-side rendering needed). Best-effort —
   * never throws. Safe to run WHILE deafened: `onRemoteTrackSubscribed` re-mutes any
   * audio publication that subscribes while `this.deafened` is set, so the film track
   * comes up silent and is ready to un-mute the moment the user undeafens (a guarded
   * skip here would instead leave it unsubscribed → silent even after undeafen).
   */
  ensureRemoteAudioSubscribed(): void {
    try {
      for (const participant of this.room.remoteParticipants.values()) {
        for (const pub of (participant as RemoteParticipant).audioTrackPublications.values()) {
          if (!pub.isSubscribed) {
            // Dev-only evidence for the late-join film-audio path: a `screen_share_audio`
            // force-subscribe here is the "joined AFTER the host started the movie, now
            // hear it" fix firing. No production noise (§27).
            if (__DEV__) {
              console.log(
                `[media] late-join force-subscribe audio source=${pub.source} sid=${pub.trackSid} from=${participant.identity}`,
              );
            }
            pub.setSubscribed(true);
          }
        }
      }
    } catch {
      // best-effort — the late-joiner audio seed must never throw.
    }
  }

  /**
   * Deafen: mute (or restore) ALL remote audio — voice AND screen-share/film audio
   * — for current AND future remotes. Deafen is a BINARY master mute, so we disable
   * the subscription (`setEnabled(false)`) — the SDK stops rendering it and the SFU
   * stops forwarding. Late joiners (and anyone unmuting/adding a track while
   * deafened) are caught by `onRemoteTrackSubscribed`. Restoring re-enables every
   * remote audio publication; the per-user "User Volume" each remote returns to is
   * owned by the engine (`applyRemoteVolumes` runs first on undeafen — see
   * muteRemotePublication), NOT reset to 100% here.
   *
   * NOTE — the GRADIENT per-user volume path is separate and DOES reach native
   * playout: the engine calls `RemoteParticipant.setVolume(v)` which, on RN,
   * livekit-client routes to `RemoteAudioTrack._mediaStreamTrack._setVolume(v)` →
   * native `mediaStreamTrackSetVolume` → `AudioTrack.setVolume` (a 0..10 gain). So
   * the per-user slider is NOT a dead button (§35). This subscription-toggle is a
   * deliberate, more robust lever for the on/off deafen case only.
   */
  setRemoteAudioMuted(muted: boolean): void {
    this.deafened = muted;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of (participant as RemoteParticipant).audioTrackPublications.values()) {
        this.muteRemotePublication(pub, muted);
      }
    }
  }

  /**
   * Apply ONE remote's per-share (film) volume to the native playout — the RN half
   * of the listener's share volume (VoiceRoomAdapter contract). The
   * engine calls this ALONGSIDE its per-participant `setVolume(v, ScreenShareAudio)`
   * (which alone can miss the film track when it is not yet bound). We REMEMBER the
   * level and apply it now; `onRemoteTrackSubscribed` re-applies it when the
   * `screen_share_audio` track (re)subscribes, so a live slider drag that landed
   * before the track existed still reaches the gain. Deafen is a separate master mute
   * (setRemoteAudioMuted) and wins — the engine already passes 0 here while deafened.
   * Best-effort — never throws.
   */
  setRemoteScreenShareVolume(identity: string, volume: number): void {
    this.screenShareVolumes.set(identity, volume);
    const participant = this.room.remoteParticipants.get(identity) as
      | RemoteParticipant
      | undefined;
    if (participant) this.applyScreenShareVolume(participant, volume);
  }

  /**
   * On-device LOCAL mic meter (task #54) so the local speaking ring is instant
   * instead of waiting on the SFU's active-speaker round-trip — parity with the
   * desktop web adapter. Returns null when the native volume processor is
   * unavailable, in which case the engine keeps server-driven local speaking (the
   * previous mobile behaviour — no regression). See ./local-audio-meter.
   */
  createLocalAudioMeter(): LocalAudioMeter | null {
    return createRNLocalAudioMeter(this.room);
  }

  /**
   * Publish ONE local-participant attribute — the deafen-flag broadcast (see
   * VoiceRoomAdapter.setLocalAttribute). Full parity with the desktop web adapter:
   * `@livekit/react-native` IS livekit-client on native WebRTC, so the same
   * `LocalParticipant.setAttributes` merge exists. Passing only `{ [key]: value }`
   * leaves other attributes untouched; an empty-string value deletes the key. Peers
   * (desktop or mobile) receive `ParticipantAttributesChanged`. JS-only → OTA-safe.
   */
  async setLocalAttribute(key: string, value: string): Promise<void> {
    await this.room.localParticipant.setAttributes({ [key]: value });
  }

  createConnectionQualityProbe(): ConnectionQualityProbe | null {
    const room = this.room;
    /** Last measured media-path RTT in ms; null until WebRTC reports one. */
    let mediaRttMs: number | null = null;
    /** Guards against piling up getStats() calls if one is slow. */
    let sampling = false;
    let closed = false;

    const sampleMediaRtt = async (): Promise<void> => {
      if (sampling || closed) return;
      sampling = true;
      try {
        // Publisher first: it carries our uplink, the transport whose queue
        // bloats when we over-send. Subscriber when nothing is published yet.
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
        // Best-effort: keep the previous sample rather than blanking the bars.
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
        if (mediaRttMs !== null) return mediaRttMs;
        // Fallback only until WebRTC has measured a pair. `engine.client.rtt` is
        // `Date.now() - lastPingTimestamp` with BOTH stamps taken in JS, so any
        // long task landing between ping and pong is added to it 1:1 — on desktop
        // that made renderer jank read as network latency, and a phone running a
        // watch-party WebView has more of it, not less.
        try {
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
  }
}

/**
 * Injected into `createVoiceEngine({ createRoom })`. Registers the RN WebRTC
 * globals (idempotent) before constructing the `Room`, then wraps it. Uses the
 * same room options as desktop so behaviour matches: `adaptiveStream` scales the
 * received video to the rendered size (in PHYSICAL pixels — see the option),
 * `dynacast` lets the SFU pause layers nobody is watching, and mute keeps the mic
 * track alive-but-silent for instant unmute (livekit default
 * `stopMicTrackOnMute: false`). `publishDefaults` carries the ONE screen-share
 * publish override mobile needs (single encoding — see the option); every other
 * publish default is inherited from the SDK by spread-merge.
 */
export function createMobileVoiceRoom(): VoiceRoomAdapter {
  ensureLiveKitGlobals();
  const options: RoomOptions = {
    // SUBSCRIBE-side sharpness. adaptiveStream sizes its layer request from the
    // rendered element. On React Native that is `VideoTrackElementInfo.onLayout`
    // (@livekit/react-native), whose width/height are DP — the RN analog of CSS
    // pixels — multiplied by `getPixelDensity()`. As the bare `true` this file used
    // to pass, livekit multiplies by 1 unless the device ratio is `> 2`, and on RN
    // that ratio is `PixelRatio.get()`. Phones sit in exactly the wrong band: dPR 2.0
    // (very common Android) is not `> 2`, so it asked for HALF the linear pixels — a
    // QUARTER of the tile's actual area — and the SFU honestly served a lower spatial
    // layer that the view then upscaled. That was the mobile blur when WATCHING a
    // stream. `pixelDensity: "screen"` uses the real device ratio instead, exactly as
    // desktop already ships in packages/media/src/livekit.ts.
    //
    // Scope note: this is the RECEIVE path. It does not affect what this device
    // PUBLISHES — the publish-side screen-share fix is `publishDefaults` below.
    adaptiveStream: { pixelDensity: "screen" },
    dynacast: true,
    // PUBLISH-side screen-share sharpness (founder: "yayın grenleniyor, bulanık,
    // 1080p 30hz seçmişti").
    //
    // Mobile screen CAPTURE is not constrainable from JS — verified in the installed
    // @livekit/react-native-webrtc: `getDisplayMedia()` takes NO arguments and
    // forwards nothing to native (src/getDisplayMedia.ts), the Android capture size is
    // hardcoded to `DisplayMetrics` in `GetUserMediaImpl.createScreenTrack()`, and
    // `ScreenCaptureController` never overrides `applyConstraints`, so the base class
    // rejects with UnsupportedOperationException. The phone therefore ALWAYS captures
    // its full physical panel (e.g. 1080x2400 = 2.59 MP, portrait) at a hardcoded
    // `DEFAULT_FPS = 30`. The user's chosen tier reaches only the ENCODER, never the
    // capturer — so the encoder budget is the one lever we actually have, and wasting
    // any of it is what produced the grain.
    //
    // What was being wasted: with `simulcast: true` (livekit's default, still on for
    // the CAMERA) and no custom screen layers, `computeVideoEncodings` builds
    // `computeDefaultScreenShareSimulcastPresets` — a half-resolution duplicate — and
    // then returns TWO encodings for the screen track. At the founder's 1080p30 on a
    // 1080x2400 panel that is:
    //     q  540x1200 @ 1.125 Mbps  (4.5 Mbps / 2^2)
    //     h 1080x2400 @ 4.500 Mbps
    //   = 5.625 Mbps asked for, to deliver a 4.5 Mbps picture.
    // So the tier's own ceiling was overshot by 25% by a layer nobody watches, and the
    // phone paid ~25% extra encoder pixel throughput (3.24 MP/frame vs 2.59) for it.
    // Under congestion GCC feeds the base layer first, starving the full layer; under
    // CPU pressure `maintain-framerate` (the engine's screen-share degradation
    // preference) sheds RESOLUTION to keep 30fps. "Smooth but grainy" is the exact
    // signature of both, and both were being driven by the duplicate layer.
    //
    // `screenShareSimulcastLayers: []` collapses that to ONE encoding at
    // scaleResolutionDownBy 1 with the full tier bitrate. Verified in the installed
    // livekit-client: `sortPresets([])` returns `[]` (not undefined), so the
    // `presets.length > 0` branch is skipped and `computeVideoEncodings` falls through
    // to `encodingsFromPresets(w, h, [original])` — the SDK's own unit test
    // "returns one encoding if an empty array is provided for custom screen share
    // layers" pins exactly this. publishDefaults is spread-MERGED over the SDK
    // defaults in the Room constructor, so mic settings (audioPreset music, dtx, red,
    // stopMicTrackOnMute: false) and CAMERA simulcast are untouched — this key only
    // reaches screen-share tracks.
    //
    // Deliberately NOT changed here: `videoCodec`. Desktop publishes VP9, and the
    // bitrate table is calibrated for it, but most Android SoCs have no VP9 *encode*
    // hardware — software-encoding 2.59 MP at 30fps would raise CPU pressure, and with
    // `maintain-framerate` that is paid for in shed resolution, i.e. MORE grain. Mobile
    // stays on VP8 until a real device `getStats` run shows an encoder that holds it.
    publishDefaults: { screenShareSimulcastLayers: [] },
    // Capture FLOOR for the default ("auto") camera tier. The engine passes no
    // captureOptions for "auto", so livekit falls back to this — and on React
    // Native the raw react-native-webrtc default can pick a much lower camera
    // format, which is why the mobile self-view (and what peers received) looked
    // soft. Pin an explicit 720p@30 so "auto" captures a solid HD on the phone,
    // deterministically. Explicit HD/FHD tiers still override this per-publish
    // (the engine hands their resolution to setCameraEnabled). Desktop is
    // untouched — it uses its own web room factory, whose default already lands
    // on 720p. Shared constant → one source of truth (see video-settings.ts).
    videoCaptureDefaults: { resolution: MOBILE_CAMERA_CAPTURE_DEFAULT },
  };
  const room = new Room(options);
  return new LiveKitMobileRoom(room);
}
