# Media Architecture

## LiveKit

Voice rooms, screen sharing, participant tracks, reconnect handling, and room token management
go through **LiveKit** (see ADR 0001). It gives us an SFU, client SDKs, device handling, and
reconnect logic out of the box. mediasoup stays on the table only if we later need deeper custom
media control. Media bytes never touch the WebSocket gateway (see realtime.md).

Flow: client asks `apps/api` for a room token → connects to LiveKit → publishes mic/screen
tracks. Voice *metadata* (joined/left/muted) is broadcast over the WebSocket for UI state.

## Voice state machine

Voice state is a finite state machine: the model lives in `packages/media/src/state.ts` and the
engine that owns every transition in `packages/media/src/engine.ts`. Never scattered React
booleans. UI components only read from it; commands (`join`, `leave`, `setMic`, `setDeafened`,
`startScreenShare`, …) drive transitions. The engine is framework- and LiveKit-free — the
`VoiceRoomAdapter` is injected, so the same FSM runs on desktop (via `@demli/media/web`) and
mobile (via `@livekit/react-native`).

States (`VoiceStatus`): `idle`, `joining`, `connected`, `reconnecting`, `error`, `leaving`.
Mute/deafen/screen-share are flags on the state, not statuses.

```ts
interface VoiceState {
  roomId: string | null;
  status: VoiceStatus;
  micEnabled: boolean;
  deafened: boolean;
  screenShareEnabled: boolean;
  screenShareHasAudio: boolean; // true while a system/loopback audio track is published
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  participants: VoiceParticipant[];
  error: VoiceError | null; // cleared on next successful transition
}
```

`VoiceError` kinds: `permission_denied`, `device_not_found`, `device_unavailable`,
`track_ended_unexpectedly`, `reconnect_failed`, `server_unavailable`.

## Lifecycle events that MUST be handled

Every one of these has a defined transition and a user-friendly error where relevant
(CLAUDE.md §11/§26). No silent failures.

- User joins voice room (`idle → joining → connected`)
- User leaves voice room (`connected → leaving → idle`)
- User mutes/unmutes mic
- User deafens/undeafens
- User changes input device
- User changes output device (if supported)
- Network drops (`connected → reconnecting`)
- Reconnect starts / succeeds (`→ connected`) / fails (`→ error: reconnect_failed`)
- Screen share starts / stops
- Permission denied (mic or screen → `error: permission_denied`)
- Device not found (`error: device_not_found`)
- Track ended unexpectedly (mic or screen → recover or surface `track_ended_unexpectedly`)

## Screen share

Screen sharing is implemented — desktop can share, desktop and mobile can watch.

