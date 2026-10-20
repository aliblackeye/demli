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
 * Several complete FAMILIES ship in this file so the timbre is a founder choice,
 * not an agent's guess. The MOTIFS (which notes, which direction) are shared —
 * only the timbre changes, so semantics stay identical whichever is picked:
 *
 *   porcelain  "Porselen Fincan"   thin teacup tapped with a fingertip/spoon (Koyu Masa)
 *   teaglass   "Ince Belli Bardak" Turkish tea glass + spoon, clear but softened top
 *   stoneware  "Sirli Toprak"      glazed earthenware cup, darkest of the ceramics
 *   felt       "Kece Tahta"        muted tongue-drum + breath layer (shipped 2026-07-29)
 *   marimba    "Sicak Marimba"     rosewood bar, soft mallet, warm low-mid, organic
 *   glass      "Yumusak Cam"       struck glass/bell, bright tink, airy shimmer
 *
 * Two LEVEL modes. `proxy` (felt/marimba/glass) is the original max-50ms-RMS
 * normalization, kept so those families render exactly as they shipped. `lufs`
 * (the Koyu Masa ceramics) normalizes to a BS.1770 K-weighted max-momentary
 * loudness target, trims the inaudible tail and fades it, so every cue in the
 * family lands on a measured, ffmpeg-verifiable LUFS hierarchy.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/gen-sounds.mjs                 write ACTIVE_FAMILY to both clients
 *   node scripts/gen-sounds.mjs --family=felt   write that family instead (needs
 *                                               ACTIVE_FAMILY to match, or --force)
 *   node scripts/gen-sounds.mjs --preview       write ALL families + an HTML
 *                                               player to build/sound-previews/
 *                                               (gitignored) and touch nothing else
 *   node scripts/gen-sounds.mjs --preview --out=<dir>   ...into <dir> instead
 *
 * Deps: none (pure Node PCM synthesis). Optional: ffmpeg on PATH for Ogg encode.
 */
/* global console, Buffer */
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
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
 * "porcelain" since 2026-10-20 — the "Koyu Masa" refresh (sfx-refresh wave). It
 * was picked over its two siblings on measured criteria only (nobody could
 * listen during the wave): every cue on its LUFS target, true peak <= -1 dBTP,
 * tail under -60 dBFS, and the most moderate top end of the three — between the
 * dark felt (3-8 % above 3 kHz) and the bright glass family. The founder's
 * listening pass (tmp/sfx/index.html) is the final word; switching back is one
 * line here plus a regenerate.
 *
 * History: "felt" from 2026-07-29 — the founder listened to four and picked it.
 * The set felt replaced measured as one texture wearing nine names: pure sine, 1-4
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
const ACTIVE_FAMILY = "porcelain";

// Note frequencies (equal temperament, A4 = 440).
const NOTE = {
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  Ab4: 415.3,
  A4: 440.0,
  Bb4: 466.16,
  B4: 493.88,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.0,
  B5: 987.77,
  C6: 1046.5,
  D6: 1174.66,
  E6: 1318.51,
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
// Broadcast loudness (BS.1770 K-weighting) — the `lufs` level mode
// ---------------------------------------------------------------------------

/**
 * BS.1770-4 K-weighting at 48 kHz: a high-shelf ("head") stage then the RLB
 * high-pass. The coefficients are the standard's published 48 kHz values, so the
 * number this file prints is the SAME number `ffmpeg -af ebur128` reports — the
 * generator can be audited with a tool nobody here wrote.
 */
const K_STAGES = [
  {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [-1.69065929318241, 0.73248077421585],
  },
  {
    b: [1.0, -2.0, 1.0],
    a: [-1.99004745483398, 0.99007225036621],
  },
];

/** @param {Float32Array} buf @returns {Float64Array} K-weighted copy */
function kWeight(buf) {
  let x = Float64Array.from(buf);
  for (const st of K_STAGES) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = st.b[0] * x0 + st.b[1] * x1 + st.b[2] * x2 - st.a[0] * y1 - st.a[1] * y2;
      y[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    x = y;
  }
  return x;
}

/**
 * Max MOMENTARY loudness (400 ms window, 10 ms hop) in LUFS, with the cue padded
 * by 400 ms of silence — exactly how a sub-400 ms cue reads in
 * `ffmpeg -af apad=pad_dur=0.5,ebur128`. Integrated loudness is meaningless for a
 * 150 ms blip (its gate swallows it, ffmpeg reports -70); max-momentary is the
 * standard short-SFX yardstick.
 *
 * @param {Float32Array} buf
 * @returns {number}
 */
function maxMomentaryLufs(buf) {
  const win = Math.round(0.4 * SR);
  const padded = new Float32Array(buf.length + win);
  padded.set(buf, 0);
  const k = kWeight(padded);
  const hop = Math.round(0.01 * SR);
  let best = 0;
  for (let start = -win + hop; start < k.length; start += hop) {
    let sum = 0;
    const from = Math.max(0, start);
    const to = Math.min(k.length, start + win);
    for (let i = from; i < to; i++) sum += k[i] * k[i];
    best = Math.max(best, sum / win);
  }
  return best > 0 ? -0.691 + 10 * Math.log10(best) : -Infinity;
}

/**
 * Normalize to a LUFS (max-momentary) target, then pull back to the peak
 * ceiling if needed. Pure gain both times — never a limiter, never a clip.
 *
 * @param {Float32Array} buf
 * @param {number} targetLufs
 * @param {number} ceilingDb  sample-peak ceiling in dBFS
 */
function normalizeLufs(buf, targetLufs, ceilingDb) {
  const l = maxMomentaryLufs(buf);
  if (Number.isFinite(l)) {
    const g = fromDb(targetLufs - l);
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  const p = peakOf(buf);
  const ceiling = fromDb(ceilingDb);
  if (p > ceiling) {
    const g = ceiling / p;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
}

/**
 * Apply a lookahead brick-wall limiter in-place. Reduces peaks to `ceiling`
 * (linear) while preserving the bulk of the signal's energy.
 *
 * @param {Float32Array} buf
 * @param {number} ceiling  linear amplitude ceiling
 */
function applyLimiter(buf, ceiling) {
  const p = peakOf(buf);
  if (p <= ceiling) return;

  const attackSamples = Math.round(0.005 * SR);  // 5 ms lookahead
  const releaseSamples = Math.round(0.05 * SR);   // 50 ms release

  // Per-sample gain needed to bring each exceeding sample to ceiling
  const gainEnv = new Float32Array(buf.length);
  gainEnv.fill(1);
  for (let i = 0; i < buf.length; i++) {
    const abs = Math.abs(buf[i]);
    if (abs > ceiling) gainEnv[i] = ceiling / abs;
  }

  // Backward pass: lookahead — propagate minimum gain into the upcoming window
  const smoothed = new Float32Array(buf.length);
  smoothed.fill(1);
  for (let i = buf.length - 1; i >= 0; i--) {
    const lookEnd = Math.min(buf.length, i + attackSamples);
    let minG = 1;
    for (let j = i; j < lookEnd; j++) {
      if (gainEnv[j] < minG) minG = gainEnv[j];
    }
    smoothed[i] = minG;
  }

  // Forward pass: smooth release — gain cannot jump back to 1 instantly
  const releaseCoeff = 1.0 / releaseSamples;
  let currentGain = 1;
  for (let i = 0; i < buf.length; i++) {
    const target = smoothed[i];
    if (target < currentGain) {
      currentGain = target;
    } else {
      currentGain += releaseCoeff * (target - currentGain);
      if (currentGain > 1) currentGain = 1;
    }
    buf[i] *= currentGain;
  }
}

/**
 * Normalize to a LUFS target with peak limiting. Iterates: scale to LUFS
 * target, limit peaks to ceiling, re-measure; if LUFS dropped below target
 * because the limiter ate energy, boost and re-limit (up to 8 rounds, which
 * covers even the most transient-heavy cues where the crest factor mismatch
 * between raw and limited is > 10 dB).
 *
 * This is how Discord achieves -14 to -16 LUFS on toggle clicks that peak at
 * -6 dBTP: the peaks are compressed, not the whole signal.
 *
 * @param {Float32Array} buf
 * @param {number} targetLufs
 * @param {number} ceilingDb  true-peak ceiling in dBFS
 */
function normalizeLufsLimited(buf, targetLufs, ceilingDb) {
  const ceiling = fromDb(ceilingDb);
  const tolerance = 0.5; // accept within 0.5 LU of target

  for (let iter = 0; iter < 8; iter++) {
    // Measure current LUFS
    const l = maxMomentaryLufs(buf);
    if (!Number.isFinite(l)) break;

    // Scale to target LUFS
    const delta = targetLufs - l;
    if (Math.abs(delta) < tolerance && peakOf(buf) <= ceiling * 1.01) break;
    if (delta !== 0) {
      const g = fromDb(delta);
      for (let i = 0; i < buf.length; i++) buf[i] *= g;
    }

    // Limit peaks
    applyLimiter(buf, ceiling);
  }
}

/**
 * Trim the inaudible tail and fade what is left, so a cue is exactly as long as
 * it sounds (UI blips stay inside the 80-400 ms brief) and never ends on a cut.
 *
 * The cut point is where the |signal| last exceeds `floorDb` below the peak; a
 * raised-cosine fade over the final `fadeMs` lands the last sample on zero.
 * `maxSec` caps the result — the fade then shapes an early stop rather than a
 * decay, which is why the families' decays are tuned to finish inside it.
 *
 * @param {Float32Array} buf
 * @param {{ floorDb:number, fadeMs:number, maxSec:number }} opts
 * @returns {Float32Array}
 */
function trimTail(buf, opts) {
  const thr = peakOf(buf) * fromDb(-Math.abs(opts.floorDb));
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]) < thr) last--;
  const fadeN = Math.round((opts.fadeMs / 1000) * SR);
  const len = Math.min(buf.length, Math.round(opts.maxSec * SR), last + 1 + fadeN);
  const out = buf.slice(0, len);
  const n = Math.min(fadeN, len);
  for (let i = 0; i < n; i++) {
    const idx = len - n + i;
    out[idx] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / n);
  }
  return out;
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
 * @property {"proxy"|"lufs"} [level] normalization mode (default "proxy", see header)
 * @property {number} [tempo]  multiplies every note onset (default 1). The ceramics
 *           play the shared motifs a little tighter so the last tap has decayed
 *           inside the 400 ms blip budget instead of being faded out mid-ring.
 */

