/**
 * ANDROID AUDIO PROFILE (task #121) — which Android audio stream the room's remote
 * playout rides on.
 *
 * WebRTC gives a room ONE playout track: every remote sound (each participant's
 * microphone AND the film/system audio a desktop host publishes as
 * `screen_share_audio`) is mixed into it and handed to the OS with a single set of
 * AudioAttributes. Those attributes come from `AudioSession.configureAudio(...)`
 * and are the reason the two choices below feel so different:
 *
 *  - `communication` (DEFAULT, unchanged behaviour) —
 *    audioMode `inCommunication`, stream `voiceCall`, usage `voiceCommunication`,
 *    content `speech`. This is the correct profile for a comms app: the hardware
 *    AEC/NS path is bound to `inCommunication`, Bluetooth mics (SCO) work, and the
 *    OS prioritizes the VoIP focus. The cost is that the shared FILM also plays
 *    through the call stream — lower volume ceiling, speech DSP applied, mono
 *    routing on many devices.
 *
 *  - `media` (OPT-IN) — audioMode `normal`, stream `music`, usage `media`,
 *    content `unknown`. The film gets the media volume slider, no speech DSP, and
 *    A2DP/stereo on Bluetooth. The cost is real and must be stated in the UI:
 *    the hardware echo canceller is tied to `inCommunication`, so speaking on the
 *    LOUDSPEAKER can echo, and Bluetooth microphone (SCO) capture can break.
 *
 * `configureAudio` must run BEFORE `Room.connect()` and the RN SDK exposes no
 * live switch, so the selection applies at the NEXT connect — the UI says so
 * rather than pretending it is instant (CLAUDE.md §35).
 *
 * This module holds the pure model (type + default + normalizer), the preset
 * mapping, and the ACTIVE value the room adapter reads at connect time. The value
 * is pushed here by the persisted settings store (see stores/media-settings.ts) so
 * `media/` never imports app stores. JS-only — no new native module, OTA-safe.
 */
import { AndroidAudioTypePresets, type AndroidAudioTypeOptions } from "@livekit/react-native";

/** The user-selectable audio profiles. `communication` is the shipped default. */
export const ANDROID_AUDIO_PROFILES = ["communication", "media"] as const;

export type AndroidAudioProfile = (typeof ANDROID_AUDIO_PROFILES)[number];

/**
 * The default MUST stay `communication`: it is the behaviour every existing
 * install already has, and the only one with hardware AEC + Bluetooth mic
 * guarantees. `media` is strictly opt-in.
 */
export const DEFAULT_ANDROID_AUDIO_PROFILE: AndroidAudioProfile = "communication";

/** Coerce an untrusted persisted/incoming value to a valid profile. */
export function normalizeAndroidAudioProfile(value: unknown): AndroidAudioProfile {
  return ANDROID_AUDIO_PROFILES.includes(value as AndroidAudioProfile)
    ? (value as AndroidAudioProfile)
    : DEFAULT_ANDROID_AUDIO_PROFILE;
}

/**
 * Map a profile to the `AndroidAudioTypeOptions` handed to
 * `AudioSession.configureAudio`.
 *
 * `communication` returns the SDK preset UNTOUCHED — the default path must stay
 * byte-identical to what shipped before this setting existed.
 *
 * `media` adds `forceHandleAudioRouting: true` on top of the SDK preset. LiveKit
 * disables its Android audio routing whenever `audioMode` is not
 * `inCommunication`/`inCall`, and the media preset sets `normal` — without this
 * flag the in-call output picker (speaker / earpiece / headset / bluetooth, which
 * routes through `AudioSession.selectAudioOutput`) would silently stop working,
 * i.e. become a dead button (§35).
 */
export function androidAudioTypeOptionsFor(
  profile: AndroidAudioProfile,
): AndroidAudioTypeOptions {
  if (profile === "media") {
    return { ...AndroidAudioTypePresets.media, forceHandleAudioRouting: true };
  }
  return AndroidAudioTypePresets.communication;
}

// ---------------------------------------------------------------------------
// Active selection
//
// `livekit-room.ts` reads this synchronously inside `connect()`. The persisted
// settings store pushes into it at load and on every change (including the async
// SecureStore rehydration), which keeps `media/` free of store imports and mirrors
// how the voice store pushes media settings into the shared engine.
// ---------------------------------------------------------------------------

let activeAudioProfile: AndroidAudioProfile = DEFAULT_ANDROID_AUDIO_PROFILE;

/** Set the profile the NEXT `connect()` will configure. Never applies live. */
export function setActiveAudioProfile(profile: AndroidAudioProfile): void {
  activeAudioProfile = normalizeAndroidAudioProfile(profile);
}

/** The profile the next `connect()` will configure. */
export function getActiveAudioProfile(): AndroidAudioProfile {
  return activeAudioProfile;
}