- **Assets.** `ScreenShareAssets` is a screen-share video track plus an optional system/loopback
  audio track (the film's sound). `VoiceState.screenShareHasAudio` reflects whether that audio
  track is actually published; loopback capture is Windows-only and falls back to video-only.
- **Platform-agnostic acquire seam.** The engine never captures a screen itself. It publishes
  tracks handed to it by a caller-injected `AcquireScreenShare` callback (`startScreenShare`),
  so acquire failures map to the same typed §26 errors on every platform. The desktop renderer's
  `acquire` uses the Electron capture bridge + `getDisplayMedia` (with loopback system audio);
  publishing from mobile is out of scope today — the phone is the watcher.
- **Publish profile (#113).** The system-audio track is published with the MUSIC profile —
  256 kbps stereo, DTX off, RED on (`SCREEN_SHARE_AUDIO_PUBLISH` in `audio-settings.ts`) —
  never LiveKit's speech defaults (~48 kbps mono + DTX), which collapse a film's stereo mix
  and gate quiet passages to silence. The user's own mic quality setting does not affect it.
- **Remote rendering.** Remote screen shares are exposed imperatively, not as reactive state (a
  media track is not React state — §27): `engine.getScreenShares()` + `subscribeScreenShares()`.
  Desktop attaches the track to a `<video>` via `track.attach(el)` (required by LiveKit
  `adaptiveStream`); mobile renders it with `@livekit/react-native`'s `<VideoTrack>`. Screen-share
  audio auto-plays through LiveKit's managed remote-audio path on both.

## Echo chain (why echo happens and where we cancel it)

Echo you HEAR is generated on the FAR end, not yours: the other person's speaker plays your
voice, their microphone re-captures it, and it loops back to you. So "I hear an echo" means the
FAR end's acoustic echo canceller (AEC) failed to subtract what its own speaker was playing from
its own mic. AEC is a CAPTURE-side (sender-side) job. Two absolute rules follow, and they are
enforced in `packages/media/src/audio-settings.ts`:

- **AEC is on in every mode.** `effectiveAudioProcessing` forces `echoCancellation: true` even in
  Müzik Modu (which only relaxes noise suppression + auto-gain). Nothing coming out of a speaker
  may be allowed back into the room.
- **AEC runs BEFORE the RNNoise worklet.** The "Yüksek" noise filter processes the already-AEC'd
  getUserMedia track (`echoCancellation` is a capture constraint; the worklet sits after capture),
  so noise suppression never disturbs the echo canceller's reference alignment.

### Desktop (Electron / Chromium) — the `setSinkId` AEC-reference decoupling

Chromium's software AEC (AEC3) subtracts a REFERENCE of what the speaker is playing from the mic
signal. That reference is taken from the **default** audio output's render path. Our output-device
picker routes remote playback to a chosen device with `setSinkId`: `DeviceSettingsForm` →
`engine.setOutputDevice` → `switchActiveDevice("audiooutput", id)` → LiveKit calls `setSinkId` on
the managed remote `<audio>` elements. When that device is **not** the system default, AEC3's
reference no longer matches what the selected speaker actually emits, so the canceller can't remove
it — and the far end hears itself back, even though our capture requested `echoCancellation: true`.

There is no renderer API to re-point Chromium's AEC reference at an arbitrary sink. The honest,
evidence-based conclusion:

- Our side always REQUESTS AEC at capture (verified: `audioCaptureOptionsForSettings` sets
  `echoCancellation` from the effective flags; Müzik Modu keeps it on). That is the JS-side ceiling.
- The residual desktop echo cases are: (a) the local user selected a **non-default** output device
  (AEC reference decoupled), and/or (b) speakers at volume (larger acoustic coupling). Headphones or
  the **system-default** output eliminate both.
- Because the strongest fix is user-side (default output / headphones), this is surfaced as UI
  guidance, not a silent failure — never as a raw error (§26).

### Mobile (React Native) — hardware AEC on the communication route

Android/iOS hardware AEC works when the audio session runs in the communication profile.
`apps/mobile/src/media/livekit-room.ts` `connect()` applies `AndroidAudioTypePresets.communication`
(audioMode `inCommunication`, usage `voiceCommunication`, focus `GAIN`) **before** `room.connect`,
which is the correct and strongest JS-side setting for hardware AEC. There is no software-AEC
fallback exposed by the installed `@livekit/react-native` stack, so this preset IS the ceiling.

- **Speakerphone weakens hardware AEC** (bigger speaker↔mic coupling + longer delay); the residual
  echo on loudspeaker is fundamental. Headphones remove it.
- **Screen-share / film audio echo.** The film's `screen_share_audio` plays through the SAME
  communication output stream as voice, so it is part of the device's AEC downlink reference and is
  cancelled at each listener's capture like voice is. The movie-night echo that remains is the
  general speakerphone case above (a listener on loudspeaker), not a separate un-referenced path.

### Deeper AEC (native) is a follow-up

A stronger echo canceller than the platform default (aggressive AEC profiles, or a native RNNoise +
AEC module on mobile) needs native work and is tracked with the mobile native noise-filter item
— not solvable from JS/OTA.

## Noise suppression tiers

`Ayarlar → Ses → Gürültü Engelleme` is a three-level tier (`NoiseSuppressionTier`), not an on/off
toggle, resolved in `audio-settings.ts` and applied by the engine:

| Tier | Desktop | Mobile | Capture `noiseSuppression` |
| --- | --- | --- | --- |
| **Yüksek** (Krisp-like) | RNNoise WASM AudioWorklet | not offered (needs native work) | off (worklet does it), **standard as fallback** |
| **Standart** | built-in WebRTC NS | built-in WebRTC NS | on |
| **Kapalı** | none | none | off |

- The `high` tier is a WORKLET, not a capture constraint, so it lives OUTSIDE `AudioProcessing`
  (which stays two 1:1 capture toggles: echo cancellation + auto gain). The desktop renderer owns
  the worklet (`apps/desktop/src/renderer/src/lib/noise-filter.ts`, RNNoise via
  `@sapphi-red/web-noise-suppressor`) and injects a factory into the engine (`createNoiseFilter`);
  `packages/media` only knows the structural `AudioTrackProcessorLike` type, staying RN-safe.
- The worklet is attached to the LIVE mic AFTER publish through `VoiceRoomAdapter.applyNoiseFilter`
  (LiveKit `setProcessor`), **not** through capture options: in livekit-client 2.x the mic track is
  built before its `AudioContext` is set, so a capture-options processor throws "Audio context needs
  to be set" and breaks the mic. The web adapter sets the track's own 48 kHz `AudioContext`, then
  `setProcessor`.
- **Residual wet/dry mix (High cannot mute the voice).** The worklet does NOT publish the raw
  RNNoise output. RNNoise is a per-band ML gate that, on some mics/voices, mis-classifies speech as
  noise and attenuates the whole signal to near-silence — the far end then hears nothing (the
  founder's "High kills my mic" P0, which only surfaced once `'wasm-unsafe-eval'` let the worklet run
  for real). So `noise-filter.ts` sums a WET path (RNNoise) with a small, delay-aligned DRY residual
  of the same AEC'd capture (`source → RNNoise → wetGain` **+** `source → dryDelay → dryGain` →
  destination). The residual (`DRY_GAIN`, ~−15 dB) guarantees speech is always audible while noise is
  still cut by the wet majority; during real speech WET + DRY sum back to roughly unity. `WET_GAIN`
  and `DRY_GAIN` are the two calibration knobs.
- **Graceful degradation.** If the worklet can't run (no factory on mobile, or the WASM is blocked),
  `high` degrades to `standard` WebRTC NS, never to "no suppression". On a runtime worklet failure the
  engine latches it broken and re-publishes the mic with the built-in NS back on.
- **Müzik Modu** forces the tier to `off` (an instrument must transmit unfiltered).
- Changing the tier re-applies LIVE mid-call (`republishMicTrack` + `syncNoiseFilter`) — no rejoin.

### CSP requirement for the desktop `high` tier

RNNoise instantiates WebAssembly, which Chromium blocks unless the renderer `script-src` includes
`'wasm-unsafe-eval'`. That directive is present in the renderer CSP (`electron.vite.config.ts`,
`CSP_BASE`), so the worklet runs for real on desktop. Were it ever removed, the `high` tier would
degrade to `standard` at runtime (safe, but not Krisp-quality) rather than break the mic.

## Self-monitoring — "Kendini dinle" (`mic-monitor.ts` / `mic-monitor-web.ts`)

The feature exists so the noise-suppression tier above can be judged BY EAR: the user must hear
their mic the way the far end receives it, not the raw capture. So the monitor is built from the
same resolvers the publish uses — `audioCaptureOptionsForSettings(settings, { noiseFilterAvailable })`
for the constraints and the same injected `createNoiseFilter` factory for the worklet — and plays
the processor's `processedTrack`. A monitor that played the raw mic would make the tier selector
lie, which is worse than not shipping it.

**Why a parallel chain rather than a tap on the published track.** Inside a room, monitoring
force-mutes the mic (below), and livekit's mute disables the underlying capture — so the published
track carries digital silence by design. The monitor therefore owns its own `getUserMedia` +
processor instance. Same configuration, separate instance. Outside a room there is no published
track at all, which is the primary use case (sitting in Ayarlar comparing Yüksek against Standart).

**Anti-feedback policy (founder requirement).** Monitoring plays your mic out of your speakers; in
a room that is a loop. Turning it on while in a session therefore mutes the mic and deafens FIRST,
then opens the monitor; turning it off restores exactly the prior state — an already-muted or
already-deafened user is left as they were. That decision is two pure functions
(`monitorSuppressionPlan` / `monitorRestorePlan`, unit-tested in `__tests__/mic-monitor.test.ts`)
that the engine merely executes, so the state lives in the FSM (`VoiceState.selfMonitoring`) and
never in scattered React booleans. A deliberate unmute/undeafen while monitoring ENDS monitoring
and discards the snapshot — the user's explicit choice wins.

**Lifecycle.** The monitor holds a live capture track, so it is stopped on leave, on an unexpected
disconnect, and on dispose; it is re-armed (not re-created) on an input-device, output-device or
audio-settings change, so flipping the tier is audible immediately. A failed re-arm stops
monitoring rather than leaving a stale chain playing (which would misreport the tier).

**Headphones.** On speakers the capture's AEC chews on the monitored loop, so the user hears a
gated version of themselves. The settings copy says so; nothing in code can fix it.

Mobile has no monitor: RN has neither an AudioWorklet nor an `<audio>` sink, so a native audio path
is required. `createMicMonitor` is simply not injected there and `setSelfMonitoring(true)` rejects
with a typed `monitor_unavailable` (§26) instead of pretending.

## Video codec + publisher-uplink adaptation

- **VP9 for all published video.** `Room.publishDefaults.videoCodec` is `'vp9'` (camera + screen
  share), with `backupCodec: true` so a subscriber that can't decode VP9 (Safari 12 web floor, old
  clients) transparently gets a VP8 backup stream. VP9 is ~30-50% more efficient than the old VP8
  default and uses SVC (single encode, spatial+temporal layers) that `dynacast`/`adaptiveStream`
  select per-subscriber. The 2K screen-share bitrate ceilings were trimmed to match VP9's efficiency
  (`quality.ts`). One-line revert lever: `VIDEO_CODEC` in `livekit.ts`.