/** @type {Family[]} */
const FAMILIES = [
  // -------------------------------------------------------------------------
  // "Koyu Masa" ceramics (2026-10-20). Brief: warm, calm, tea/glass/ceramic —
  // a soft tap on porcelain, never a shrill tink. Shared tuning rules that make
  // them read as the SAME table set:
  //   - short decays (fundamental tau 42-58 ms) + a 0.8 motif tempo, so a
  //     blip is DONE inside 400 ms by physics, not by the trim fade
  //   - the top partials are kept low in gain and die fastest, so the cue has
  //     "glaze" without a whistle
  //   - the strike is a fingertip/teaspoon: band-limited, 2-4 ms, never above
  //     ~9 kHz (the glass family's 13 kHz nail is what read as harsh)
  // -------------------------------------------------------------------------
  {
    id: "porcelain",
    label: "Porselen Fincan",
    blurb:
      "İnce porselen çay fincanına parmak ucu / kaşık dokunuşu: sıcak, yuvarlak, sırlı bir 'tık' — Koyu Masa'nın varsayılanı.",
    // Thin porcelain cup: bell-like but more damped and closer-spaced than glass
    // (the wall is thicker and the glaze absorbs) — 1 : 2.32 : 4.2 : 6.5 : 9.3.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 2.32, gain: 0.42, decayScale: 0.6 },
      { ratio: 4.2, gain: 0.2, decayScale: 0.38 },
      { ratio: 6.5, gain: 0.09, decayScale: 0.25 },
      { ratio: 9.3, gain: 0.04, decayScale: 0.16 },
    ],
    decaySec: 0.05,
    detune: 5,
    strike: { peak: 0.14, decayMs: 2.5, lowHz: 900, highHz: 6500, poles: 2 },
    body: { ratio: 0.5, peak: 0.12, decaySec: 0.03 },
    breath: null,
    room: { mix: 0.1, feedback: 0.5, damp: 0.42 },
    level: "lufs",
    tempo: 0.8,
  },
  {
    id: "teaglass",
    label: "İnce Belli Bardak",
    blurb:
      "İnce belli çay bardağına kaşık: berrak cam tınısı ama üst bandı yumuşatılmış — en 'çay' olanı, en parlak aday.",
    // Thin tumbler glass modes (bell-ish 2.71 / 5.2), with the upper partials
    // pulled well under the old `glass` family so it rings, not pierces.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 2.71, gain: 0.38, decayScale: 0.55 },
      { ratio: 5.2, gain: 0.16, decayScale: 0.34 },
      { ratio: 8.6, gain: 0.07, decayScale: 0.22 },
      { ratio: 12.9, gain: 0.03, decayScale: 0.14 },
    ],
    decaySec: 0.058,
    detune: 3,
    strike: { peak: 0.12, decayMs: 1.8, lowHz: 2000, highHz: 9000, poles: 2 },
    body: { ratio: 0.5, peak: 0.08, decaySec: 0.025 },
    breath: null,
    room: { mix: 0.12, feedback: 0.52, damp: 0.36 },
    level: "lufs",
    tempo: 0.8,
  },
  {
    id: "stoneware",
    label: "Sırlı Toprak",
    blurb:
      "Sırlı toprak / taş fincan: tok, kısa, koyu — seramiklerin en karanlığı, keçe setine en yakın aday.",
    // Thick glazed earthenware: few modes, all short; a whisper of breath keeps
    // the dark spectrum from sounding like a filtered synth.
    partials: [
      { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
      { ratio: 2.45, gain: 0.3, decayScale: 0.45 },
      { ratio: 4.6, gain: 0.12, decayScale: 0.26 },
      { ratio: 7.1, gain: 0.05, decayScale: 0.15 },
    ],
    decaySec: 0.042,
    detune: 7,
    strike: { peak: 0.17, decayMs: 4.0, lowHz: 300, highHz: 3200, poles: 2 },
    body: { ratio: 0.5, peak: 0.2, decaySec: 0.045 },
    breath: { peak: 0.04, decaySec: 0.03, lowHz: 600, highHz: 2600, poles: 2 },
    room: { mix: 0.08, feedback: 0.48, damp: 0.5 },
    level: "lufs",
    tempo: 0.8,
  },
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
 *   voice-join      C5 -> G5     rising fifth (arrival)
 *   voice-leave     G5 -> C5     falling fifth
 *   peer-join       G4 -> C5     rising fourth, softer (someone else, not you)
 *   peer-leave      C5 -> G4     falling fourth, softer
 *   mute            F4           single, dark, damped (closed)
 *   unmute          C5           single, open, brighter (a fifth above mute)
 *   deafen          C5 -> F4     the mute tap DOUBLED and falling (closed, both ways)
 *   undeafen        F4 -> C5     the unmute tap doubled and rising
 *   screen-start    C5-E5-A5     rising, wide (something big began)
 *   screen-stop     A5-E5-C5     falling
 *   message         D5 -> F5     rising MINOR THIRD, very soft and short
 *   mention         D5-F5-A5     the message motif plus one brighter tap (it is you)
 *   call-connected  C5-G5-C6     rising fifth + octave — a fuller voice-join
 *   call-ended      G4 -> C4     one low falling step, soft (the line went quiet)
 *   peer-left-call  C5-A4-F4     a falling triad, softer (the other side hung up)
 *   error           F4 -> E4     two dull taps, a semitone down — "uh-oh", not an alarm
 *
 * @typedef {object} CueSpec
 * @property {number} lengthSec    render buffer (the `lufs` families trim it)
 * @property {number} loudnessDb   `proxy` target (max-50ms RMS dBFS)
 * @property {number} lufs         `lufs` target (max-momentary LUFS, BS.1770)
 * @property {{ start:number, freq:number, gain?:number, decayScale?:number,
 *              bright?:number }[]} notes
 */

/**
 * LUFS hierarchy for the `lufs` families (max-momentary, see maxMomentaryLufs):
 *   -16    ring-incoming      must be heard across a room
 *   -19    ring-outgoing      your own ringback, a step under
 *   -19    call-connected     the biggest one-shot: a call just started
 *   -20    voice-join/-leave, screen-start/-stop     "you did something"
 *   -21    error, call-ended, unmute, undeafen, mention
 *   -21.5  deafen, peer-left-call
 *   -22.5  mute
 *   -23    peer-join/-leave   someone else did something
 *   -23.5  message            fires most often — the quietest cue, by design
 */
/** @type {Record<string, CueSpec>} */
const MOTIFS = {
  "voice-join": {
    lengthSec: 0.6,
    loudnessDb: -15,
    lufs: -20,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.9 },
      { start: 0.085, freq: NOTE.G5, gain: 1.0, decayScale: 1.25 },
    ],
  },
  "voice-leave": {
    lengthSec: 0.6,
    loudnessDb: -15,
    lufs: -20,
    notes: [
      { start: 0.0, freq: NOTE.G5, gain: 0.95 },
      { start: 0.085, freq: NOTE.C5, gain: 1.0, decayScale: 1.25 },
    ],
  },
  "peer-join": {
    lengthSec: 0.45,
    loudnessDb: -18,
    lufs: -23,
    notes: [
      { start: 0.0, freq: NOTE.G4, gain: 0.72, bright: 0.75 },
      { start: 0.07, freq: NOTE.C5, gain: 0.85, bright: 0.75, decayScale: 1.1 },
    ],
  },
  "peer-leave": {
    lengthSec: 0.45,
    loudnessDb: -18,
    lufs: -23,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.85, bright: 0.75 },
      { start: 0.07, freq: NOTE.G4, gain: 0.72, bright: 0.75, decayScale: 1.1 },
    ],
  },
  mute: {
    lengthSec: 0.3,
    loudnessDb: -17.5,
    // -22.5, not -21.5: a damped low F4 is all crest (K-weighting discounts its
    // body), so -21.5 is unreachable under the peak ceiling. A closing cue
    // sitting 1.5 dB under its opening twin is the right way round anyway.
    lufs: -22.5,
    // Damped: short decay + a dull strike. "The mic closed."
    notes: [{ start: 0.0, freq: NOTE.F4, gain: 0.85, decayScale: 0.5, bright: 0.5 }],
  },
  unmute: {
    lengthSec: 0.34,
    loudnessDb: -16.5,
    lufs: -21,
    // Open: full decay, brighter strike, a fifth up. "The mic opened."
    notes: [{ start: 0.0, freq: NOTE.C5, gain: 0.9, decayScale: 1.0, bright: 1.15 }],
  },
  deafen: {
    lengthSec: 0.36,
    loudnessDb: -17.5,
    lufs: -21.5,
    // Two damped taps falling onto the mute note: "everything closed".
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.8, decayScale: 0.55, bright: 0.55 },
      { start: 0.07, freq: NOTE.F4, gain: 0.85, decayScale: 0.5, bright: 0.5 },
    ],
  },
  undeafen: {
    lengthSec: 0.4,
    loudnessDb: -16.5,
    lufs: -21,
    notes: [
      { start: 0.0, freq: NOTE.F4, gain: 0.8, decayScale: 0.9 },
      { start: 0.07, freq: NOTE.C5, gain: 0.9, decayScale: 1.0, bright: 1.15 },
    ],
  },
  "screen-start": {
    lengthSec: 0.62,
    loudnessDb: -15,
    lufs: -20,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.75 },
      { start: 0.06, freq: NOTE.E5, gain: 0.85 },
      { start: 0.125, freq: NOTE.A5, gain: 1.0, decayScale: 1.3 },
    ],
  },
  "screen-stop": {
    lengthSec: 0.62,
    loudnessDb: -15,
    lufs: -20,
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
    lufs: -23.5,
    notes: [
      { start: 0.0, freq: NOTE.D5, gain: 0.8, decayScale: 0.85 },
      { start: 0.075, freq: NOTE.F5, gain: 0.9, decayScale: 0.95 },
    ],
  },
  mention: {
    lengthSec: 0.5,
    // The message motif with a third, brighter tap: same family of meaning
    // ("someone wrote"), one step more insistent ("...to YOU").
    loudnessDb: -18.5,
    lufs: -21,
    notes: [
      { start: 0.0, freq: NOTE.D5, gain: 0.8, decayScale: 0.85 },
      { start: 0.075, freq: NOTE.F5, gain: 0.9, decayScale: 0.95 },
      { start: 0.15, freq: NOTE.A5, gain: 0.8, decayScale: 0.9, bright: 1.1 },
    ],
  },
  "call-connected": {
    lengthSec: 0.62,
    loudnessDb: -14.5,
    lufs: -19,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.8 },
      { start: 0.08, freq: NOTE.G5, gain: 0.9 },
      { start: 0.16, freq: NOTE.C6, gain: 0.85, decayScale: 1.3 },
    ],
  },
  "call-ended": {
    lengthSec: 0.5,
    loudnessDb: -16,
    lufs: -21,
    notes: [
      { start: 0.0, freq: NOTE.G4, gain: 0.85, decayScale: 0.9, bright: 0.8 },
      { start: 0.1, freq: NOTE.C4, gain: 0.95, decayScale: 1.1, bright: 0.7 },
    ],
  },
  "peer-left-call": {
    lengthSec: 0.5,
    loudnessDb: -18,
    lufs: -21.5,
    notes: [
      { start: 0.0, freq: NOTE.C5, gain: 0.8, bright: 0.75 },
      { start: 0.07, freq: NOTE.A4, gain: 0.75, bright: 0.75 },
      { start: 0.14, freq: NOTE.F4, gain: 0.72, decayScale: 1.1, bright: 0.7 },
    ],
  },
  error: {
    lengthSec: 0.38,
    loudnessDb: -16,
    lufs: -21,
    // Dull and damped on purpose: an error cue that is sharp reads as blame.
    notes: [
      { start: 0.0, freq: NOTE.F4, gain: 0.85, decayScale: 0.45, bright: 0.6 },
      { start: 0.12, freq: NOTE.E4, gain: 0.9, decayScale: 0.5, bright: 0.55 },
    ],
  },
};

