#!/usr/bin/env node
// @ts-check
/**
 * Demli UI sound generator (reproducible, original, license-free).
 *
 * Everything is synthesized from scratch in this file — no third-party samples,
 * no downloads — so the repo can go open source without a single audio licence
 * to audit (docs/product/sound-credits.md).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN (second round)
 * ---------------------------------------------------------------------------
 * The previous generator produced enveloped SINE tones with two faint harmonics
 * and four slapback echoes. Measured on the shipped assets, that design read as
 * "cheap beep" for reasons that are visible in numbers, not opinions:
 *
 *   - 1-4 spectral peaks per cue (a struck object has 8-20+). WARM=[1,.16,.06]
 *     puts partial 2 at -16 dB and partial 3 at -24 dB: inaudible. It is a sine.
 *   - Spectral centroid 234-1570 Hz, 85% rolloff <= 1570 Hz, and 0.0-1.3% of the
 *     energy above 3 kHz. No air, no "ping" — the band that reads as crisp is
 *     simply empty.
 *   - <300 Hz energy = 0.1% on every cue but `mute` (92%, a lone dull A3 hum).
 *     Nothing has body: no weight under the transient.
 *   - No percussive transient at all. A smoothstep attack on a sine is "an
 *     oscillator turned on", not "something was struck".
 *   - One global exponential decay for the whole spectrum. Real struck objects
 *     lose highs first; uniform decay is the synthesizer giveaway.
 *   - Crest factor 9.8-11.0 dB on ALL nine cues — every sound is the same KIND
 *     of sound (sustained tone). Percussion sits at 15-20 dB.
 *   - Peak-normalizing every cue to the same ceiling flattened the loudness
 *     hierarchy: `message` ended up only 2 dB under `screen-start`.
 *   - The "reverb" was 4 taps at 17/29/41/57 ms — flutter-range slapback, i.e. a
 *     metallic comb filter, not a room.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACES IT
 * ---------------------------------------------------------------------------
 * Physical-ish MODAL synthesis, the way an actual UI sound designer builds a cue:
 *
 *   strike   a few ms of band-limited noise = the mallet/finger hitting the object
 *   modes    an INHARMONIC partial stack (marimba 1:3.9:9.4, glass 1:2.76:5.4:8.9,
 *            wood 1:2.57:4.95) with PER-PARTIAL decay — highs die first
 *   body     a short low sine under the hit so the cue has weight
 *   room     a real Schroeder reverb (4 combs + 2 allpasses, damped feedback),
 *            RT60 ~ 0.3 s, mixed faint — depth, never an echo
 *   level    normalized by LOUDNESS (max 50 ms sliding RMS), not by peak, so the
 *            intended hierarchy survives: message << voice-join << ring
 *
 * Three complete FAMILIES ship in this file so the timbre is a founder choice,
 * not an agent's guess. The MOTIFS (which notes, which direction) are shared —
 * only the timbre changes, so semantics stay identical whichever is picked:
 *
 *   marimba  "Sicak Marimba"  rosewood bar, soft mallet, warm low-mid, organic
 *   glass    "Yumusak Cam"    struck glass/bell, bright tink, airy shimmer
 *   felt     "Kece Tahta"     muted tongue-drum + breath layer, dark, calm
 *   legacy   the previous sine design, kept so the CURRENTLY COMMITTED assets
 *            stay reproducible from this script until a new family is chosen
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/gen-sounds.mjs                 write ACTIVE_FAMILY to both clients
 *   node scripts/gen-sounds.mjs --family=glass  write that family instead
 *   node scripts/gen-sounds.mjs --preview       write ALL families + an HTML
 *                                               player to build/sound-previews/
 *                                               (gitignored) and touch nothing else
 *
 * Deps: none (pure Node PCM synthesis). Optional: ffmpeg on PATH for Ogg encode.
 */
/* global console, Buffer */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SR = 48000; // 48 kHz — matches LiveKit/WebRTC playout and modern devices.

const DESKTOP_DIR = "apps/desktop/src/renderer/src/sounds/assets";
const MOBILE_DIR = "apps/mobile/assets/sounds";
const PREVIEW_DIR = "build/sound-previews";

/**
 * The family written to the shipping asset directories by a plain run.
 *
 * MUST match what is committed under the asset directories. A `--family=` run
 * rewrites the assets but NOT this constant, so leaving the two out of step
 * means the next plain `node scripts/gen-sounds.mjs` quietly reverts every
 * shipped sound to whatever this line says. That is a regression with no diff to
 * review and no test to catch it — it happened once, on the very run that
 * shipped this family.
 *
 * "felt" since 2026-07-29 — the founder listened to all four and picked it.
 *
 * The set it replaces measured as one texture wearing nine names: pure sine, 1-4
 * spectral peaks per frame, nothing above 3 kHz, no transient, every cue at the
 * same ~10 dB crest. Felt is the darkest of the three candidates (centroid
 * 665-1041 Hz, only 3-8% above 3 kHz), which is the whole point of picking it: a
 * cue heard two hundred times a day should sit under the conversation rather
 * than cut through it. I had recommended marimba on the theory that felt would
 * be lost in a noisy room; the founder's ear on his own hardware beats my
 * spectrum table.
 *
 * To switch: run `--family=<id>` AND change this line in the same commit.
 */
const ACTIVE_FAMILY = "felt";

// Note frequencies (equal temperament, A4 = 440).
const NOTE = {
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.0,
  D6: 1174.66,
};

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a tiny seeded PRNG. Every noise source in this file is seeded, so
 * two runs on two machines produce identical audio (the whole point of keeping
 * the generator, rather than the samples, as the source of truth).
 *
 * @param {number} seed
 * @returns {() => number} uniform in [0,1)
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Filters (one-pole, in-place on a scratch array)
// ---------------------------------------------------------------------------

