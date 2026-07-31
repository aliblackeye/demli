/**
 * Call ringtone (ADR 0012 Wave 6) — incoming ring + outgoing ringback.
 *
 * The one-shot UI cues (`sound-manager`) ship as short files, but a call ring
 * needs a SUSTAINED, looping tone that starts and stops on demand. Rather than
 * bundle a long loop asset, it is synthesized with the Web Audio API: a small
 * oscillator cadence on an interval — no asset, a seamless loop, and an instant
 * stop. It still honors the shared sound settings (master switch + volume), so
 * muting the app silences the ring too.
 *
 * Imperative, never in React state (CLAUDE.md §27); fire-and-forget, never throws.
 */

import { useSoundSettings } from "./sound-settings";

type RingKind = "incoming" | "outgoing";

/** One shared context, lazily created (and only in a browser/Electron renderer). */
let context: AudioContext | null = null;
let intervalId: number | null = null;
let activeKind: RingKind | null = null;

/** How often a ring pulse repeats, per kind. */
const CADENCE_MS: Record<RingKind, number> = {
  incoming: 2600,
  outgoing: 3400,
};

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") {
    return null;
  }
  if (!context) {
    context = new window.AudioContext();
  }
  return context;
}

/** Effective ring level from the persisted sound settings (0 when muted). */
function ringVolume(): number {
  const { enabled, volume } = useSoundSettings.getState();
  return enabled ? volume : 0;
}

/**
 * Play one ring pulse: incoming is a brighter two-tone chirp, outgoing a softer
 * single ringback tone. Kept gentle (a fraction of the master volume) so it
 * signals without being harsh.
 */
function playPulse(kind: RingKind): void {
  const ctx = audioContext();
  if (!ctx) return;
  const vol = ringVolume();
  if (vol <= 0) return;
  // The context can be suspended if it was created before a user gesture; a
  // resume is harmless once the app has been interacted with (always true by
  // the time a call rings).
  void ctx.resume().catch(() => undefined);

  const now = ctx.currentTime;
  const tones = kind === "incoming" ? [523.25, 659.25] : [440];
  const beepDur = kind === "incoming" ? 0.38 : 0.85;
  const gap = 0.22;
  const peak = 0.14 * vol;

  tones.forEach((freq, i) => {
    const start = now + i * (beepDur + gap);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Short attack/release envelope so each beep is smooth, not clicky.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.04);
    gain.gain.setValueAtTime(peak, start + beepDur - 0.08);
    gain.gain.linearRampToValueAtTime(0, start + beepDur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + beepDur + 0.02);
  });
}

/** Start (or switch) the looping ring. Idempotent for the same kind. */
export function startRingtone(kind: RingKind): void {
  if (activeKind === kind) return;
  stopRingtone();
  activeKind = kind;
  playPulse(kind);
  intervalId = window.setInterval(() => playPulse(kind), CADENCE_MS[kind]);
}

/** Stop the ring (safe to call when nothing is playing). */
export function stopRingtone(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  activeKind = null;
}