/**
 * The two looping call ring cadences, shipped as files on BOTH clients (desktop
 * `sounds/ringtone.ts` and mobile `sounds/ringtone.ts` loop them). The file
 * length IS one full cadence period, so a looping player reproduces the cadence
 * exactly — and both platforms ring with the same bytes:
 *   incoming  C5+G5 double pair, 2.60 s period
 *   outgoing  A4 ringback (two taps), 3.40 s period
 *
 * @type {Record<string, CueSpec>}
 */
const RING_MOTIFS = {
  "ring-incoming": {
    lengthSec: 2.6,
    loudnessDb: -13,
    lufs: -16,
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
    lufs: -19,
    notes: [
      { start: 0.0, freq: NOTE.A4, gain: 0.85, decayScale: 2.2 },
      { start: 0.42, freq: NOTE.A4, gain: 0.6, decayScale: 2.2 },
    ],
  },
};

/** Peak ceiling for the `proxy` families (headroom under 0 dBFS, never clips). */
const PEAK_CEILING_DB = -4.5;
/**
 * Sample-peak ceiling for the `lufs` families. -2 dBFS leaves room for the Ogg
 * encoder's inter-sample overshoot: the shipped files are verified at <= -1 dBTP
 * with `ffmpeg -af ebur128=peak=true` (see docs/product/sound-credits.md).
 */
const LUFS_PEAK_CEILING_DB = -2;
/** UI blips are capped at 400 ms (brief: 80-400 ms); rings keep their period. */
const BLIP_MAX_SEC = 0.4;

/**
 * Render one cue of one family.
 * @param {Family} fam
 * @param {CueSpec} spec
 * @param {number} seedBase
 * @param {{ loop?: boolean }} [opts]  loop = a ring period: never trimmed
 * @returns {Float32Array}
 */