/** One-pole low-pass coefficient for a cutoff in Hz. */
function lpAlpha(hz) {
  const x = Math.exp((-2 * Math.PI * hz) / SR);
  return 1 - x;
}

/**
 * Low-pass, in place. `poles` cascades one-pole sections: 1 pole is -6 dB/oct,
 * which is far too gentle to actually DARKEN a noise burst (the old design's
 * only filter was a single pole, and it is why every "dull" cue still leaked
 * high end). 2-3 poles is what separates the bright family from the dark one.
 *
 * @param {Float32Array} buf
 * @param {number} hz
 * @param {number} [poles]
 */
function lowPass(buf, hz, poles = 1) {
  const a = lpAlpha(hz);
  for (let p = 0; p < poles; p++) {
    let prev = 0;
    for (let i = 0; i < buf.length; i++) {
      prev += a * (buf[i] - prev);
      buf[i] = prev;
    }
  }
}

/**
 * High-pass (input minus its low-passed self), in place. See {@link lowPass}
 * for why `poles` matters.
 *
 * @param {Float32Array} buf
 * @param {number} hz
 * @param {number} [poles]
 */
function highPass(buf, hz, poles = 1) {
  const a = lpAlpha(hz);
  for (let p = 0; p < poles; p++) {
    let prev = 0;
    for (let i = 0; i < buf.length; i++) {
      prev += a * (buf[i] - prev);
      buf[i] -= prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Synthesis primitives
// ---------------------------------------------------------------------------

/**
 * The mallet/finger hitting the object: a few ms of band-limited noise with a
 * very fast exponential decay. This is the single biggest reason the new cues
 * read as "struck" rather than "beeped" — the ear identifies a physical event
 * from its onset transient, not from its steady tone.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, peak:number, decayMs:number, lowHz:number,
 *           highHz:number, poles?:number, seed:number }} spec
 */
function addStrike(buf, spec) {
  const tau = spec.decayMs / 1000 / 3; // ~decayMs to -26 dB
  const n = Math.min(buf.length, Math.ceil(tau * 6 * SR));
  if (n <= 1) return;
  const poles = spec.poles ?? 2;
  const rng = makeRng(spec.seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rng() * 2 - 1;
  lowPass(noise, spec.highHz, poles);
  highPass(noise, spec.lowHz, poles);

  // Re-normalize: the two one-poles cost a lot of level, and how much depends on
  // the band, so a fixed make-up gain would make one family's strike vanish.
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(noise[i]));
  if (p === 0) return;
  const g = spec.peak / p;

  const n0 = Math.floor(spec.start * SR);
  const tauSamples = Math.max(1, tau * SR);
  for (let i = 0; i < n; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    // 0.4 ms raised-cosine lead-in: even a transient must not start on a step,
    // or the "click" becomes a DIGITAL click (aliasing), which is the exact
    // cheapness we are removing.
    const lead = Math.max(1, Math.floor(0.0004 * SR));
    const inGain = i < lead ? 0.5 - 0.5 * Math.cos((Math.PI * i) / lead) : 1;
    buf[idx] += noise[i] * g * inGain * Math.exp(-i / tauSamples);
  }
}

/**
 * A struck object's resonance: an INHARMONIC stack of decaying sinusoids.
 *
 * `partials` is the object's identity — a marimba bar, a glass, a wood block all
 * differ by their ratio/gain/decay triples, not by their fundamental. Each
 * partial gets its OWN decay (`decayScale`), so highs die first exactly as they
 * do physically; that frequency-dependent decay is what a single global envelope
 * on a sine can never fake.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, freq:number, peak:number, decaySec:number,
 *           partials:{ ratio:number, gain:number, decayScale:number }[],
 *           detune?:number, seed?:number }} spec
 */
function addModes(buf, spec) {
  const detune = spec.detune ?? 0;
  const rng = makeRng(spec.seed ?? 1);
  const n0 = Math.floor(spec.start * SR);
  // 1.5 ms attack — fast enough to read as a strike, slow enough not to click.
  const nAttack = Math.max(1, Math.floor(0.0015 * SR));

  let gainSum = 0;
  for (const p of spec.partials) gainSum += p.gain;
  const norm = gainSum > 0 ? 1 / gainSum : 1;

  for (const p of spec.partials) {
    // A tiny deterministic detune per partial: real objects are never exactly
    // in ratio, and the beating that results is a big part of "organic".
    const cents = detune * (rng() * 2 - 1);
    const freq = spec.freq * p.ratio * Math.pow(2, cents / 1200);
    if (freq >= SR / 2) continue;
    const tauSamples = Math.max(1, spec.decaySec * p.decayScale * SR);
    const nLen = Math.min(buf.length - n0, Math.ceil(tauSamples * 7));
    if (nLen <= 0) continue;
    const w = (2 * Math.PI * freq) / SR;
    const amp = spec.peak * p.gain * norm;
    const phase = rng() * Math.PI * 2;
    for (let i = 0; i < nLen; i++) {
      const idx = n0 + i;
      if (idx >= buf.length) break;
      const env =
        (i < nAttack ? i / nAttack : 1) * Math.exp(-i / tauSamples);
      buf[idx] += Math.sin(w * i + phase) * env * amp;
    }
  }
}

/**
 * Weight under the hit: a short low sine. Low enough to be felt rather than
 * heard as a note, fast enough that it never booms. Without this the cue is all
 * midrange, which is the "tinny/cheap" half of the old design.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, freq:number, peak:number, decaySec:number }} spec
 */
function addBody(buf, spec) {
  const n0 = Math.floor(spec.start * SR);
  const tauSamples = Math.max(1, spec.decaySec * SR);
  const nLen = Math.min(buf.length - n0, Math.ceil(tauSamples * 7));
  const w = (2 * Math.PI * spec.freq) / SR;
  const nAttack = Math.max(1, Math.floor(0.002 * SR));
  for (let i = 0; i < nLen; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    const env = (i < nAttack ? i / nAttack : 1) * Math.exp(-i / tauSamples);
    buf[idx] += Math.sin(w * i) * env * spec.peak;
  }
}

/**
 * A soft breath/air layer — filtered noise shaped like the tone's own envelope.
 * Used by the `felt` family to get its cloth-covered, non-electronic character.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, peak:number, decaySec:number, lowHz:number,
 *           highHz:number, poles?:number, seed:number }} spec
 */
function addBreath(buf, spec) {
  const tauSamples = Math.max(1, spec.decaySec * SR);
  const n = Math.min(buf.length, Math.ceil(tauSamples * 5));
  if (n <= 1) return;
  const poles = spec.poles ?? 2;
  const rng = makeRng(spec.seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = rng() * 2 - 1;
  lowPass(noise, spec.highHz, poles);
  highPass(noise, spec.lowHz, poles);
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(noise[i]));
  if (p === 0) return;
  const g = spec.peak / p;
  const n0 = Math.floor(spec.start * SR);
  const nAttack = Math.max(1, Math.floor(0.008 * SR));
  for (let i = 0; i < n; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    const env = (i < nAttack ? i / nAttack : 1) * Math.exp(-i / tauSamples);
    buf[idx] += noise[i] * g * env;
  }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/**
 * Schroeder reverb: 4 parallel damped combs into 2 series allpasses.
 *
 * This replaces the old 4-tap slapback. Discrete taps in the 17-57 ms range are
 * comb filtering, which the ear hears as a metallic ring; a comb+allpass network
 * builds an actually DIFFUSE tail whose echo density grows with time, which the
 * ear hears as a small room. Mixed faint (8-16%), RT60 ~ 0.3 s.
 *
 * @param {Float32Array} buf
 * @param {{ mix?:number, feedback?:number, damp?:number }} [opts]
 */
function addRoom(buf, opts = {}) {
  const mix = opts.mix ?? 0.12;
  if (mix <= 0) return;
  const feedback = opts.feedback ?? 0.6;
  const damp = opts.damp ?? 0.35;

  // Freeverb's 44.1 kHz delays, scaled to 48 kHz and kept mutually prime-ish so
  // the combs never line up into a pitched resonance.
  const combs = [1214, 1293, 1391, 1477];
  const allpasses = [605, 481];

  const wet = new Float32Array(buf.length);
  for (const d of combs) {
    const line = new Float32Array(d);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < buf.length; i++) {
      const out = line[idx];
      wet[i] += out;
      store = out * (1 - damp) + store * damp; // damped feedback = highs die first
      line[idx] = buf[i] + store * feedback;
      idx = idx + 1 === d ? 0 : idx + 1;
    }
  }
  for (let i = 0; i < wet.length; i++) wet[i] /= combs.length;

  for (const d of allpasses) {
    const line = new Float32Array(d);
    let idx = 0;
    const g = 0.5;
    for (let i = 0; i < wet.length; i++) {
      const bufOut = line[idx];
      const out = -wet[i] + bufOut;
      line[idx] = wet[i] + bufOut * g;
      idx = idx + 1 === d ? 0 : idx + 1;
      wet[i] = out;
    }
  }

  for (let i = 0; i < buf.length; i++) buf[i] += mix * wet[i];
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

/**
 * Perceived level proxy: the loudest 50 ms of the cue, as RMS.
 *
 * Peak normalization (what the old script did) is the wrong yardstick for a
 * loudness HIERARCHY — a percussive cue and a sustained cue with the same peak
 * differ by ~8 dB in how loud they actually sound, which is why `message` used
 * to arrive nearly as loud as `screen-start`.
 *
 * @param {Float32Array} buf
 * @returns {number} linear RMS
 */
function loudness(buf) {
  const win = Math.min(buf.length, Math.round(0.05 * SR));
  if (win <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += buf[i] * buf[i];
  let best = sum;
  for (let i = win; i < buf.length; i++) {
    sum += buf[i] * buf[i] - buf[i - win] * buf[i - win];
    if (sum > best) best = sum;
  }
  return Math.sqrt(best / win);
}

function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

function dbfs(x) {
  return x <= 0 ? -Infinity : 20 * Math.log10(x);
}

function fromDb(db) {
  return Math.pow(10, db / 20);
}

/**
 * Scale to a loudness target, then pull back if the peak would exceed the
 * ceiling. Never clips: the ceiling is enforced last and is a pure gain, so no
 * limiter distortion is ever introduced.
 *
 * @param {Float32Array} buf
 * @param {number} targetDb  loudness (max-50ms-RMS) target in dBFS
 * @param {number} ceilingDb peak ceiling in dBFS
 */
function normalizeLoudness(buf, targetDb, ceilingDb) {
  const l = loudness(buf);
  if (l > 0) {
    const g = fromDb(targetDb) / l;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  const p = peakOf(buf);
  const ceiling = fromDb(ceilingDb);
  if (p > ceiling) {
    const g = ceiling / p;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
}

/** 2 ms fades at the very start/end so file boundaries are always at zero. */
function fadeEdges(buf, ms = 2) {
  const n = Math.floor((ms / 1000) * SR);
  for (let i = 0; i < n && i < buf.length; i++) {
    const g = i / n;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
}

// ---------------------------------------------------------------------------
// Legacy family (the previous sine design — kept so the committed assets stay
// reproducible from this script until a new family is chosen)
// ---------------------------------------------------------------------------

const LEGACY_WARM = [1, 0.16, 0.06];
const LEGACY_BRIGHT = [1, 0.28, 0.12, 0.05];
const LEGACY_DULL = [1, 0.05];

/**
 * @param {Float32Array} buf
 * @param {{ start:number, dur:number, freq:number, peak?:number, attack?:number,
 *           decay?:number, harmonics?:number[] }} spec
 */
function legacyAddTone(buf, spec) {
  const { start, dur, freq } = spec;
  const peak = spec.peak ?? 0.4;
  const attack = spec.attack ?? 0.006;
  const decay = spec.decay ?? dur * 0.5;
  const harmonics = spec.harmonics ?? LEGACY_WARM;

  const n0 = Math.floor(start * SR);
  const nDur = Math.floor(dur * SR);
  const nAttack = Math.max(1, Math.floor(attack * SR));
  const nRelease = Math.max(1, Math.floor(0.005 * SR));
  const tauSamples = Math.max(1, decay * SR);
  const w = (2 * Math.PI * freq) / SR;
  const hsum = harmonics.reduce((s, h) => s + Math.abs(h), 0) || 1;

  for (let i = 0; i < nDur; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    let env;
    if (i < nAttack) {
      const x = i / nAttack;
      env = x * x * (3 - 2 * x);
    } else {
      env = Math.exp(-(i - nAttack) / tauSamples);
    }
    if (i > nDur - nRelease) env *= (nDur - i) / nRelease;
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      s += harmonics[h] * Math.sin((h + 1) * w * i);
    }
    s /= hsum;
    buf[idx] += s * env * peak;
  }
}

/** @param {Float32Array} buf @param {{ mix?:number }} [opts] */
function legacyAddReverb(buf, opts = {}) {
  const mix = opts.mix ?? 0.22;
  if (mix <= 0) return;
  const taps = [
    [0.017, 0.5],
    [0.029, 0.34],
    [0.041, 0.22],
    [0.057, 0.14],
  ];
  const wet = new Float32Array(buf.length);
  for (const [delaySec, g] of taps) {
    const d = Math.floor(delaySec * SR);
    for (let i = d; i < buf.length; i++) wet[i] += buf[i - d] * g;
  }
  const alpha = 0.35;
  let prev = 0;
  for (let i = 0; i < wet.length; i++) {
    prev = prev + alpha * (wet[i] - prev);
    wet[i] = prev;
  }
  for (let i = 0; i < buf.length; i++) buf[i] += mix * wet[i];
}

/** @param {Float32Array} buf @param {number} targetPeak */
function legacyNormalize(buf, targetPeak) {
  const peak = peakOf(buf);
  if (peak === 0) return;
  const g = targetPeak / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

/**
 * @param {{ lengthSec?:number, lengthSamples?:number, tones:object[], mix?:number,
 *           normPeak?:number }} spec
 * @returns {Float32Array}
 */
function legacyBuildCue(spec) {
  const length = spec.lengthSamples ?? Math.floor((spec.lengthSec ?? 0) * SR);
  const buf = new Float32Array(length);
  for (const t of spec.tones) legacyAddTone(buf, /** @type {any} */ (t));
  legacyAddReverb(buf, { mix: spec.mix });
  legacyNormalize(buf, spec.normPeak ?? 0.42);
  fadeEdges(buf, 2);
  return buf;
}

/** @returns {Record<string, Float32Array>} */
function buildLegacySet() {
  return {
    "voice-join": legacyBuildCue({
      lengthSec: 0.42,
      normPeak: 0.42,
      mix: 0.2,
      tones: [
        { start: 0.0, dur: 0.2, freq: NOTE.C5, peak: 0.4, decay: 0.14 },
        { start: 0.1, dur: 0.26, freq: NOTE.E5, peak: 0.42, decay: 0.18 },
      ],
    }),
    "voice-leave": legacyBuildCue({
      lengthSec: 0.42,
      normPeak: 0.42,
      mix: 0.2,
      tones: [
        { start: 0.0, dur: 0.2, freq: NOTE.E5, peak: 0.4, decay: 0.14 },
        { start: 0.1, dur: 0.26, freq: NOTE.C5, peak: 0.42, decay: 0.18 },
      ],
    }),
    "peer-join": legacyBuildCue({
      lengthSec: 0.3,
      normPeak: 0.3,
      mix: 0.16,
      tones: [
        { start: 0.0, dur: 0.12, freq: NOTE.G4, peak: 0.34, decay: 0.09 },
        { start: 0.06, dur: 0.16, freq: NOTE.C5, peak: 0.4, decay: 0.12 },
      ],
    }),
    "peer-leave": legacyBuildCue({
      lengthSec: 0.3,
      normPeak: 0.3,
      mix: 0.16,
      tones: [
        { start: 0.0, dur: 0.12, freq: NOTE.C5, peak: 0.4, decay: 0.09 },
        { start: 0.06, dur: 0.16, freq: NOTE.G4, peak: 0.34, decay: 0.12 },
      ],
    }),
    mute: legacyBuildCue({
      lengthSec: 0.2,
      normPeak: 0.3,
      mix: 0.1,
      tones: [
        { start: 0.0, dur: 0.13, freq: 220.0, peak: 0.4, decay: 0.07, harmonics: LEGACY_DULL },
      ],
    }),
    unmute: legacyBuildCue({
      lengthSec: 0.22,
      normPeak: 0.4,
      mix: 0.12,
      tones: [
        { start: 0.0, dur: 0.15, freq: NOTE.A4, peak: 0.42, decay: 0.1, harmonics: [1, 0.22, 0.1] },
      ],
    }),
    "screen-start": legacyBuildCue({
      lengthSec: 0.36,
      normPeak: 0.42,
      mix: 0.2,
      tones: [
        { start: 0.0, dur: 0.1, freq: NOTE.C5, peak: 0.34, decay: 0.07, harmonics: LEGACY_BRIGHT },
        { start: 0.06, dur: 0.1, freq: NOTE.E5, peak: 0.38, decay: 0.07, harmonics: LEGACY_BRIGHT },
        { start: 0.12, dur: 0.18, freq: NOTE.G5, peak: 0.42, decay: 0.12, harmonics: LEGACY_BRIGHT },
      ],
    }),
    "screen-stop": legacyBuildCue({
      lengthSec: 0.36,
      normPeak: 0.42,
      mix: 0.2,
      tones: [
        { start: 0.0, dur: 0.1, freq: NOTE.G5, peak: 0.42, decay: 0.07, harmonics: LEGACY_BRIGHT },
        { start: 0.06, dur: 0.1, freq: NOTE.E5, peak: 0.38, decay: 0.07, harmonics: LEGACY_BRIGHT },
        { start: 0.12, dur: 0.18, freq: NOTE.C5, peak: 0.34, decay: 0.12, harmonics: LEGACY_BRIGHT },
      ],
    }),
    message: legacyBuildCue({
      lengthSec: 0.2,
      normPeak: 0.34,
      mix: 0.14,
      tones: [
        { start: 0.0, dur: 0.13, freq: NOTE.D5, peak: 0.4, decay: 0.06 },
        { start: 0.0, dur: 0.05, freq: NOTE.D6, peak: 0.1, decay: 0.03 },
      ],
    }),
  };
}

/** @returns {Record<string, Float32Array>} */
function buildLegacyRings() {
  return {
    "ring-incoming": legacyBuildCue({
      lengthSamples: Math.round(2.6 * SR),
      normPeak: 0.42,
      mix: 0.16,
      tones: [
        { start: 0.0, dur: 0.34, freq: NOTE.C5, peak: 0.4, decay: 0.26 },
        { start: 0.55, dur: 0.34, freq: NOTE.E5, peak: 0.4, decay: 0.26 },
      ],
    }),
    "ring-outgoing": legacyBuildCue({
      lengthSamples: Math.round(3.4 * SR),
      normPeak: 0.38,
      mix: 0.14,
      tones: [{ start: 0.0, dur: 0.85, freq: NOTE.A4, peak: 0.4, decay: 0.55 }],
    }),
  };
}

// ---------------------------------------------------------------------------
// Modal families
// ---------------------------------------------------------------------------

/**
 * A family is an INSTRUMENT: the partial recipe, the strike, the body, the room.
 * The motif catalog below is shared, so switching family swaps the timbre while
 * every cue keeps its meaning and its direction.
 *
 * @typedef {object} Family
 * @property {string} id
 * @property {string} label            founder-facing name
 * @property {string} blurb            one line: what it feels like
 * @property {{ ratio:number, gain:number, decayScale:number }[]} partials
 * @property {number} decaySec         base decay of the fundamental
 * @property {number} detune           cents of deterministic per-partial detune
 * @property {{ peak:number, decayMs:number, lowHz:number, highHz:number, poles:number }} strike
 * @property {{ ratio:number, peak:number, decaySec:number }} body
 * @property {{ peak:number, decaySec:number, lowHz:number, highHz:number, poles:number }|null} breath
 * @property {{ mix:number, feedback:number, damp:number }} room
 */

/** @type {Family[]} */
const FAMILIES = [
  {
    id: "marimba",
    label: "Sıcak Marimba",
    blurb:
      "Gül ağacı marimba çubuğu: yumuşak tokmak vuruşu, sıcak alt-orta gövde, organik ve samimi.",
    // A tuned rosewood bar: partial 2 an octave+fifth-ish above (3.9), partial 3
    // ~9.4. Strongly inharmonic — this ratio set IS what "wooden" means.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 3.93, gain: 0.34, decayScale: 0.42 },
      { ratio: 9.42, gain: 0.13, decayScale: 0.2 },
      { ratio: 15.9, gain: 0.05, decayScale: 0.11 },
      { ratio: 24.2, gain: 0.02, decayScale: 0.07 },
    ],
    decaySec: 0.155,
    detune: 6,
    // Soft mallet: the band sits in the wood range, 2 poles either side so the
    // "click" is a THUD with edge, not a hiss.
    strike: { peak: 0.34, decayMs: 5.5, lowHz: 380, highHz: 3600, poles: 2 },
    body: { ratio: 0.5, peak: 0.2, decaySec: 0.05 },
    breath: null,
    room: { mix: 0.13, feedback: 0.6, damp: 0.4 },
  },
  {
    id: "glass",
    label: "Yumuşak Cam",
    blurb:
      "Vurulmuş ince cam / celesta: kısa parlak 'tink', havadar üst bant, temiz ve pahalı.",
    // Struck-glass / small bell modes. 2.76 and 5.40 are the classic bell ratios
    // — inharmonic enough to shimmer, tuned enough to keep a pitch.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 2.76, gain: 0.5, decayScale: 0.62 },
      { ratio: 5.4, gain: 0.3, decayScale: 0.4 },
      { ratio: 8.93, gain: 0.17, decayScale: 0.27 },
      { ratio: 13.34, gain: 0.09, decayScale: 0.18 },
      { ratio: 18.6, gain: 0.04, decayScale: 0.12 },
    ],
    decaySec: 0.185,
    detune: 4,
    // Fingernail on glass: everything under 2 kHz removed with a 2-pole HP, so
    // the transient is pure "tink" and the body comes only from the modes.
    strike: { peak: 0.26, decayMs: 3.0, lowHz: 2400, highHz: 13000, poles: 2 },
    body: { ratio: 0.5, peak: 0.11, decaySec: 0.035 },
    breath: null,
    room: { mix: 0.16, feedback: 0.64, damp: 0.28 },
  },
  {
    id: "felt",
    label: "Keçe Tahta",
    blurb:
      "Keçe tokmaklı dil davulu + nefes katmanı: koyu, tok, çok kısa — mesai boyunca yormayan.",
    // Tongue-drum / wood-block modes: few partials, all dying fast. The breath
    // layer is what keeps it from sounding electronic despite the dark spectrum.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 2.57, gain: 0.26, decayScale: 0.34 },
      { ratio: 4.95, gain: 0.1, decayScale: 0.2 },
      { ratio: 7.2, gain: 0.04, decayScale: 0.13 },
    ],
    decaySec: 0.115,
    detune: 9,
    // Felt beater: 3 poles of low-pass at 1.4 kHz. This is the family's whole
    // identity — a genuinely DARK transient, which a single pole cannot make.
    strike: { peak: 0.34, decayMs: 7.0, lowHz: 190, highHz: 1400, poles: 3 },
    body: { ratio: 0.5, peak: 0.26, decaySec: 0.06 },
    breath: { peak: 0.07, decaySec: 0.055, lowHz: 420, highHz: 1900, poles: 3 },
    room: { mix: 0.1, feedback: 0.55, damp: 0.5 },
  },
];

/**
 * One struck note in a family's voice: strike + modes + body (+ breath).
 *
 * @param {Float32Array} buf
 * @param {Family} fam
 * @param {{ start:number, freq:number, gain?:number, decayScale?:number,
 *           bright?:number, seed:number }} note
 */
function addNote(buf, fam, note) {
  const gain = note.gain ?? 1;
  const decayScale = note.decayScale ?? 1;
  const bright = note.bright ?? 1;

  addStrike(buf, {
    start: note.start,
    peak: fam.strike.peak * gain * bright,
    decayMs: fam.strike.decayMs,
    lowHz: fam.strike.lowHz,
    // `bright` also opens/closes the strike's top end, so `mute` really is a
    // duller EVENT and `unmute` a more open one — not just a quieter/louder
    // copy of the same click.
    highHz: fam.strike.highHz * bright,
    poles: fam.strike.poles,
    seed: note.seed,
  });
  addModes(buf, {
    start: note.start,
    freq: note.freq,
    peak: 0.42 * gain,
    decaySec: fam.decaySec * decayScale,
    partials: fam.partials,
    detune: fam.detune,
    seed: note.seed + 7919,
  });
  addBody(buf, {
    start: note.start,
    freq: note.freq * fam.body.ratio,
    peak: fam.body.peak * gain,
    decaySec: fam.body.decaySec * decayScale,
  });
  if (fam.breath) {
    addBreath(buf, {
      start: note.start,
      peak: fam.breath.peak * gain,
      decaySec: fam.breath.decaySec * decayScale,
      lowHz: fam.breath.lowHz,
      highHz: fam.breath.highHz,
      poles: fam.breath.poles,
      seed: note.seed + 104729,
    });
  }
}

/**
 * The MOTIF catalog — shared by every family so the semantics never change with
 * the timbre. Rising = positive, falling = its counterpart; one key (C major /
 * A minor), so the whole app speaks in one musical voice.
 *
 *   voice-join    C5 -> G5  rising fifth (arrival)
 *   voice-leave   G5 -> C5  falling fifth
 *   peer-join     G4 -> C5  rising fourth, softer (someone else, not you)
 *   peer-leave    C5 -> G4  falling fourth, softer
 *   mute          F4        single, dark, damped (closed)
 *   unmute        C5        single, open, brighter (a fifth above mute)
 *   screen-start  C5-E5-A5  rising, wide (something big began)
 *   screen-stop   A5-E5-C5  falling
 *   message       D5 -> F5  rising MINOR THIRD, very soft and short
 *
 * @typedef {object} CueSpec
 * @property {number} lengthSec
 * @property {number} loudnessDb   loudness target (max-50ms RMS), the hierarchy
 * @property {{ start:number, freq:number, gain?:number, decayScale?:number,
 *              bright?:number }[]} notes
 */

/** @type {Record<string, CueSpec>} */
const MOTIFS = {
  "voice-join": {
    lengthSec: 0.6,
    loudnessDb: -15,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.9 },
      { start: 0.085, freq: NOTE.G5, gain: 1.0, decayScale: 1.25 },
    ],
  },
  "voice-leave": {
    lengthSec: 0.6,
    loudnessDb: -15,
    notes: [
      { start: 0.0, freq: NOTE.G5, gain: 0.95 },
      { start: 0.085, freq: NOTE.C5, gain: 1.0, decayScale: 1.25 },
    ],
  },
  "peer-join": {
    lengthSec: 0.45,
    loudnessDb: -18,
    notes: [
      { start: 0.0, freq: NOTE.G4, gain: 0.72, bright: 0.75 },
      { start: 0.07, freq: NOTE.C5, gain: 0.85, bright: 0.75, decayScale: 1.1 },
    ],
  },
  "peer-leave": {
    lengthSec: 0.45,
    loudnessDb: -18,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.85, bright: 0.75 },
      { start: 0.07, freq: NOTE.G4, gain: 0.72, bright: 0.75, decayScale: 1.1 },
    ],
  },
  mute: {
    lengthSec: 0.3,
    loudnessDb: -17.5,
    // Damped: short decay + a dull strike. "The mic closed."
    notes: [{ start: 0.0, freq: NOTE.F4, gain: 0.85, decayScale: 0.5, bright: 0.5 }],
  },
  unmute: {
    lengthSec: 0.34,
    loudnessDb: -16.5,
    // Open: full decay, brighter strike, a fifth up. "The mic opened."
    notes: [{ start: 0.0, freq: NOTE.C5, gain: 0.9, decayScale: 1.0, bright: 1.15 }],
  },
  "screen-start": {
    lengthSec: 0.62,
    loudnessDb: -15,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.75 },
      { start: 0.06, freq: NOTE.E5, gain: 0.85 },
      { start: 0.125, freq: NOTE.A5, gain: 1.0, decayScale: 1.3 },
    ],
  },
  "screen-stop": {
    lengthSec: 0.62,
    loudnessDb: -15,
    notes: [
      { start: 0.0, freq: NOTE.A5, gain: 0.9 },
      { start: 0.06, freq: NOTE.E5, gain: 0.85 },
      { start: 0.125, freq: NOTE.C5, gain: 1.0, decayScale: 1.3 },
    ],
  },
  message: {
    lengthSec: 0.42,
    // Deliberately the QUIETEST cue in the set: it is the one that fires most
    // often, and it must never feel like an alarm. 5 dB under voice-join and
    // 7 dB under the incoming ring — the hierarchy the old peak-normalized set
    // could not express (it landed 2 dB under screen-start).
    loudnessDb: -20,
    notes: [
      { start: 0.0, freq: NOTE.D5, gain: 0.8, decayScale: 0.85 },
      { start: 0.075, freq: NOTE.F5, gain: 0.9, decayScale: 0.95 },
    ],
  },
};

