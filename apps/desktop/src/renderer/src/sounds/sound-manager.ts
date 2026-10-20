/**
 * UI sound effects — playback core.
 *
 * Real audio files (no Web Audio synthesis): short cues synthesized by
 * `scripts/gen-sounds.mjs` into one coherent brand sound family ("Koyu Masa"
 * porcelain since 2026-10-20), bundled by Vite
 * as assets (see `docs/product/sound-credits.md`). The mobile client bundles the
 * byte-identical set so the two clients play the same cues.
 *
 * Design:
 * - One lazily created `HTMLAudioElement` per sound, reused across plays
 *   (never stored in React state — CLAUDE.md §27).
 * - Every `play()` re-reads the persisted settings, so toggles apply
 *   immediately without any wiring.
 * - The shared cue gate (`createCueGate`, @demli/client-core — the SAME one
 *   mobile runs) throttles a cue re-fired within ~100ms by a burst of store
 *   updates, and drops a cue that would only repeat what another cue just said
 *   (a peer hang-up is `peer-left-call`, not that plus `call-ended`).
 * - `HTMLAudioElement.play()` rejections (autoplay policy, missing output
 *   device) are caught and logged — a sound must never crash the app.
 */

import { createCueGate } from "@demli/client-core";
import { useSoundSettings } from "./sound-settings";
import voiceJoinUrl from "./assets/voice-join.ogg";
import voiceLeaveUrl from "./assets/voice-leave.ogg";
import peerJoinUrl from "./assets/peer-join.ogg";
import peerLeaveUrl from "./assets/peer-leave.ogg";
import muteUrl from "./assets/mute.ogg";
import unmuteUrl from "./assets/unmute.ogg";
import messageUrl from "./assets/message.ogg";
import screenStartUrl from "./assets/screen-start.ogg";
import screenStopUrl from "./assets/screen-stop.ogg";
import deafenUrl from "./assets/deafen.ogg";
import undeafenUrl from "./assets/undeafen.ogg";
import mentionUrl from "./assets/mention.ogg";
import callConnectedUrl from "./assets/call-connected.ogg";
import callEndedUrl from "./assets/call-ended.ogg";
import peerLeftCallUrl from "./assets/peer-left-call.ogg";
import errorUrl from "./assets/error.ogg";

/** Every UI sound cue the app can play. */
export type UiSound =
  | "voice-join"
  | "voice-leave"
  | "peer-join"
  | "peer-leave"
  | "mute"
  | "unmute"
  | "message"
  | "screen-start"
  | "screen-stop"
  | "deafen"
  | "undeafen"
  | "mention"
  | "call-connected"
  | "call-ended"
  | "peer-left-call"
  | "error";

const SOUND_URLS: Record<UiSound, string> = {
  "voice-join": voiceJoinUrl,
  "voice-leave": voiceLeaveUrl,
  "peer-join": peerJoinUrl,
  "peer-leave": peerLeaveUrl,
  mute: muteUrl,
  unmute: unmuteUrl,
  message: messageUrl,
  "screen-start": screenStartUrl,
  "screen-stop": screenStopUrl,
  deafen: deafenUrl,
  undeafen: undeafenUrl,
  mention: mentionUrl,
  "call-connected": callConnectedUrl,
  "call-ended": callEndedUrl,
  "peer-left-call": peerLeftCallUrl,
  error: errorUrl,
};

/** Cues governed by the separate "message notification" switch. */
const MESSAGE_CUES: ReadonlySet<UiSound> = new Set<UiSound>(["message", "mention"]);

const elements = new Map<UiSound, HTMLAudioElement>();
/** Throttle + cross-cue arbiter, shared with mobile (client-core cue-gate.ts). */
const gate = createCueGate<UiSound>();

/**
 * Global cue kill-switch. Set true while the local user shares SYSTEM AUDIO: the
 * OS loopback capture that feeds that share would otherwise pick up our own UI
 * beeps (mute/join/message…) and broadcast them to the room — the other side
 * hears bleeps over the movie. Driven by the voice lifecycle subscriber
 * (`voice-sounds.ts`), which reads `screenShareEnabled + screenShareHasAudio`
 * from the voice store. Cleared automatically when the share (or its audio)
 * stops. Keeps the media store sound-free (CLAUDE.md §23).
 */
let suppressed = false;

/** Mute/unmute every UI cue globally (see {@link suppressed}). */
export function setSoundsSuppressed(next: boolean): void {
  suppressed = next;
}

function getElement(name: UiSound): HTMLAudioElement {
  let el = elements.get(name);
  if (!el) {
    el = new Audio(SOUND_URLS[name]);
    el.preload = "auto";
    elements.set(name, el);
  }
  return el;
}

/**
 * Play a UI sound cue, honoring the persisted settings (master switch,
 * volume, separate message-notification switch) and the per-sound throttle.
 * Fire-and-forget: failures are logged, never thrown.
 */
export function playSound(name: UiSound): void {
  // Sharing system audio: stay silent so the loopback never broadcasts our cues.
  if (suppressed) return;
  const { enabled, volume, messageEnabled } = useSoundSettings.getState();
  if (!enabled || volume <= 0) return;
  if (MESSAGE_CUES.has(name) && !messageEnabled) return;

  if (!gate.admit(name, Date.now())) return;

  const el = getElement(name);
  el.volume = volume;
  el.currentTime = 0;
  el.play().catch((err: unknown) => {
    // Autoplay policy or device issues — log once per failure, never crash.
    console.warn(`[sounds] "${name}" playback failed`, err);
  });
}