function renderCue(fam, spec, seedBase, opts = {}) {
  let buf = new Float32Array(Math.round(spec.lengthSec * SR));
  const tempo = opts.loop ? 1 : (fam.tempo ?? 1); // a ring keeps its exact cadence
  spec.notes.forEach((note, i) => {
    addNote(buf, fam, { ...note, start: note.start * tempo, seed: seedBase + i * 1013 });
  });
  addRoom(buf, fam.room);
  if ((fam.level ?? "proxy") === "proxy") {
    // Byte-for-byte the path felt/marimba/glass shipped with.
    normalizeLoudness(buf, spec.loudnessDb, PEAK_CEILING_DB);
    fadeEdges(buf, 2);
    return buf;
  }
  if (!opts.loop) {
    buf = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: BLIP_MAX_SEC });
  }
  fadeEdges(buf, 2);
  normalizeLufs(buf, spec.lufs, LUFS_PEAK_CEILING_DB);
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
  // The premium family has its own builder — it uses per-category synthesis
  // techniques rather than the shared motif-through-a-single-timbre approach.
  if (familyId === "premium") return buildPremiumSet();

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
    rings[name] = renderCue(fam, spec, seedFor(familyId, name), { loop: true });
  }
  return { cues, rings };
}

// ---------------------------------------------------------------------------
// "Premium" family — Discord-grade UI sounds
// ---------------------------------------------------------------------------
// Unlike the modal families above (which share the MOTIFS catalog and differ
// only in timbre), the premium family uses a DIFFERENT synthesis technique per
// cue category: pure percussive noise for toggles, struck-bell modes for voice
// events, a bright pop for messages, swept noise for screen share, and actual
// short melodies for rings. This is what Discord gets right: each category has
// its own material identity, so you know what happened WITHOUT looking.
//
// The builder bypasses the shared renderCue/addNote pipeline and builds every
// cue from scratch, using the low-level primitives (addStrike, addModes,
// addBody, addBreath, addRoom, normalizeLufs, trimTail, fadeEdges).
// ---------------------------------------------------------------------------

/**
 * A pitch-swept sine burst: the core of the "pop" and "whoosh" sounds.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, startHz:number, endHz:number, peak:number,
 *           durationSec:number, seed?:number }} spec
 */
function addSweepTone(buf, spec) {
  const n0 = Math.floor(spec.start * SR);
  const nLen = Math.min(buf.length - n0, Math.ceil(spec.durationSec * SR));
  if (nLen <= 0) return;
  const nAttack = Math.max(1, Math.floor(0.001 * SR));
  const tauSamples = Math.max(1, spec.durationSec * SR * 0.35);
  let phase = 0;
  for (let i = 0; i < nLen; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    const t = i / nLen;
    // Exponential pitch sweep between start and end frequencies
    const hz = spec.startHz * Math.pow(spec.endHz / spec.startHz, t);
    const env = (i < nAttack ? i / nAttack : 1) * Math.exp(-i / tauSamples);
    phase += (2 * Math.PI * hz) / SR;
    buf[idx] += Math.sin(phase) * env * spec.peak;
  }
}

/**
 * Filtered noise sweep for whoosh/screen-share sounds.
 *
 * @param {Float32Array} buf
 * @param {{ start:number, durationSec:number, peak:number,
 *           startHz:number, endHz:number, bandwidth:number,
 *           seed:number }} spec
 */
function addNoiseSweep(buf, spec) {
  const n0 = Math.floor(spec.start * SR);
  const nLen = Math.min(buf.length - n0, Math.ceil(spec.durationSec * SR));
  if (nLen <= 0) return;
  const rng = makeRng(spec.seed);
  // Generate full noise, then apply a time-varying bandpass via modulation
  const noise = new Float32Array(nLen);
  for (let i = 0; i < nLen; i++) noise[i] = rng() * 2 - 1;
  // Smooth the noise to approximate bandpass
  lowPass(noise, spec.bandwidth * 2, 2);
  // Re-normalize
  let p = 0;
  for (let i = 0; i < nLen; i++) p = Math.max(p, Math.abs(noise[i]));
  if (p === 0) return;
  const g = 1 / p;
  const nAttack = Math.max(1, Math.floor(0.005 * SR));
  const nRelease = Math.max(1, Math.floor(0.02 * SR));
  for (let i = 0; i < nLen; i++) {
    const idx = n0 + i;
    if (idx >= buf.length) break;
    const t = i / nLen;
    const hz = spec.startHz * Math.pow(spec.endHz / spec.startHz, t);
    // Ring-modulate the noise with a sine at the sweep frequency to centre it
    const carrier = Math.sin((2 * Math.PI * hz * i) / SR);
    let env = 1;
    if (i < nAttack) env = i / nAttack;
    else if (i > nLen - nRelease) env = (nLen - i) / nRelease;
    // Bell-shaped amplitude: louder in the middle of the sweep
    const bell = Math.sin(Math.PI * t);
    buf[idx] += noise[i] * g * carrier * env * bell * spec.peak;
  }
}

/**
 * Build the complete premium cue set. Each cue category uses distinct synthesis.
 *
 * ---------------------------------------------------------------------------
 * CALIBRATION TARGET: Discord's shipped sounds (measured from actual MP3s)
 * ---------------------------------------------------------------------------
 * Discord uses a fixed -6 dBTP peak ceiling on every cue. Its toggles sit at
 * -14 to -16 LUFS (our old premium was -28 — 12 dB too quiet). Durations are
 * 450-1200 ms for one-shot cues (our old premium was 80-400 ms — too short to
 * develop any resonance). The message sound is transient-heavy with -inf
 * integrated LUFS, meaning nearly all energy is in a single pop.
 *
 * This rewrite matches Discord's measured LUFS, duration, peak ceiling, and
 * crest factor per category while keeping the per-category synthesis identity
 * (percussive toggles, bell joins, pop messages, sweep screens, melodic rings).
 *
 * @returns {{ cues: Record<string, Float32Array>, rings: Record<string, Float32Array> }}
 */