/**
 * The two looping call ring cadences (mobile assets; desktop synthesizes its own
 * in sounds/ringtone.ts). The file length IS one full cadence period so
 * `player.loop = true` reproduces the desktop CADENCE_MS exactly.
 *
 * @type {Record<string, CueSpec>}
 */
const RING_MOTIFS = {
  "ring-incoming": {
    lengthSec: 2.6,
    loudnessDb: -13,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 1.0, decayScale: 1.6 },
      { start: 0.19, freq: NOTE.G5, gain: 0.95, decayScale: 1.6 },
      { start: 0.55, freq: NOTE.C5, gain: 1.0, decayScale: 1.6 },
      { start: 0.74, freq: NOTE.G5, gain: 0.95, decayScale: 1.8 },
    ],
  },
  "ring-outgoing": {
    lengthSec: 3.4,
    loudnessDb: -16,
    notes: [
      { start: 0.0, freq: NOTE.A4, gain: 0.85, decayScale: 2.2 },
      { start: 0.42, freq: NOTE.A4, gain: 0.6, decayScale: 2.2 },
    ],
  },
};

/** Peak ceiling for every generated cue (headroom under 0 dBFS, never clips). */
const PEAK_CEILING_DB = -4.5;

/**
 * Render one cue of one family.
 * @param {Family} fam
 * @param {CueSpec} spec
 * @param {number} seedBase
 * @returns {Float32Array}
 */