- **Adaptive screen-share tier (anti-bufferbloat).** A high encoder ceiling on a typical asymmetric
  home uplink bufferbloats — the publisher's RTT/ping spikes and GCC never converges, so *everyone*
  sees a stuttering stream. While a share is live the engine watches the connection-quality probe and
  nudges the EFFECTIVE screen-share tier down the bitrate ladder under sustained poor uplink (fast),
  restoring it toward the user's selection under sustained good uplink (slow, hysteretic). It never
  changes the user's SELECTED tier and never drops below `ADAPTIVE_SCREEN_SHARE_FLOOR`; worst case is
  a stable lower-res stream, never a broken share. See the `ADAPTIVE_*` constants in `engine.ts`.
- **Degradation trade (unchanged, deliberately).** Camera stays `balanced` (a face must keep MOVING
  under pressure — `maintain-resolution` once froze mobile cameras, `maintain-framerate` blurs a
  face); screen share stays `maintain-framerate` + `motion` content hint (a shared FILM must stay
  smooth). These are content-specific and must not be unified.

## Rules

- Keep the media lifecycle separate from chat UI.
- Never store media tracks/blobs in React state.
- Speaking indicators must be cheap — don't rerender the whole app per audio level tick.
- Acoustic echo cancellation is on in EVERY mode; the RNNoise worklet always runs AFTER capture AEC.