function buildPremiumSet() {
  /** @type {Record<string, Float32Array>} */
  const cues = {};
  /** @type {Record<string, Float32Array>} */
  const rings = {};

  // Discord's universal peak ceiling: -6 dBTP on every sound.
  const PEAK_CEIL = -6;

  // Shared room constants — more reverb than before to fill the longer tails
  const ROOM_TOGGLE = { mix: 0.08, feedback: 0.5, damp: 0.45 };
  const ROOM_VOICE = { mix: 0.12, feedback: 0.55, damp: 0.38 };
  const ROOM_POP = { mix: 0.06, feedback: 0.45, damp: 0.5 };
  const ROOM_SWEEP = { mix: 0.1, feedback: 0.5, damp: 0.42 };
  const ROOM_CALL = { mix: 0.12, feedback: 0.55, damp: 0.38 };
  const ROOM_RING = { mix: 0.14, feedback: 0.58, damp: 0.35 };

  // -----------------------------------------------------------------------
  // TOGGLES: percussive noise burst + resonant tonal tail
  // Discord's mute/unmute are ~460 ms with a noticeable resonant decay, not
  // just a click. The trick: a strong noise transient at onset, then a few
  // damped modal partials that ring out over ~300 ms.
  // -----------------------------------------------------------------------

  // Toggle partial recipe: a short-lived, slightly metallic "switch" resonance
  const TOGGLE_PARTIALS = [
    { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
    { ratio: 2.4, gain: 0.35, decayScale: 0.55 },
    { ratio: 4.1, gain: 0.15, decayScale: 0.3 },
    { ratio: 6.8, gain: 0.06, decayScale: 0.18 },
  ];

  // mute: dampened low "thock" with resonant tail — 450ms, -15.5 LUFS
  {
    const buf = new Float32Array(Math.round(0.6 * SR));
    const s = seedFor("premium", "mute");
    // Strong low-band noise burst: the switch closing
    addStrike(buf, {
      start: 0.0, peak: 0.8, decayMs: 12.0,
      lowHz: 100, highHz: 2200, poles: 3, seed: s,
    });
    // Resonant tail: low F4 modes that ring and die over ~300 ms
    addModes(buf, {
      start: 0.001, freq: NOTE.F4, peak: 0.45, decaySec: 0.18,
      partials: TOGGLE_PARTIALS, detune: 6, seed: s + 7919,
    });
    // Sub-bass thump for weight
    addBody(buf, { start: 0.0, freq: 85, peak: 0.3, decaySec: 0.06 });
    addRoom(buf, ROOM_TOGGLE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.45 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -15.5, PEAK_CEIL);
    cues["mute"] = trimmed;
  }

  // unmute: brighter tick with open resonant tail — 450ms, -14.2 LUFS
  {
    const buf = new Float32Array(Math.round(0.6 * SR));
    const s = seedFor("premium", "unmute");
    addStrike(buf, {
      start: 0.0, peak: 0.8, decayMs: 8.0,
      lowHz: 600, highHz: 7000, poles: 2, seed: s,
    });
    // Open resonance: C5, brighter and longer than mute
    addModes(buf, {
      start: 0.001, freq: NOTE.C5, peak: 0.45, decaySec: 0.2,
      partials: TOGGLE_PARTIALS, detune: 4, seed: s + 7919,
    });
    addBody(buf, { start: 0.0, freq: 260, peak: 0.2, decaySec: 0.05 });
    addRoom(buf, ROOM_TOGGLE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.45 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -14.2, PEAK_CEIL);
    cues["unmute"] = trimmed;
  }

  // deafen: two dampened low thocks — 730ms, -17.9 LUFS
  {
    const buf = new Float32Array(Math.round(0.9 * SR));
    const s = seedFor("premium", "deafen");
    for (let tap = 0; tap < 2; tap++) {
      const t = tap * 0.15;
      addStrike(buf, {
        start: t, peak: 0.75, decayMs: 10.0,
        lowHz: 100, highHz: 2200, poles: 3,
        seed: s + tap * 997,
      });
      // Falling pitch: C5 then F4 (closing)
      const freq = tap === 0 ? NOTE.C5 : NOTE.F4;
      addModes(buf, {
        start: t + 0.001, freq, peak: 0.4, decaySec: 0.16,
        partials: TOGGLE_PARTIALS, detune: 6, seed: s + tap * 997 + 7919,
      });
      addBody(buf, { start: t, freq: 85, peak: 0.25, decaySec: 0.05 });
    }
    addRoom(buf, ROOM_TOGGLE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.73 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.9, PEAK_CEIL);
    cues["deafen"] = trimmed;
  }

  // undeafen: two bright ticks rising — 800ms, -16.6 LUFS
  {
    const buf = new Float32Array(Math.round(1.0 * SR));
    const s = seedFor("premium", "undeafen");
    for (let tap = 0; tap < 2; tap++) {
      const t = tap * 0.15;
      addStrike(buf, {
        start: t, peak: 0.75, decayMs: 7.0,
        lowHz: 600, highHz: 7000, poles: 2,
        seed: s + tap * 997,
      });
      // Rising pitch: F4 then C5 (opening)
      const freq = tap === 0 ? NOTE.F4 : NOTE.C5;
      addModes(buf, {
        start: t + 0.001, freq, peak: 0.4, decaySec: 0.18,
        partials: TOGGLE_PARTIALS, detune: 4, seed: s + tap * 997 + 7919,
      });
      addBody(buf, { start: t, freq: 260, peak: 0.18, decaySec: 0.04 });
    }
    addRoom(buf, ROOM_TOGGLE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.8 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -16.6, PEAK_CEIL);
    cues["undeafen"] = trimmed;
  }

  // -----------------------------------------------------------------------
  // VOICE PRESENCE: struck bell/chime with long luxurious decay
  // Discord's join is 1086 ms — these bells need to ring and shimmer.
  // Peer versions: softer attack, 3 LU quieter
  // -----------------------------------------------------------------------

  // Bell partial recipe: crystalline bell with rich overtones for long decay
  const BELL_PARTIALS = [
    { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
    { ratio: 2.0, gain: 0.55, decayScale: 0.72 },
    { ratio: 3.0, gain: 0.32, decayScale: 0.52 },
    { ratio: 4.24, gain: 0.2, decayScale: 0.38 },
    { ratio: 5.96, gain: 0.12, decayScale: 0.26 },
    { ratio: 8.3, gain: 0.06, decayScale: 0.18 },
    { ratio: 11.5, gain: 0.03, decayScale: 0.12 },
  ];

  /**
   * One bell note for the premium voice cues.
   * @param {Float32Array} buf
   * @param {number} start
   * @param {number} freq
   * @param {number} gain
   * @param {number} decaySec
   * @param {number} seed
   * @param {number} [strikeBright]  1 = normal, <1 = softer attack
   */
  function addBellNote(buf, start, freq, gain, decaySec, seed, strikeBright = 1) {
    // Sharp strike: a short bright click that reads as "struck metal"
    addStrike(buf, {
      start,
      peak: 0.24 * gain * strikeBright,
      decayMs: 3.0,
      lowHz: 1200 * strikeBright,
      highHz: 9000 * strikeBright,
      poles: 2,
      seed,
    });
    // Bell modes — longer decaySec than before for luxurious ring
    addModes(buf, {
      start, freq,
      peak: 0.42 * gain,
      decaySec,
      partials: BELL_PARTIALS,
      detune: 3,
      seed: seed + 7919,
    });
    // Sub body for warmth
    addBody(buf, {
      start,
      freq: freq * 0.5,
      peak: 0.12 * gain,
      decaySec: decaySec * 0.45,
    });
  }

  // voice-join: ascending perfect 5th (C5 -> G5) — 1000ms, -17.3 LUFS
  {
    const buf = new Float32Array(Math.round(1.3 * SR));
    const s = seedFor("premium", "voice-join");
    addBellNote(buf, 0.0, NOTE.C5, 0.85, 0.45, s);
    addBellNote(buf, 0.12, NOTE.G5, 1.0, 0.55, s + 1013);
    addRoom(buf, ROOM_VOICE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 40, maxSec: 1.0 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.3, PEAK_CEIL);
    cues["voice-join"] = trimmed;
  }

  // voice-leave: descending perfect 5th (G5 -> C5) — 960ms, -17.9 LUFS
  {
    const buf = new Float32Array(Math.round(1.3 * SR));
    const s = seedFor("premium", "voice-leave");
    addBellNote(buf, 0.0, NOTE.G5, 0.9, 0.45, s);
    addBellNote(buf, 0.12, NOTE.C5, 1.0, 0.55, s + 1013);
    addRoom(buf, ROOM_VOICE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 40, maxSec: 0.96 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.9, PEAK_CEIL);
    cues["voice-leave"] = trimmed;
  }

  // peer-join: ascending 5th (G4 -> D5), softer attack — 800ms, -20.0 LUFS
  {
    const buf = new Float32Array(Math.round(1.1 * SR));
    const s = seedFor("premium", "peer-join");
    addBellNote(buf, 0.0, NOTE.G4, 0.7, 0.38, s, 0.65);
    addBellNote(buf, 0.1, NOTE.D5, 0.8, 0.45, s + 1013, 0.65);
    addRoom(buf, ROOM_VOICE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 35, maxSec: 0.8 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -20.0, PEAK_CEIL);
    cues["peer-join"] = trimmed;
  }

  // peer-leave: descending 5th (D5 -> G4), softer attack — 750ms, -21.0 LUFS
  {
    const buf = new Float32Array(Math.round(1.0 * SR));
    const s = seedFor("premium", "peer-leave");
    addBellNote(buf, 0.0, NOTE.D5, 0.8, 0.38, s, 0.65);
    addBellNote(buf, 0.1, NOTE.G4, 0.7, 0.45, s + 1013, 0.65);
    addRoom(buf, ROOM_VOICE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 35, maxSec: 0.75 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -21.0, PEAK_CEIL);
    cues["peer-leave"] = trimmed;
  }

  // -----------------------------------------------------------------------
  // MESSAGES: transient-heavy pop with subtle body
  // Discord's message is 364 ms with -inf integrated LUFS — nearly all energy
  // in one sharp pop. The pop should be bright and distinctive.
  // -----------------------------------------------------------------------

  // message: a bright transient pop — 360ms, -20.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.5 * SR));
    const s = seedFor("premium", "message");
    // The pop: a fast pitch-drop from ~2800 Hz to ~700 Hz — wider sweep than before
    addSweepTone(buf, {
      start: 0.0, startHz: 2800, endHz: 700, peak: 0.5, durationSec: 0.08,
    });
    // Bright click at onset — the transient that makes it "pop"
    addStrike(buf, {
      start: 0.0, peak: 0.25, decayMs: 2.5,
      lowHz: 1800, highHz: 10000, poles: 2, seed: s,
    });
    // A subtle body resonance so the pop has weight, not just a click
    addModes(buf, {
      start: 0.002, freq: NOTE.D5, peak: 0.15, decaySec: 0.12,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.3, gain: 0.25, decayScale: 0.4 },
      ],
      detune: 5, seed: s + 7919,
    });
    addBody(buf, { start: 0.0, freq: 150, peak: 0.12, decaySec: 0.04 });
    addRoom(buf, ROOM_POP);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 25, maxSec: 0.36 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -20.0, PEAK_CEIL);
    cues["message"] = trimmed;
  }

  // mention: the pop + a brighter sparkle hit 80ms later — 500ms, -18.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.65 * SR));
    const s = seedFor("premium", "mention");
    // Same base pop
    addSweepTone(buf, {
      start: 0.0, startHz: 2800, endHz: 700, peak: 0.5, durationSec: 0.08,
    });
    addStrike(buf, {
      start: 0.0, peak: 0.25, decayMs: 2.5,
      lowHz: 1800, highHz: 10000, poles: 2, seed: s,
    });
    addBody(buf, { start: 0.0, freq: 150, peak: 0.12, decaySec: 0.04 });
    // Sparkle: higher-pitched pop 80ms later — brighter, more insistent
    addSweepTone(buf, {
      start: 0.08, startHz: 3800, endHz: 1200, peak: 0.35, durationSec: 0.06,
    });
    addStrike(buf, {
      start: 0.08, peak: 0.15, decayMs: 2.0,
      lowHz: 2800, highHz: 12000, poles: 2, seed: s + 2027,
    });
    // A bell tail so "mention" rings slightly longer than "message"
    addModes(buf, {
      start: 0.08, freq: NOTE.A5, peak: 0.12, decaySec: 0.15,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.0, gain: 0.3, decayScale: 0.5 },
      ],
      detune: 4, seed: s + 7919,
    });
    addRoom(buf, ROOM_POP);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 25, maxSec: 0.5 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -18.0, PEAK_CEIL);
    cues["mention"] = trimmed;
  }

  // -----------------------------------------------------------------------
  // SCREEN SHARE: filtered noise whoosh/sweep — longer, more dramatic
  // 600ms each to match Discord's screen cue duration range
  // -----------------------------------------------------------------------

  // screen-start: rising whoosh — 600ms, -17.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.8 * SR));
    const s = seedFor("premium", "screen-start");
    // Longer, wider rising noise sweep: 300 Hz -> 4000 Hz
    addNoiseSweep(buf, {
      start: 0.0, durationSec: 0.45, peak: 0.4,
      startHz: 300, endHz: 4000, bandwidth: 2500, seed: s,
    });
    // A punctuating bright click at the crest of the sweep
    addStrike(buf, {
      start: 0.35, peak: 0.2, decayMs: 3.0,
      lowHz: 1500, highHz: 8000, poles: 2, seed: s + 3571,
    });
    // A short bell tone at the end: "it's on"
    addModes(buf, {
      start: 0.36, freq: NOTE.C5, peak: 0.15, decaySec: 0.12,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.0, gain: 0.3, decayScale: 0.5 },
      ],
      detune: 3, seed: s + 7919,
    });
    addRoom(buf, ROOM_SWEEP);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.6 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.0, PEAK_CEIL);
    cues["screen-start"] = trimmed;
  }

  // screen-stop: falling whoosh — 600ms, -17.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.8 * SR));
    const s = seedFor("premium", "screen-stop");
    // Falling noise sweep: 4000 Hz -> 300 Hz
    addNoiseSweep(buf, {
      start: 0.0, durationSec: 0.45, peak: 0.4,
      startHz: 4000, endHz: 300, bandwidth: 2500, seed: s,
    });
    // Click at onset
    addStrike(buf, {
      start: 0.0, peak: 0.18, decayMs: 3.0,
      lowHz: 1500, highHz: 8000, poles: 2, seed: s + 3571,
    });
    // Low resolution tone at the end: "it's off"
    addModes(buf, {
      start: 0.35, freq: NOTE.G4, peak: 0.12, decaySec: 0.1,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.0, gain: 0.25, decayScale: 0.4 },
      ],
      detune: 3, seed: s + 7919,
    });
    addRoom(buf, ROOM_SWEEP);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.6 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.0, PEAK_CEIL);
    cues["screen-stop"] = trimmed;
  }

  // -----------------------------------------------------------------------
  // CALLS: melodic and warm, longer durations matching Discord
  // -----------------------------------------------------------------------

  // call-connected: warm chord resolve (C5 + E5 + G5) — 800ms, -17.0 LUFS
  {
    const buf = new Float32Array(Math.round(1.1 * SR));
    const s = seedFor("premium", "call-connected");
    // A warm 3-note chord with staggered entries and long decay
    addBellNote(buf, 0.0, NOTE.C5, 0.8, 0.4, s);
    addBellNote(buf, 0.04, NOTE.E5, 0.75, 0.4, s + 1013);
    addBellNote(buf, 0.08, NOTE.G5, 0.85, 0.5, s + 2026);
    addRoom(buf, ROOM_CALL);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 35, maxSec: 0.8 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -17.0, PEAK_CEIL);
    cues["call-connected"] = trimmed;
  }

  // call-ended: gentle descending tone — 1200ms, -18.8 LUFS (matching Discord's "deconnected")
  {
    const buf = new Float32Array(Math.round(1.5 * SR));
    const s = seedFor("premium", "call-ended");
    // Three descending notes with long fading tails
    addBellNote(buf, 0.0, NOTE.G5, 0.75, 0.35, s, 0.7);
    addBellNote(buf, 0.15, NOTE.E5, 0.8, 0.4, s + 1013, 0.7);
    addBellNote(buf, 0.3, NOTE.C5, 0.85, 0.5, s + 2026, 0.65);
    // A low body note that lingers: finality
    addBody(buf, { start: 0.3, freq: 130, peak: 0.15, decaySec: 0.2 });
    addRoom(buf, ROOM_CALL);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 40, maxSec: 1.2 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -18.8, PEAK_CEIL);
    cues["call-ended"] = trimmed;
  }

  // peer-left-call: descending pop fading away — 600ms, -20.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.8 * SR));
    const s = seedFor("premium", "peer-left-call");
    // A descending pop: higher to lower, the other side hung up
    addSweepTone(buf, {
      start: 0.0, startHz: 2000, endHz: 500, peak: 0.35, durationSec: 0.1,
    });
    addStrike(buf, {
      start: 0.0, peak: 0.15, decayMs: 3.0,
      lowHz: 1000, highHz: 6000, poles: 2, seed: s,
    });
    // A soft descending bell tail
    addModes(buf, {
      start: 0.05, freq: NOTE.C5, peak: 0.12, decaySec: 0.2,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.0, gain: 0.25, decayScale: 0.5 },
      ],
      detune: 4, seed: s + 7919,
    });
    addBody(buf, { start: 0.0, freq: 120, peak: 0.1, decaySec: 0.06 });
    addRoom(buf, ROOM_POP);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 30, maxSec: 0.6 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -20.0, PEAK_CEIL);
    cues["peer-left-call"] = trimmed;
  }

  // error: low "bonk" with more body — 500ms, -16.0 LUFS
  {
    const buf = new Float32Array(Math.round(0.65 * SR));
    const s = seedFor("premium", "error");
    // Dull low noise thud — longer than before
    addStrike(buf, {
      start: 0.0, peak: 0.6, decayMs: 15.0,
      lowHz: 80, highHz: 1400, poles: 3, seed: s,
    });
    // Detuned low modes: slightly inharmonic for "bonk" quality
    addModes(buf, {
      start: 0.0, freq: 165, peak: 0.4, decaySec: 0.18,
      partials: [
        { ratio: 1.0, gain: 1.0, decayScale: 1.0 },
        { ratio: 2.3, gain: 0.3, decayScale: 0.4 },
        { ratio: 3.7, gain: 0.12, decayScale: 0.2 },
      ],
      detune: 15,
      seed: s + 7919,
    });
    addBody(buf, { start: 0.0, freq: 80, peak: 0.35, decaySec: 0.08 });
    addRoom(buf, ROOM_TOGGLE);
    const trimmed = trimTail(buf, { floorDb: 60, fadeMs: 25, maxSec: 0.5 });
    fadeEdges(trimmed, 2);
    normalizeLufsLimited(trimmed, -16.0, PEAK_CEIL);
    cues["error"] = trimmed;
  }

  // -----------------------------------------------------------------------
  // RINGS: memorable melodic patterns, matching Discord's durations
  // incoming = 5300ms, outgoing = 2400ms
  // -----------------------------------------------------------------------

  // ring-incoming: catchy ascending+descending arpeggio — 5300ms, -18.3 LUFS
  // Pattern: E5 - G5 - B5 - E6 (ascending), pause, E6 - B5 - G5 - E5 (descending)
  // Then a longer silence before the loop repeats
  {
    const buf = new Float32Array(Math.round(5.3 * SR));
    const s = seedFor("premium", "ring-incoming");
    // First phrase: ascending major arpeggio — wider spacing for drama
    addBellNote(buf, 0.0, NOTE.E5, 0.9, 0.55, s);
    addBellNote(buf, 0.22, NOTE.G5, 0.85, 0.55, s + 1013);
    addBellNote(buf, 0.44, NOTE.B5, 0.9, 0.55, s + 2026);
    addBellNote(buf, 0.66, NOTE.E6, 1.0, 0.65, s + 3039);
    // Second phrase: descending resolution after a pause
    addBellNote(buf, 1.4, NOTE.E6, 0.85, 0.5, s + 4052);
    addBellNote(buf, 1.62, NOTE.B5, 0.9, 0.5, s + 5065);
    addBellNote(buf, 1.84, NOTE.G5, 0.85, 0.55, s + 6078);
    addBellNote(buf, 2.06, NOTE.E5, 1.0, 0.7, s + 7091);
    // Third phrase: a short "reminder" — just the top two notes
    addBellNote(buf, 3.0, NOTE.B5, 0.8, 0.5, s + 8104);
    addBellNote(buf, 3.22, NOTE.E6, 0.9, 0.6, s + 9117);
    // Long silence for the rest of the period (the loop gap)
    addRoom(buf, ROOM_RING);
    fadeEdges(buf, 2);
    normalizeLufsLimited(buf, -18.3, PEAK_CEIL);
    rings["ring-incoming"] = buf;
  }

  // ring-outgoing: gentle 2-note pattern — 2400ms, -16.6 LUFS
  {
    const buf = new Float32Array(Math.round(2.4 * SR));
    const s = seedFor("premium", "ring-outgoing");
    // Gentle two-note: G5 then E5 (descending major 3rd, like a "waiting" tone)
    addBellNote(buf, 0.0, NOTE.G5, 0.75, 0.5, s, 0.75);
    addBellNote(buf, 0.35, NOTE.E5, 0.7, 0.55, s + 1013, 0.75);
    // Silence, then repeat (but the period is shorter so it repeats sooner)
    addBellNote(buf, 1.1, NOTE.G5, 0.7, 0.5, s + 2026, 0.7);
    addBellNote(buf, 1.45, NOTE.E5, 0.65, 0.55, s + 3039, 0.7);
    addRoom(buf, ROOM_RING);
    fadeEdges(buf, 2);
    normalizeLufsLimited(buf, -16.6, PEAK_CEIL);
    rings["ring-outgoing"] = buf;
  }

  return { cues, rings };
}