function renderCue(fam, spec, seedBase) {
  const buf = new Float32Array(Math.round(spec.lengthSec * SR));
  spec.notes.forEach((note, i) => {
    addNote(buf, fam, { ...note, seed: seedBase + i * 1013 });
  });
  addRoom(buf, fam.room);
  normalizeLoudness(buf, spec.loudnessDb, PEAK_CEILING_DB);
  fadeEdges(buf, 2);
  return buf;
}

/** Stable per-cue seed so a family's output never shifts between runs. */
function seedFor(familyId, cueName) {
  let h = 2166136261;
  for (const ch of `${familyId}:${cueName}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000000;
}

/**
 * Build a family's complete asset set.
 * @param {string} familyId
 * @returns {{ cues: Record<string, Float32Array>, rings: Record<string, Float32Array> }}
 */
function buildFamily(familyId) {
  if (familyId === "legacy") {
    return { cues: buildLegacySet(), rings: buildLegacyRings() };
  }
  const fam = FAMILIES.find((f) => f.id === familyId);
  if (!fam) throw new Error(`unknown family "${familyId}"`);
  /** @type {Record<string, Float32Array>} */
  const cues = {};
  for (const [name, spec] of Object.entries(MOTIFS)) {
    cues[name] = renderCue(fam, spec, seedFor(familyId, name));
  }
  /** @type {Record<string, Float32Array>} */
  const rings = {};
  for (const [name, spec] of Object.entries(RING_MOTIFS)) {
    rings[name] = renderCue(fam, spec, seedFor(familyId, name));
  }
  return { cues, rings };
}

/** Every selectable family id, in listening order. */
const FAMILY_IDS = ["marimba", "glass", "felt", "legacy"];

/** Founder-facing label/blurb for a family id (legacy has no Family record). */
function familyInfo(id) {
  const fam = FAMILIES.find((f) => f.id === id);
  if (fam) return { label: fam.label, blurb: fam.blurb };
  return {
    label: "Mevcut (eski)",
    blurb: "Şu an yayında olan sinüs tabanlı set — karşılaştırma referansı.",
  };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Encode a float buffer as 16-bit PCM mono WAV. */
function encodeWav(buf) {
  const numSamples = buf.length;
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return Buffer.concat([header, data]);
}

function haveFfmpeg() {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Convert an in-memory WAV to Ogg Vorbis via ffmpeg (mono, VBR q4). */
async function wavToOgg(wavBuf, tag) {
  const tmpWav = join(tmpdir(), `demli-${tag}-${process.pid}.wav`);
  const tmpOgg = join(tmpdir(), `demli-${tag}-${process.pid}.ogg`);
  await writeFile(tmpWav, wavBuf);
  const res = spawnSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", tmpWav, "-ac", "1", "-c:a", "libvorbis", "-q:a", "4", tmpOgg,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed for ${tag}`);
  const ogg = await readFile(tmpOgg);
  await rm(tmpWav, { force: true });
  await rm(tmpOgg, { force: true });
  return ogg;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function writeBytes(relPath, bytes) {
  const abs = join(ROOT, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return relPath;
}

/** One measured line per cue — the build log doubles as the evidence trail. */
function measure(name, buf) {
  return {
    name,
    durMs: (buf.length / SR) * 1000,
    peakDb: dbfs(peakOf(buf)),
    loudDb: dbfs(loudness(buf)),
  };
}

function printMeasurements(rows) {
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(14)} ${r.durMs.toFixed(0).padStart(4)} ms   ` +
        `peak ${r.peakDb.toFixed(1).padStart(6)} dBFS   ` +
        `loudness ${r.loudDb.toFixed(1).padStart(6)} dBFS`,
    );
  }
}

/**
 * Preview mode: render EVERY family into build/sound-previews/<family>/ and drop
 * a self-contained HTML player next to them. Touches no shipping asset — the
 * founder listens, then a single `--family=<id>` run (or ACTIVE_FAMILY) ships it.
 */
async function writePreviews(ext, ogg) {
  const families = [];
  for (const id of FAMILY_IDS) {
    console.log(`\nFamily: ${id}`);
    const { cues, rings } = buildFamily(id);
    const rows = [];
    const files = [];
    for (const [name, buf] of Object.entries(cues)) {
      const wav = encodeWav(buf);
      const bytes = ogg ? await wavToOgg(wav, `${id}-${name}`) : wav;
      await writeBytes(`${PREVIEW_DIR}/${id}/${name}.${ext}`, bytes);
      rows.push(measure(name, buf));
      files.push({ name, file: `${id}/${name}.${ext}` });
    }
    for (const [name, buf] of Object.entries(rings)) {
      await writeBytes(`${PREVIEW_DIR}/${id}/${name}.wav`, encodeWav(buf));
      rows.push(measure(name, buf));
      files.push({ name, file: `${id}/${name}.wav` });
    }
    printMeasurements(rows);
    families.push({ id, ...familyInfo(id), files });
  }

  await writeBytes(`${PREVIEW_DIR}/index.html`, Buffer.from(previewHtml(families), "utf8"));
  console.log(`\nPreview player: ${PREVIEW_DIR}/index.html`);
}

/** Self-contained listening page (no network, no build step, dark-first). */
function previewHtml(families) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sections = families
    .map(
      (f) => `<section>
  <h2>${esc(f.label)} <code>${esc(f.id)}</code></h2>
  <p>${esc(f.blurb)}</p>
  <div class="grid">
${f.files
  .map(
    (c) => `    <div class="cue"><span>${esc(c.name)}</span><audio controls preload="none" src="${esc(c.file)}"></audio></div>`,
  )
  .join("\n")}
  </div>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<title>Demli — ses aileleri</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:32px;background:#0d0f12;color:#e6e8ec;
  font:15px/1.55 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}
h1+p{margin:0 0 28px;color:#8b93a1;font-size:13px}
section{margin:0 0 30px;padding:18px 20px;border:1px solid #23262d;border-radius:12px;background:#13161a}
h2{font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
code{font-size:12px;color:#8b93a1;background:#0d0f12;border:1px solid #23262d;padding:2px 6px;border-radius:5px}
section>p{margin:0 0 16px;color:#8b93a1;font-size:13px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.cue{display:flex;flex-direction:column;gap:5px}
.cue span{font-size:12px;color:#b6bcc7}
audio{width:100%;height:34px}
</style></head><body>
<h1>Demli — bildirim/arayüz ses aileleri</h1>
<p>Hepsi bu depoda sıfırdan sentezlendi (üçüncü-parti örnek yok). Bir aile seç; sonra
<code>node scripts/gen-sounds.mjs --family=&lt;id&gt;</code> onu iki istemciye de yazar.</p>
${sections}
</body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const familyArg = args.find((a) => a.startsWith("--family="));
  const family = familyArg ? familyArg.slice("--family=".length) : ACTIVE_FAMILY;

  if (!preview && !FAMILY_IDS.includes(family)) {
    console.error(`Unknown family "${family}". Known: ${FAMILY_IDS.join(", ")}`);
    process.exit(1);
  }

  // Writing a family that ACTIVE_FAMILY does not name leaves the repo in a state
  // where the committed assets and the script disagree, and the next plain run
  // silently reverts every sound. Refuse instead of leaving that landmine: the
  // person switching families is the one who knows they are switching, so they
  // are the one who should update the constant. `--force` is there for trying a
  // family out locally without committing.
  if (!preview && familyArg && family !== ACTIVE_FAMILY && !args.includes("--force")) {
    console.error(
      `Refusing to write "${family}" while ACTIVE_FAMILY is "${ACTIVE_FAMILY}".\n` +
        `  The assets and this script would disagree, and the next plain run would\n` +
        `  revert the sounds with no diff to review.\n\n` +
        `  To SHIP ${family}: set ACTIVE_FAMILY = "${family}" (top of this file), then\n` +
        `  run \`node scripts/gen-sounds.mjs\` — same commit, both changes.\n` +
        `  To just LISTEN: \`node scripts/gen-sounds.mjs --preview\`.\n` +
        `  To overwrite locally anyway: add --force (do not commit the result).`,
    );
    process.exit(1);
  }

  console.log("Demli sound generation\n");
  const ogg = haveFfmpeg();
  console.log(
    ogg
      ? "ffmpeg found -> encoding one-shot cues as Ogg Vorbis"
      : "ffmpeg NOT found -> writing WAV fallback",
  );
  if (!ogg) {
    console.log(
      "  NOTE: sound-manager imports expect .ogg on both clients. Install ffmpeg\n" +
        "  and re-run, or update the imports to .wav.",
    );
  }
  const ext = ogg ? "ogg" : "wav";

  if (preview) {
    console.log(`\nPREVIEW MODE — writing every family to ${PREVIEW_DIR}/ (no shipping asset touched).`);
    await writePreviews(ext, ogg);
    console.log("\nDone.");
    return;
  }

  console.log(`\nFamily: ${family} (${familyInfo(family).label})`);
  const { cues, rings } = buildFamily(family);

  console.log("\nOne-shot cues (desktop + mobile):");
  const cueRows = [];
  for (const [name, buf] of Object.entries(cues)) {
    const wav = encodeWav(buf);
    const bytes = ogg ? await wavToOgg(wav, name) : wav;
    cueRows.push(measure(name, buf));
    await writeBytes(`${DESKTOP_DIR}/${name}.${ext}`, bytes);
    await writeBytes(`${MOBILE_DIR}/${name}.${ext}`, bytes);
  }
  printMeasurements(cueRows);

  console.log("\nRing cadences (mobile WAV loops):");
  const ringRows = [];
  for (const [name, buf] of Object.entries(rings)) {
    ringRows.push(measure(name, buf));
    await writeBytes(`${MOBILE_DIR}/${name}.wav`, encodeWav(buf));
  }
  printMeasurements(ringRows);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
