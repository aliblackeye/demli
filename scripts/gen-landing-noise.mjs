#!/usr/bin/env node
/* global console, Buffer */
/**
 * The landing's film-grain tile — generated, not sourced.
 *
 * A 256×256 greyscale PNG of seeded white noise, shaped so most pixels stay
 * dark and a sparse few catch the light (value = u^3.6, mean ≈ 0.22). The page
 * tiles it at 128px under `mix-blend-mode: screen` and a radial mask, so only
 * the bright specks read — a soft grain over the light rays.
 *
 * Deterministic (fixed seed): re-running produces the identical file.
 *
 *   node scripts/gen-landing-noise.mjs
 *   → apps/landing/public/images/grain.png
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/landing/public/images/grain.png");
const SIZE = 256;
const SEED = 0x64656d6c; // "deml"

/** mulberry32 — small, seedable, good enough for texture. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const next = rng(SEED);
const pixels = Buffer.alloc(SIZE * SIZE);
for (let i = 0; i < pixels.length; i += 1) {
  pixels[i] = Math.round(Math.pow(next(), 3.6) * 254) + 1;
}

await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 1 } })
  .png({ compressionLevel: 9 })
  .toFile(OUT);
console.log(`wrote ${OUT}`);
