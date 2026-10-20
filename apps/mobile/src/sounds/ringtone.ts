/**
 * Call ringtone (ADR 0012 Wave 6, mobile) — incoming ring + outgoing ringback.
 *
 * The mobile mirror of the desktop renderer's sounds/ringtone.ts. Both clients
 * loop the SAME generated ring audio (scripts/gen-sounds.mjs — desktop gets it as
 * Ogg, mobile as WAV), driven here by `expo-audio` — the SAME player stack the one-shot
 * UI cues already ship on (sound-manager.ts), so this adds NO native module and
 * rides OTA to the installed APK (runtimeVersion is pinned — CLAUDE.md §33).
 *
 * The assets are FULL cadence periods (beep(s) at the start, silence padding the
 * rest), so `player.loop = true` reproduces the cadence seamlessly:
 *   - incoming: C5+G5 double pair, 2.6 s period
 *   - outgoing: A4 ringback (two taps), 3.4 s period
 *
 * It honors the shared sound settings (master switch + volume), so muting the app
 * silences the ring too — exactly like desktop and the one-shot cues.
 *
 * Imperative, never in React state (CLAUDE.md §27); fire-and-forget, never throws.
 * A dedicated player per kind, created lazily and reused, so start/stop is instant.
 */
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { ensureAudioMode } from "./sound-manager";
import { useSoundSettings } from "./sound-settings";

type RingKind = "incoming" | "outgoing";

// `require()` is the canonical expo-audio way to reference a bundled asset; WAV
// is in Metro's default assetExts (unlike ogg) and decodes on both platforms.
/* eslint-disable @typescript-eslint/no-require-imports */
const RING_SOURCES: Record<RingKind, number> = {
  incoming: require("../../assets/sounds/ring-incoming.wav"),
  outgoing: require("../../assets/sounds/ring-outgoing.wav"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

const players = new Map<RingKind, AudioPlayer>();
let activeKind: RingKind | null = null;

/** Effective ring level from the persisted sound settings (0 when muted). */
function ringVolume(): number {
  const { enabled, volume } = useSoundSettings.getState();
  return enabled ? volume : 0;
}

function getPlayer(kind: RingKind): AudioPlayer {
  let player = players.get(kind);
  if (!player) {
    player = createAudioPlayer(RING_SOURCES[kind]);
    player.loop = true;
    players.set(kind, player);
  }
  return player;
}

async function startNow(kind: RingKind, volume: number): Promise<void> {
  try {
    await ensureAudioMode();
    const player = getPlayer(kind);
    player.volume = volume;
    // Rewind so a re-started ring plays from the top (a previous stop leaves the
    // position wherever it paused).
    await player.seekTo(0);
    player.play();
  } catch (err) {
    // Device/route/decoding issues — log once, never crash a call.
    console.warn(`[ringtone] "${kind}" playback failed`, err);
  }
}

/**
 * Start (or switch to) the looping ring for a kind. Idempotent for the same kind.
 * Silent when the user has muted UI sounds. Fire-and-forget: gating runs
 * synchronously; native playback is dispatched async and its failures swallowed.
 */
export function startRingtone(kind: RingKind): void {
  if (activeKind === kind) return;
  stopRingtone();
  const volume = ringVolume();
  if (volume <= 0) return; // muted → stay silent (no active ring to leak)
  activeKind = kind;
  void startNow(kind, volume);
}

/** Stop any ring (safe to call when nothing is playing — no leak). */
export function stopRingtone(): void {
  const kind = activeKind;
  activeKind = null;
  if (!kind) return;
  const player = players.get(kind);
  if (!player) return;
  try {
    player.pause();
  } catch (err) {
    console.warn(`[ringtone] stop failed`, err);
  }
}