/** Every selectable family id, in listening order (new candidates first). */
const FAMILY_IDS = ["premium", "porcelain", "teaglass", "stoneware", "felt", "marimba", "glass"];

/** Founder-facing label/blurb for a family id. */
function familyInfo(id) {
  if (id === "premium") {
    return {
      label: "Premium",
      blurb:
        "Discord-seviye: toggle'lar perkusif gürültü, ses olayları çan, mesajlar pop, ekran paylaşımı whoosh, ziller melodi — her kategori farklı tınıda.",
    };
  }
  const fam = FAMILIES.find((f) => f.id === id);
  if (!fam) throw new Error(`unknown family "${id}"`);
  return { label: fam.label, blurb: fam.blurb };
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
      "-i", tmpWav, "-ac", "1", "-c:a", "libvorbis", "-q:a", "4",
      // bitexact: fixed Ogg stream serial + no encoder tag, so a regenerate of
      // unchanged audio produces byte-identical files (no phantom diffs).
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1",
      tmpOgg,
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

/** Resolve a repo-relative path (or pass an absolute one through). */
function resolveOut(p) {
  return isAbsolute(p) ? p : join(ROOT, p);
}

async function writeBytes(path, bytes) {
  const abs = resolveOut(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return path;
}

/**
 * In-place iterative radix-2 FFT (re/im arrays, length a power of two). Only
 * used for the measurement column — the synthesis never touches the frequency
 * domain.
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Spectral shape of the whole cue (power spectrum of the first <= 1.36 s):
 * centroid in Hz ("how bright it reads") and the share of power above 3 kHz.
 */
function spectrum(buf) {
  let n = 1;
  while (n < Math.min(buf.length, 65536)) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < Math.min(buf.length, n); i++) re[i] = buf[i];
  fft(re, im);
  let tot = 0;
  let wsum = 0;
  let hi = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const hz = (k * SR) / n;
    tot += p;
    wsum += p * hz;
    if (hz >= 3000) hi += p;
  }
  return tot > 0 ? { centroidHz: wsum / tot, hiPct: (100 * hi) / tot } : { centroidHz: 0, hiPct: 0 };
}

