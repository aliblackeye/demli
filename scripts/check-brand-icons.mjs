#!/usr/bin/env node
// @ts-check
/**
 * Brand-asset drift check — the regression test for "the logo looks small".
 *
 * WHAT WENT WRONG, so it is obvious what this guards: the 1024px master carried
 * ~11.7% transparent padding on every edge. gen-icons treated that framing as
 * authoritative, so all 30+ derivatives inherited it, the mark rendered ~23%
 * smaller than its canvas everywhere, and two call sites were patched with CSS
 * scaling to compensate. Nothing in the pipeline noticed, because nothing
 * measured.
 *
 * WHAT THIS DOES: reads assets/brand/brand-manifest.json — the same contract
 * scripts/gen-icons.mjs renders from — and verifies every COMMITTED file still
 * matches it:
 *
 *   - the master has zero padding on its dominant axis
 *   - every transparent target's ink spans its declared safe area (+/-3%, with
 *     a 2px floor so a one-pixel antialias fringe cannot fail a 16px icon)
 *   - every opaque target really is opaque and correctly sized (iOS rejects app
 *     icons with an alpha channel; PWA maskable assumes an edge-to-edge plate)
 *   - .ico bundles exist and are non-trivial
 *   - the SVG wrappers stay inside their byte budget, so an inlined base64
 *     payload cannot silently balloon back to 113 KB
 *
 * Run: pnpm test:brand   (also wired into `pnpm lint`)
 * Fix: pnpm gen:icons && git add -A
 */
/* global console, process */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { inkBox, toleranceFor } from "./lib/ink-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MANIFEST = join(ROOT, "assets/brand/brand-manifest.json");

/** @type {string[]} */
const failures = [];
let checked = 0;

/** @param {string} message */
function fail(message) {
  failures.push(message);
}

/**
 * @param {string} relPath
 * @returns {Promise<Buffer|null>}
 */
async function readAsset(relPath) {
  try {
    return await readFile(join(ROOT, relPath));
  } catch {
    fail(`${relPath}: missing (run \`pnpm gen:icons\`)`);
    return null;
  }
}

/**
 * @param {any} manifest
 * @param {any} target
 * @returns {number|null}
 */
function expectedCoverage(manifest, target) {
  if (!target.safeArea) return null;
  const entry = manifest.safeArea[target.safeArea];
  if (!entry) {
    fail(`${target.path}: references unknown safeArea "${target.safeArea}"`);
    return null;
  }
  return entry.value;
}

async function main() {
  /** @type {any} */
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const baseTolerance = manifest.defaults?.tolerance ?? 0.03;

  // --- 1. The master itself ------------------------------------------------
  const masterBuf = await readAsset(manifest.master.path);
  if (masterBuf) {
    checked += 1;
    const box = await inkBox(masterBuf);
    const expected = manifest.master.coverage;
    const tolerance = toleranceFor(box.canvasWidth, baseTolerance);
    if (Math.abs(box.coverage - expected) > tolerance) {
      fail(
        `${manifest.master.path}: ink coverage ${(box.coverage * 100).toFixed(1)}% ` +
          `but the master must be cropped to its ink (${(expected * 100).toFixed(1)}% ` +
          `+/-${(tolerance * 100).toFixed(1)}%). Transparent padding here is inherited by ` +
          `EVERY derived icon — crop it, do not scale it up at the call site.`,
      );
    }
    if (box.canvasWidth !== box.canvasHeight) {
      fail(`${manifest.master.path}: not square (${box.canvasWidth}x${box.canvasHeight})`);
    }
  }

  // --- 2. Every declared PNG target ---------------------------------------
  for (const target of manifest.targets) {
    const buf = await readAsset(target.path);
    if (!buf) continue;
    checked += 1;
    const box = await inkBox(buf);

    if (box.canvasWidth !== target.size || box.canvasHeight !== target.size) {
      fail(
        `${target.path}: is ${box.canvasWidth}x${box.canvasHeight}, manifest declares ${target.size}`,
      );
      continue;
    }

    const opaque = (target.alpha ?? "keep") === "drop";
    if (opaque) {
      // Ink coverage is meaningless once the canvas is fully painted, so assert
      // the property that actually matters for these surfaces instead.
      if (box.hasAlpha) {
        fail(
          `${target.path}: declares alpha "drop" but the file still has an alpha channel ` +
            `(iOS rejects app icons with one; PWA maskable needs an edge-to-edge plate)`,
        );
      }
      continue;
    }

    if (!box.hasAlpha) {
      fail(`${target.path}: expected a transparent canvas but the file has no alpha channel`);
      continue;
    }

    const expected = expectedCoverage(manifest, target);
    if (expected === null) continue; // render-only entry (badge, unread tray)
    const tolerance = toleranceFor(target.size, baseTolerance);
    const delta = box.coverage - expected;
    if (Math.abs(delta) > tolerance) {
      fail(
        `${target.path}: ink coverage ${(box.coverage * 100).toFixed(1)}%, expected ` +
          `${(expected * 100).toFixed(1)}% +/-${(tolerance * 100).toFixed(1)}% ` +
          `(safeArea "${target.safeArea}", off by ${(delta * 100).toFixed(1)} points). ` +
          `Run \`pnpm gen:icons\`; if the change is intentional, update brand-manifest.json.`,
      );
    }
  }

  // --- 3. .ico bundles -----------------------------------------------------
  for (const icon of manifest.icons) {
    const buf = await readAsset(icon.path);
    if (!buf) continue;
    checked += 1;
    // ICONDIR header: reserved(0), type(1 = icon), count.
    const type = buf.readUInt16LE(2);
    const count = buf.readUInt16LE(4);
    if (type !== 1) fail(`${icon.path}: not an ICO file (type ${type})`);
    if (count !== icon.sizes.length) {
      fail(`${icon.path}: has ${count} frames, manifest declares ${icon.sizes.length}`);
    }
  }

  // --- 4. SVG wrappers -----------------------------------------------------
  for (const wrapper of manifest.wrappers) {
    let info;
    try {
      info = await stat(join(ROOT, wrapper.path));
    } catch {
      fail(`${wrapper.path}: missing (run \`pnpm gen:icons\`)`);
      continue;
    }
    checked += 1;
    if (info.size > wrapper.maxBytes) {
      fail(
        `${wrapper.path}: ${info.size}b exceeds its ${wrapper.maxBytes}b budget. ` +
          `This file is an SVG wrapper around an inlined PNG — it used to weigh 113 KB ` +
          `because it inlined a padded 256px tile. Regenerate with \`pnpm gen:icons\`.`,
      );
    }
    const svg = await readFile(join(ROOT, wrapper.path), "utf8");
    if (!svg.startsWith("<svg")) fail(`${wrapper.path}: does not start with <svg`);
    // An SVG favicon is rendered in a restricted mode: an external reference
    // would simply not paint, so the raster must stay a data: URI.
    if (/href\s*=\s*"(?!data:)/.test(svg)) {
      fail(`${wrapper.path}: references an external resource; SVG favicons must inline theirs`);
    }
  }

  // --- Report --------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nBrand asset check FAILED (${failures.length} of ${checked} assets):\n`);
    for (const f of failures) console.error(`  x ${f}`);
    console.error("\nRegenerate with: pnpm gen:icons\n");
    process.exit(1);
  }
  console.log(`Brand assets OK — ${checked} files match assets/brand/brand-manifest.json.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
