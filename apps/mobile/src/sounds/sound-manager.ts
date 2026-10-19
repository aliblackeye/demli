/**
 * UI sound effects — playback core. Mobile mirror of the desktop renderer's
 * sounds/sound-manager.ts, rebuilt on `expo-audio` (already baked into the
 * shipped APK — no new native module, so this whole feature ships over OTA).
 *
 * Real audio files — the SAME nine cues the desktop bundles, synthesized by
 * `scripts/gen-sounds.mjs` into `assets/sounds/*.ogg` and pulled in with
 * `require()` so Metro bundles them (one brand sound family across both clients).
 *
 * Design (kept identical to desktop so the two clients behave the same):
 * - One lazily created `AudioPlayer` per sound, reused across plays (never in
 *   React state — CLAUDE.md §27). `createAudioPlayer` (not the `useAudioPlayer`
 *   hook) is used because this is a plain module, not a component.
 * - Every `playSound()` re-reads the persisted settings, so toggles apply
 *   immediately without any extra wiring.
 * - A per-sound ~100ms throttle stops the same cue from stuttering when a burst
 *   of store updates fires it repeatedly.
 * - Playback failures are caught and logged — a sound must never crash the app.
 *
 * Audio focus / mixing (CRITICAL — must not disturb the LiveKit VoIP session):
 * expo-audio's `interruptionMode: 'mixWithOthers'` requests NO audio focus on
 * Android, so a UI beep plays ALONGSIDE the ongoing call instead of ducking or
 * pausing it. That is also the documented default, but we set it explicitly
 * (once, Android-only) so we never depend on the ambient default. iOS is left
 * untouched: the LiveKit `AudioSession` owns the AVAudioSession there, ogg does
 * not decode on iOS anyway (see the mobile-sounds report), and calling
 * `setAudioModeAsync` on iOS could re-categorize the shared session out from
 * under the mic. The VoIP preset in media/livekit-room.ts is never touched.
 */
import { Platform } from "react-native";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { runAudioModeChange } from "./audio-mode-guard";
import { useSoundSettings } from "./sound-settings";

/** Every UI sound cue the app can play (same set + names as desktop). */
export type UiSound =
  | "voice-join"
  | "voice-leave"
  | "peer-join"
  | "peer-leave"
  | "mute"
  | "unmute"
  | "message"
  | "screen-start"
  | "screen-stop";