/**
 * How far under the peak the cue already was when the tail fade began (dB). A
 * fade that starts at <= -40 dB is shaping room tail, not cutting a note.
 * `fadeMs` must match the trimTail fade; a loop file reports its last 30 ms.
 */
function residualAtFadeDb(buf, fadeMs = 30) {
  const peak = peakOf(buf);
  const end = buf.length - Math.round((fadeMs / 1000) * SR);
  const from = Math.max(0, end - Math.round(0.01 * SR));
  let m = 0;
  for (let i = from; i < end; i++) m = Math.max(m, Math.abs(buf[i]));
  return peak > 0 ? dbfs(m / peak) : -Infinity;
}

/**
 * One measured row per cue — the build log doubles as the evidence trail, and
 * the listening page prints the same numbers next to every player.
 */
function measure(name, buf) {
  const peak = peakOf(buf);
  const thr = peak * fromDb(-40);
  let onset = 0;
  while (onset < buf.length && Math.abs(buf[onset]) < thr) onset++;
  const spec = spectrum(buf);
  return {
    name,
    durMs: (buf.length / SR) * 1000,
    peakDb: dbfs(peak),
    loudDb: dbfs(loudness(buf)),
    lufs: maxMomentaryLufs(buf),
    onsetMs: (onset / SR) * 1000,
    residualDb: residualAtFadeDb(buf),
    centroidHz: spec.centroidHz,
    hiPct: spec.hiPct,
  };
}

function fmt(n, d = 1) {
  return Number.isFinite(n) ? n.toFixed(d) : "-inf";
}

function printMeasurements(rows) {
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(15)} ${fmt(r.durMs, 0).padStart(4)} ms  ` +
        `LUFS-M ${fmt(r.lufs).padStart(6)}  peak ${fmt(r.peakDb).padStart(6)} dBFS  ` +
        `onset ${fmt(r.onsetMs, 2).padStart(5)} ms  cut ${fmt(r.residualDb, 0).padStart(4)} dB  ` +
        `centroid ${fmt(r.centroidHz, 0).padStart(5)} Hz  >3k ${fmt(r.hiPct).padStart(5)} %`,
    );
  }
}

/** Families on the listening page: the three new candidates, then the shipped one. */
const PREVIEW_IDS = ["premium", "porcelain", "teaglass", "stoneware", "felt"];
/** The family that is live in production before this refresh (the "old" column). */
const PREVIOUS_FAMILY = "felt";

/** Founder-facing meaning of every event, for the listening page. */
const EVENT_INFO = {
  "voice-join": "Sesli kanala sen katıldın",
  "voice-leave": "Sesli kanaldan sen ayrıldın",
  "peer-join": "Kanalına biri katıldı",
  "peer-leave": "Kanalından biri ayrıldı",
  mute: "Mikrofon kapandı",
  unmute: "Mikrofon açıldı",
  deafen: "Sağırlaştırma açıldı (YENİ)",
  undeafen: "Sağırlaştırma kapandı (YENİ)",
  "screen-start": "Ekran paylaşımı başladı",
  "screen-stop": "Ekran paylaşımı bitti",
  message: "Yeni mesaj",
  mention: "Sana @bahsetme (YENİ)",
  "call-connected": "Arama bağlandı (YENİ)",
  "call-ended": "Arama bitti / reddedildi (YENİ)",
  "peer-left-call": "Karşı taraf aramadan çıktı (YENİ)",
  error: "Hata — mikrofon izni, cihaz, bağlantı (YENİ)",
  "ring-incoming": "Gelen arama zili (döngü)",
  "ring-outgoing": "Giden arama bekleme sesi (döngü)",
};

/** Events the previously shipped set did NOT have (no "old" sound to compare). */
const NEW_EVENTS = new Set([
  "deafen", "undeafen", "mention", "call-connected", "call-ended", "peer-left-call", "error",
]);

/**
 * Preview mode: render the candidate families into `<out>/<family>/` and drop a
 * self-contained, event-major HTML player next to them (old vs every candidate,
 * measured stats beside each). Touches no shipping asset.
 */
async function writePreviews(outDir, ext, ogg) {
  /** @type {Record<string, Record<string, ReturnType<typeof measure> & { file:string }>>} */
  const byEvent = {};
  for (const id of PREVIEW_IDS) {
    console.log(`\nFamily: ${id}`);
    const { cues, rings } = buildFamily(id);
    const rows = [];
    for (const [name, buf] of Object.entries(cues)) {
      const wav = encodeWav(buf);
      const bytes = ogg ? await wavToOgg(wav, `${id}-${name}`) : wav;
      const file = `${id}/${name}.${ext}`;
      await writeBytes(join(outDir, file), bytes);
      const row = measure(name, buf);
      rows.push(row);
      (byEvent[name] ??= {})[id] = { ...row, file };
    }
    for (const [name, buf] of Object.entries(rings)) {
      const file = `${id}/${name}.wav`;
      await writeBytes(join(outDir, file), encodeWav(buf));
      const row = measure(name, buf);
      rows.push(row);
      (byEvent[name] ??= {})[id] = { ...row, file };
    }
    printMeasurements(rows);
  }
  await writeBytes(join(outDir, "stats.json"), Buffer.from(JSON.stringify(byEvent, null, 2), "utf8"));
  await writeBytes(join(outDir, "index.html"), Buffer.from(previewHtml(byEvent), "utf8"));
  console.log(`\nPreview player: ${join(outDir, "index.html")}`);
}

/** Self-contained listening page (no network, no build step, dark-first). */
function previewHtml(byEvent) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const stat = (r) =>
    `${fmt(r.durMs, 0)} ms · ${fmt(r.lufs)} LUFS · tepe ${fmt(r.peakDb)} dBFS · merkez ${fmt(r.centroidHz, 0)} Hz`;
  const head = PREVIEW_IDS.map((id) => {
    const { label } = familyInfo(id);
    const tag =
      id === ACTIVE_FAMILY ? " ★ seçilen" : id === PREVIOUS_FAMILY ? " · şu an yayında" : "";
    return `<th>${esc(label)}<small>${esc(id)}${esc(tag)}</small></th>`;
  }).join("");
  const rows = Object.keys(EVENT_INFO)
    .map((name) => {
      const cells = PREVIEW_IDS.map((id) => {
        const r = byEvent[name]?.[id];
        if (!r) return "<td>—</td>";
        let note = "";
        if (id === PREVIOUS_FAMILY && NEW_EVENTS.has(name)) note = "eski sette yoktu — keçe tınısıyla örnek";
        if (id === PREVIOUS_FAMILY && name.startsWith("ring-")) note = "mobilde yayında; masaüstü eskiden sinüs bip sentezliyordu";
        return `<td class="${id === ACTIVE_FAMILY ? "pick" : ""}"><audio controls preload="none" src="${esc(r.file)}"></audio><small>${esc(stat(r))}</small>${note ? `<em>${esc(note)}</em>` : ""}</td>`;
      }).join("");
      return `<tr><th scope="row">${esc(EVENT_INFO[name])}<small>${esc(name)}</small></th>${cells}</tr>`;
    })
    .join("\n");
  const blurbs = PREVIEW_IDS.map((id) => {
    const { label, blurb } = familyInfo(id);
    return `<li><b>${esc(label)}</b> — ${esc(blurb)}</li>`;
  }).join("");
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demli — Koyu Masa sesleri</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:28px 16px;background:#0f0d0b;color:#ece6df;
  font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 6px}
p,li{color:#a59c92;font-size:13px}
ul{margin:0 0 20px;padding-left:18px}
.wrap{overflow-x:auto;border:1px solid #2a2520;border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:980px}
th,td{padding:10px 12px;border-bottom:1px solid #2a2520;vertical-align:top;text-align:left}
thead th{background:#17130f;font-weight:600}
th small,td small{display:block;color:#8a8178;font-size:11px;font-weight:400;margin-top:3px}
td em{display:block;color:#c79a5b;font-size:11px;font-style:normal;margin-top:2px}
td.pick{background:#1c1712}
audio{width:220px;height:32px}
code{background:#1c1712;border:1px solid #2a2520;border-radius:5px;padding:1px 5px;font-size:12px}
</style></head><body>
<h1>Demli — "Koyu Masa" ses ailesi: eski vs adaylar</h1>
<p>Hepsi depoda sıfırdan sentezlendi (<code>scripts/gen-sounds.mjs</code>, üçüncü-parti örnek yok).
Ses düzeyi BS.1770 max-momentary LUFS (ffmpeg ebur128 ile aynı ölçü). ★ = ölçütlerle seçilen varsayılan;
başka bir aday için <code>ACTIVE_FAMILY</code>'yi değiştirip <code>pnpm gen:sounds</code> çalıştır.</p>
<ul>${blurbs}</ul>
<div class="wrap"><table>
<thead><tr><th>Olay</th>${head}</tr></thead>
<tbody>
${rows}
</tbody></table></div>
</body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const familyArg = args.find((a) => a.startsWith("--family="));
  const outArg = args.find((a) => a.startsWith("--out="));
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
  if (!ogg && !preview) {
    // Both clients import .ogg; a WAV fallback would leave stale Ogg files in
    // place that silently keep shipping. Fail loudly instead.
    console.error("  ffmpeg is required to write the shipping assets (both clients import .ogg).");
    process.exit(1);
  }
  const ext = ogg ? "ogg" : "wav";

  if (preview) {
    const outDir = outArg ? outArg.slice("--out=".length) : PREVIEW_DIR;
    console.log(`\nPREVIEW MODE — writing candidates to ${outDir}/ (no shipping asset touched).`);
    await writePreviews(outDir, ext, ogg);
    console.log("\nDone.");
    return;
  }

  console.log(`\nFamily: ${family} (${familyInfo(family).label})`);
  const { cues, rings } = buildFamily(family);

  console.log("\nOne-shot cues (desktop + mobile, Ogg):");
  const cueRows = [];
  for (const [name, buf] of Object.entries(cues)) {
    const bytes = await wavToOgg(encodeWav(buf), name);
    cueRows.push(measure(name, buf));
    await writeBytes(`${DESKTOP_DIR}/${name}.ogg`, bytes);
    await writeBytes(`${MOBILE_DIR}/${name}.ogg`, bytes);
  }
  printMeasurements(cueRows);

  // Rings: the SAME audio on both clients. Mobile keeps WAV (decodes everywhere
  // with expo-audio, and Metro bundles it by default); desktop gets Ogg — its
  // renderer decodes Vorbis natively and it is ~20x smaller in the installer.
  console.log("\nRing cadences (desktop Ogg loop + mobile WAV loop):");
  const ringRows = [];
  for (const [name, buf] of Object.entries(rings)) {
    const wav = encodeWav(buf);
    ringRows.push(measure(name, buf));
    await writeBytes(`${MOBILE_DIR}/${name}.wav`, wav);
    await writeBytes(`${DESKTOP_DIR}/${name}.ogg`, await wavToOgg(wav, name));
  }
  printMeasurements(ringRows);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