// `require()` returns an asset module id (number); Metro bundles the .ogg once
// `ogg` is in assetExts (see metro.config.js). Static keys so the bundler can
// see every source at build time. `require()` is the canonical React Native /
// expo-audio way to reference a bundled asset (the docs show
// `useAudioPlayer(require('./sound.mp3'))`), so the ESM-only lint rule is
// disabled just for this asset map.
/* eslint-disable @typescript-eslint/no-require-imports */
const SOUND_SOURCES: Record<UiSound, number> = {
  "voice-join": require("../../assets/sounds/voice-join.ogg"),
  "voice-leave": require("../../assets/sounds/voice-leave.ogg"),
  "peer-join": require("../../assets/sounds/peer-join.ogg"),
  "peer-leave": require("../../assets/sounds/peer-leave.ogg"),
  mute: require("../../assets/sounds/mute.ogg"),
  unmute: require("../../assets/sounds/unmute.ogg"),
  message: require("../../assets/sounds/message.ogg"),
  "screen-start": require("../../assets/sounds/screen-start.ogg"),
  "screen-stop": require("../../assets/sounds/screen-stop.ogg"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** Same cue re-triggered within this window is dropped. */
const THROTTLE_MS = 100;

const players = new Map<UiSound, AudioPlayer>();
const lastPlayedAt = new Map<UiSound, number>();

/**
 * Global cue kill-switch, mirrored from desktop for API parity. Desktop sets it
 * while the local user shares SYSTEM AUDIO so the OS loopback never rebroadcasts
 * our own beeps. Mobile cannot publish a screen share (E2 host shares from
 * desktop; the phone only watches + talks), so this is currently always false —
 * kept so the voice subscriber can stay a faithful mirror and a future
 * mobile-as-host build slots in unchanged.
 */
let suppressed = false;

/** Mute/unmute every UI cue globally (see {@link suppressed}). */
export function setSoundsSuppressed(next: boolean): void {
  suppressed = next;
}

/**
 * Configure expo-audio's mixing mode once, lazily, Android-only (see header).
 * Exported so the call ringtone (ringtone.ts) shares the SAME one-time audio-mode
 * setup — one config path for every expo-audio playback in the app.
 */
let audioModeConfigured = false;
let audioModePending: Promise<void> | null = null;
export function ensureAudioMode(): Promise<void> {
  if (audioModeConfigured) return Promise.resolve();
  // iOS: leave the AVAudioSession to LiveKit (and ogg won't decode there).
  if (Platform.OS !== "android") {
    audioModeConfigured = true;
    return Promise.resolve();
  }
  // On Android setAudioModeAsync rewrites AudioManager.mode + the speakerphone
  // route, so it must never land inside a call (audio-mode-guard). Refused while
  // a call owns the session: the cue plays with the ambient mode (mixWithOthers
  // is expo-audio's default anyway) and the next cue after the call retries.
  audioModePending ??= runAudioModeChange(() =>
    setAudioModeAsync({
      // Mix, never steal focus — the voice call keeps playing under our beeps.
      interruptionMode: "mixWithOthers",
      // Play even when the ringer is silent: a user in a voice room wants the
      // join/leave/mute cues regardless of ringer state (parity with desktop,
      // which has no silent-mode concept).
      playsInSilentMode: true,
      // UI cues are foreground-only; never keep the session alive in background.
      shouldPlayInBackground: false,
    }),
  )
    .then((ran) => {
      if (ran) audioModeConfigured = true;
    })
    .catch((err: unknown) => {
      // Non-fatal — playback still works with the ambient default mode.
      audioModeConfigured = true;
      console.warn("[sounds] audio mode configuration failed", err);
    })
    .finally(() => {
      audioModePending = null;
    });
  return audioModePending;
}

function getPlayer(name: UiSound): AudioPlayer {
  let player = players.get(name);
  if (!player) {
    player = createAudioPlayer(SOUND_SOURCES[name]);
    players.set(name, player);
  }
  return player;
}

/**
 * Warm up the sound subsystem ONCE at app entry, BEFORE the first voice join.
 * Two things, both aimed at the "join/leave cue comes out broken" report:
 *  1. Apply the mixing audio mode now, so `setAudioModeAsync` never fires lazily
 *     during the connect + mic-acquire storm (that first-play race, landing on top
 *     of LiveKit switching Android to the VoIP audio session, is a prime source of
 *     the crackle). After this, {@link ensureAudioMode} is a no-op.
 *  2. Pre-create every player so the first cue plays an already-decoded buffer
 *     instead of cold-decoding an .ogg mid-transition.
 * Idempotent, best-effort — a cue must never crash the app, so failures are
 * swallowed. Called from `voice-sounds.ts` (imported once at app entry).
 */
export function primeSounds(): void {
  void ensureAudioMode();
  for (const name of Object.keys(SOUND_SOURCES) as UiSound[]) {
    try {
      getPlayer(name);
    } catch (err) {
      console.warn(`[sounds] prewarm "${name}" failed`, err);
    }
  }
}

async function playNow(name: UiSound, volume: number): Promise<void> {
  try {
    await ensureAudioMode();
    const player = getPlayer(name);
    player.volume = volume;
    // Rewind before playing so a reused player replays from the start (after a
    // previous play the position sits at the end of the clip).
    await player.seekTo(0);
    player.play();
  } catch (err) {
    // Device/route/decoding issues — log once per failure, never crash.
    console.warn(`[sounds] "${name}" playback failed`, err);
  }
}

/**
 * Play a UI sound cue, honoring the persisted settings (master switch, volume,
 * separate message switch) and the per-sound throttle. Fire-and-forget: the
 * gating + throttle run synchronously; native playback is dispatched async and
 * its failures are swallowed.
 */
export function playSound(name: UiSound): void {
  // Sharing system audio would rebroadcast our cues — stay silent (inert on
  // mobile today; see {@link suppressed}).
  if (suppressed) return;
  const { enabled, volume, messageEnabled } = useSoundSettings.getState();
  if (!enabled || volume <= 0) return;
  if (name === "message" && !messageEnabled) return;

  const now = Date.now();
  const last = lastPlayedAt.get(name);
  if (last !== undefined && now - last < THROTTLE_MS) return;
  lastPlayedAt.set(name, now);

  void playNow(name, volume);
}
