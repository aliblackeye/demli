#!/usr/bin/env node
// @ts-check
/**
 * Demli brand icon generator — SINGLE SOURCE OF TRUTH.
 *
 * There is exactly one logo file, `assets/brand/logo.png`, and one contract,
 * `assets/brand/brand-manifest.json`. Every icon the desktop, mobile, web and
 * landing surfaces ship is derived here, so re-branding is a one-file swap:
 *
 *     1. replace  assets/brand/logo.png
 *     2. run      pnpm gen:icons
 *     3. commit   the regenerated outputs
 *
 * TWO RULES, and they are the whole point of this file:
 *
 *   1. PADDING DIES AT THE SOURCE. The master is normalised to its ink bounding
 *      box before anything is derived from it, on EVERY run. A logo exported
 *      with transparent margin (the previous master had ~11.7% per edge) must
 *      not leak that margin into 30+ downstream assets and force call sites to
 *      compensate with CSS scaling.
 *   2. SAFE AREAS ARE DECLARED, NOT SCATTERED. How much of a canvas the mark may
 *      span depends on the surface — an Android adaptive foreground gets masked
 *      to a 72/108 circle, a launcher tile is edge to edge, a status-bar glyph
 *      follows the Material live area. Those numbers live in
 *      brand-manifest.json's `safeArea` block and nowhere else, and
 *      scripts/check-brand-icons.mjs verifies the committed files still match.
 *
 * Extra sources that cannot be derived from the colour tile:
 *   assets/brand/demli-character.png ... plate-less tray art (a detailed plated
 *                                        tile is illegible at 16-32px)
 *   assets/brand/notification-mark.png . Android status-bar glyph source
 *                                        (the system renders alpha only)
 *   assets/brand/logo-original.png ..... the pre-crop 1024px export, kept as
 *                                        provenance; nothing derives from it.
 *
 * Run:  node scripts/gen-icons.mjs             (derive everything)
 *       node scripts/gen-icons.mjs --skip-web  (desktop + mobile only)
 * Deps: sharp (raster + resize + recolour), png-to-ico (multi-size .ico).
 */
/* global console, Buffer */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import process from "node:process";
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { inkBox, normaliseToInk, TRANSPARENT } from "./lib/ink-box.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const LOGO = join(ROOT, "assets/brand/logo.png");
const NOTIFICATION_MARK = join(ROOT, "assets/brand/notification-mark.png");
const TRAY_CHARACTER = join(ROOT, "assets/brand/demli-character.png");
const MANIFEST = join(ROOT, "assets/brand/brand-manifest.json");

// ---------------------------------------------------------------------------
// Brand tokens
// ---------------------------------------------------------------------------
const BRAND = "#f55416"; // canonical warm Demli orange
const BRAND_TOP = "#ff8c1a"; // warm amber
const BRAND_BOTTOM = "#d90429"; // deep tea red
const SPLASH_BG = "#24273a"; // app backdrop (Catppuccin base)
const CORNER_RATIO = 0.225; // iOS-squircle-ish corner radius as a fraction of size

// Unread notification badge (tray red dot) — küçük ve yüksek kontrastlı. A vivid red
// core with a light halo so it reads on both dark (default Win11) and light trays.
const UNREAD_DOT = "#f23f43";
const UNREAD_RING = "#ffffff";
// Tray voice-state glyphs (mic muted / deafened). Mid-luminance warm brand ramp
// so the glyph separates from BOTH a dark (Win11 default) and a light tray, with
// the "off" slash in a vivid red that no other tray element uses.
const GLYPH_TOP = "#ffab3d";
const GLYPH_BOTTOM = "#f4470f";
const GLYPH_SLASH = "#ff3b30";
// Luminance -> warm brand ramp for the box-less tray character (deep tea red ->
// brand orange -> cream steam). Keeps the plate-less mark on-brand with the icon.
const TRAY_RAMP = [
  { t: 0.0, r: 0x6e, g: 0x0a, b: 0x12 },
  { t: 0.5, r: 0xd9, g: 0x2b, b: 0x0a },
  { t: 0.78, r: 0xff, g: 0x8c, b: 0x1a },
  { t: 1.0, r: 0xff, g: 0xe6, b: 0xc8 },
];

const PNG_OPTS = { compressionLevel: 9, effort: 10 };

/**
 * @typedef {object} Target
 * @property {string} path
 * @property {number} size
 * @property {string} [safeArea]
 * @property {"cover"|"contain"} [fit]
 * @property {"keep"|"drop"} [alpha]
 * @property {string} [render]
 * @property {string} [why]
 */

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Resolve a target's safe area (the fraction of the canvas the mark may span)
 * from the manifest's `safeArea` block. Throws rather than defaulting, so a
 * typo is a loud failure instead of a silently mis-sized icon.
 *
 * @param {any} manifest
 * @param {Target} target
 * @returns {number}
 */
function safeAreaFor(manifest, target) {
  if (!target.safeArea) {
    throw new Error(`brand-manifest: target ${target.path} declares no safeArea`);
  }
  const entry = manifest.safeArea[target.safeArea];
  if (!entry) {
    throw new Error(
      `brand-manifest: target ${target.path} references unknown safeArea "${target.safeArea}"`,
    );
  }
  return entry.value;
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/** The warm brand plate (rounded or square) as a PNG buffer. */
async function renderPlate(size, { rounded = false } = {}) {
  const r = size * CORNER_RATIO;
  const shape = rounded
    ? `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>`
    : `<rect width="${size}" height="${size}" fill="url(#g)"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${BRAND_TOP}"/><stop offset="1" stop-color="${BRAND_BOTTOM}"/>` +
    `</linearGradient></defs>${shape}</svg>`;
  return sharp(Buffer.from(svg)).png(PNG_OPTS).toBuffer();
}

/**
 * Opaque backing for a FULL-BLEED tile.
 *
 * The artwork is a rounded plate: at coverage 1 its corners are transparent,
 * and an icon that reaches iOS or a launcher with a transparent corner gets a
 * black one (which is exactly what the previous pipeline shipped, via a
 * `{r:1,g:1,b:1}` canvas). Filling with a flat brand colour or a guessed
 * vertical gradient leaves a visible seam, because the artwork's own plate is
 * not painted with either.
 *
 * So the backing is the artwork itself, blown past the canvas and blurred: the
 * corner pixels then continue whatever gradient the art actually uses. No
 * guessing, no seam, and it keeps working if the logo is redrawn.
 *
 * @param {Buffer} master
 * @param {number} size
 */
async function edgeExtendPlate(master, size) {
  const over = Math.round(size * 1.35);
  const inset = Math.round((over - size) / 2);
  const blown = await sharp(master)
    .resize(over, over, { fit: "cover", kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTS)
    .toBuffer();
  return sharp(blown)
    .extract({ left: inset, top: inset, width: size, height: size })
    .blur(Math.max(1, size * 0.05))
    .flatten({ background: BRAND })
    .png(PNG_OPTS)
    .toBuffer();
}

/**
 * Render the mark onto a `size` square.
 *
 * `safeArea` is the fraction of the canvas the mark spans; `fit` decides what
 * happens to the leftovers:
 *   contain — the whole mark fits inside safeArea*size, transparent elsewhere.
 *             Preserves the master's rounded corners.
 *   cover   — the mark is scaled to FILL safeArea*size and the overflow is
 *             cropped. Used for opaque OS tiles, where the platform applies its
 *             own mask and the artwork's rounded corner would only show up as a
 *             dark notch inside it.
 *
 * @param {Buffer} master Normalised (zero-padding) master.
 * @param {{ size: number, safeArea: number, fit: "cover"|"contain", background?: Buffer|null, alpha: "keep"|"drop" }} opts
 */
async function renderMark(master, { size, safeArea, fit, background = null, alpha }) {
  const markPx = Math.max(1, Math.round(safeArea * size));
  const mark = await sharp(master)
    .resize(markPx, markPx, {
      fit,
      position: "centre",
      background: TRANSPARENT,
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .png(PNG_OPTS)
    .toBuffer();

  const offset = Math.round((size - markPx) / 2);
  const base = background
    ? sharp(background)
    : sharp({ create: { width: size, height: size, channels: 4, background: TRANSPARENT } });

  let image = base.composite([{ input: mark, left: offset, top: offset }]);
  // Opaque surfaces must carry NO alpha channel: iOS rejects app icons that do,
  // and the PWA maskable contract assumes the plate reaches every edge. Callers
  // hand these a gradient plate as `background`, so flatten only ever has the
  // artwork's own antialiased corner pixels left to resolve — but it still runs,
  // because an icon that reaches the OS with a transparent corner gets a BLACK
  // one, which is exactly what the previous pipeline shipped.
  if (alpha === "drop") {
    image = sharp(await image.png(PNG_OPTS).toBuffer())
      .flatten({ background: BRAND })
      .removeAlpha();
  }
  return image.png(PNG_OPTS).toBuffer();
}

/**
 * Android status-bar icon: an alpha-only silhouette painted pure white, placed
 * at the Material live-area coverage. Android renders ONLY the alpha channel
 * and tints it itself, so colour in the source is irrelevant — padding is not,
 * which is why the source gets trimmed to its ink like everything else.
 *
 * @param {Buffer} source
 * @param {{ size: number, safeArea: number }} opts
 */
async function monoSilhouette(source, { size, safeArea }) {
  const { buffer: trimmed } = await normaliseToInk(source);
  const placed = await renderMark(trimmed, { size, safeArea, fit: "contain", alpha: "keep" });
  const alphaChannel = await sharp(placed).extractChannel(3).toColourspace("b-w").png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .joinChannel(alphaChannel)
    .png(PNG_OPTS)
    .toBuffer();
}

async function writePng(relPath, buf) {
  const abs = join(ROOT, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  const box = await inkBox(buf);
  console.log(
    `  ${relPath}  (${box.canvasWidth}x${box.canvasHeight}, alpha=${box.hasAlpha}, ` +
      `ink=${(box.coverage * 100).toFixed(1)}%, ${buf.length}b)`,
  );
}

async function writeIco(relPath, tile, sizes) {
  const buffers = await Promise.all(
    sizes.map((s) =>
      sharp(tile).resize(s, s, { kernel: sharp.kernel.lanczos3 }).png(PNG_OPTS).toBuffer(),
    ),
  );
  const ico = await pngToIco(buffers);
  const abs = join(ROOT, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, ico);
  console.log(`  ${relPath}  (${sizes.join(",")} px, ${ico.length}b)`);
}

/**
 * Write an SVG wrapper around a raster mark.
 *
 * These files stay `.svg` because renderer components and apps/web/index.html
 * import them BY NAME, and this pipeline does not own that source. The payload
 * is a data URI on purpose: browsers render SVG favicons in a restricted mode
 * that refuses EXTERNAL references, so a linked PNG would simply not paint. The
 * fix for the 113 KB these files used to weigh is therefore not "stop inlining"
 * — it is "stop inlining a padded 256px tile where a tight one at the size the
 * surface actually renders will do".
 *
 * @param {Buffer} master
 * @param {{ path: string, size: number, maxBytes: number }} wrapper
 */
async function writeSvgWrapper(master, wrapper) {
  const png = await sharp(master)
    .resize(wrapper.size, wrapper.size, {
      fit: "contain",
      background: TRANSPARENT,
      kernel: sharp.kernel.lanczos3,
    })
    .png(PNG_OPTS)
    .toBuffer();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wrapper.size}" height="${wrapper.size}" ` +
    `viewBox="0 0 ${wrapper.size} ${wrapper.size}">` +
    `<image width="${wrapper.size}" height="${wrapper.size}" ` +
    `href="data:image/png;base64,${png.toString("base64")}"/></svg>\n`;
  const bytes = Buffer.byteLength(svg, "utf8");
  if (bytes > wrapper.maxBytes) {
    throw new Error(
      `${wrapper.path} would be ${bytes}b, over its declared ${wrapper.maxBytes}b budget — ` +
        `lower the wrapper size in brand-manifest.json or optimise the master.`,
    );
  }
  const abs = join(ROOT, wrapper.path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, svg, "utf8");
  console.log(`  ${wrapper.path}  (${wrapper.size}px payload, ${bytes}b / ${wrapper.maxBytes}b)`);
}

async function writeWebp(relPath, source, size) {
  const abs = join(ROOT, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const output = await sharp(source)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .webp({ lossless: true })
    .toBuffer();
  await writeFile(abs, output);
  console.log(`  ${relPath}  (${size}x${size}, ${output.length}b)`);
}

// ---------------------------------------------------------------------------
// System-tray mark (box-less, on-brand) + unread badge
// ---------------------------------------------------------------------------

/**
 * Paint a transparent character into the warm Demli brand ramp by LUMINANCE
 * (dark -> deep tea red, mid -> brand orange, light -> cream), preserving the
 * source alpha + 3D shading. A single hue rotation can't do this (the source
 * has two far-apart hues); a luminance ramp yields a clean on-brand glass.
 */
async function brandGradientMap(srcBuf) {
  const { data, info } = await sharp(srcBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const lerp = (a, b, u) => Math.round(a + (b - a) * u);
  const ramp = (l) => {
    for (let i = 1; i < TRAY_RAMP.length; i++) {
      if (l <= TRAY_RAMP[i].t) {
        const s0 = TRAY_RAMP[i - 1];
        const s1 = TRAY_RAMP[i];
        const u = (l - s0.t) / (s1.t - s0.t);
        return [lerp(s0.r, s1.r, u), lerp(s0.g, s1.g, u), lerp(s0.b, s1.b, u)];
      }
    }
    const s = TRAY_RAMP[TRAY_RAMP.length - 1];
    return [s.r, s.g, s.b];
  };
  const out = Buffer.from(data);
  for (let i = 0; i < w * h; i++) {
    const p = i * c;
    if (data[p + 3] < 8) continue; // leave transparent pixels untouched
    const lum = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
    const [r, g, b] = ramp(lum);
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png(PNG_OPTS)
    .toBuffer();
}

/**
 * The plate-less, on-brand tray mark, trimmed to its ink so it fills the tray
 * canvas. Prefers the dedicated transparent character; if that is missing it
 * falls back to the plated tile so the build never breaks (just less legible at
 * small sizes).
 */
async function trayMarkBuffer(master) {
  try {
    await access(TRAY_CHARACTER);
    const painted = await brandGradientMap(await readFile(TRAY_CHARACTER));
    return (await normaliseToInk(painted)).buffer;
  } catch {
    console.warn(
      "  ! assets/brand/demli-character.png missing — tray falls back to the plated tile.",
    );
    return master;
  }
}

/** Fit a trimmed mark into a transparent `size` square at `safeArea`, supersampled. */
async function fitSquare(markBuf, size, safeArea) {
  const superN = 256;
  const inner = Math.round(superN * safeArea);
  const superTile = await sharp({
    create: { width: superN, height: superN, channels: 4, background: TRANSPARENT },
  })
    .composite([
      {
        input: await sharp(markBuf)
          .resize(inner, inner, {
            fit: "contain",
            background: TRANSPARENT,
            kernel: sharp.kernel.lanczos3,
          })
          .png(PNG_OPTS)
          .toBuffer(),
        gravity: "center",
      },
    ])
    .png(PNG_OPTS)
    .toBuffer();
  return sharp(superTile)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTS)
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Tray voice-state glyphs: microphone muted / deafened
// ---------------------------------------------------------------------------

/**
 * TWO OPTICAL SIZES, on purpose.
 *
 * The tray art is 16px at 100% DPI and 32px above it, and a glyph drawn once at
 * 24 units and scaled down to 16 turns to mush: the mic's stem and base each land
 * on ~1px and read as a smear. So each geometry below is drawn on the grid it
 * ships at — `large` (24 units → 32px) carries the full mic (body, cradle, stem,
 * base) and a taller headphone band; `small` (16 units → 16px) drops the mic stem,
 * fattens the base into one bar, and pushes the headphone cups outward so the
 * diagonal slash cannot swallow the right one.
 *
 * The founder's bar is that the slash is unmistakable at tray size, so the slash
 * is not merely drawn ON the glyph: a knockout line (`cut`, wider than `slash`)
 * is masked OUT of the artwork first. The transparent gap that leaves separates
 * the red bar from the orange glyph against a dark tray AND a light one, without
 * needing an outline that would itself vanish at 16px.
 */
const TRAY_GLYPHS = {
  large: {
    grid: 24,
    slash: 2.4,
    cut: 3.5,
    inset: 2.2,
    micOff:
      `<rect x="8.6" y="1.6" width="6.8" height="11.6" rx="3.4"/>` +
      `<path d="M4.4 10.8 v1.3 a7.6 7.6 0 0 0 15.2 0 v-1.3" fill="none" stroke="url(#g)" stroke-width="2.8" stroke-linecap="round"/>` +
      `<rect x="10.6" y="18.4" width="2.8" height="2.6"/>` +
      `<rect x="6.6" y="20.2" width="10.8" height="2.6" rx="1.3"/>`,
    deafened:
      `<path d="M3.0 13.6 v-1.4 a9.0 9.0 0 0 1 18 0 v1.4" fill="none" stroke="url(#g)" stroke-width="3.0" stroke-linecap="round"/>` +
      `<rect x="1.4" y="12.4" width="5.8" height="9.2" rx="2.9"/>` +
      `<rect x="16.8" y="12.4" width="5.8" height="9.2" rx="2.9"/>`,
  },
  small: {
    grid: 16,
    slash: 1.8,
    cut: 2.6,
    inset: 1.5,
    micOff:
      `<rect x="5.6" y="1.4" width="4.8" height="7.6" rx="2.4"/>` +
      `<path d="M3.0 7.4 v0.8 a5.0 5.0 0 0 0 10 0 v-0.8" fill="none" stroke="url(#g)" stroke-width="1.9" stroke-linecap="round"/>` +
      `<rect x="4.6" y="13.0" width="6.8" height="1.9" rx="0.95"/>`,
    deafened:
      `<path d="M2.2 9.6 v-1.4 a5.8 5.8 0 0 1 11.6 0 v1.4" fill="none" stroke="url(#g)" stroke-width="2.0" stroke-linecap="round"/>` +
      `<rect x="0.9" y="8.4" width="4.0" height="6.4" rx="2.0"/>` +
      `<rect x="11.1" y="8.4" width="4.0" height="6.4" rx="2.0"/>`,
  },
};

/**
 * Render one voice-state tray glyph at its native pixel size.
 *
 * Rasterised straight at `size` (high `density` so the SVG renderer antialiases
 * at the target resolution) rather than supersampled-then-downscaled: a 2px
 * stroke drawn at 256 and shrunk to 16 loses its colour to averaging, while the
 * renderer's own hinting at 16 keeps it solid.
 *
 * @param {"micOff"|"deafened"} kind
 * @param {number} size
 */
async function renderTrayGlyph(kind, size) {
  const geo = size <= 16 ? TRAY_GLYPHS.small : TRAY_GLYPHS.large;
  const { grid, slash, cut, inset } = geo;
  const a = inset;
  const b = grid - inset;
  const line = (stroke, width) =>
    `<line x1="${a}" y1="${a}" x2="${b}" y2="${b}" stroke="${stroke}" ` +
    `stroke-width="${width}" stroke-linecap="round"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${grid} ${grid}">` +
    `<defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${GLYPH_TOP}"/><stop offset="1" stop-color="${GLYPH_BOTTOM}"/>` +
    `</linearGradient>` +
    `<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="${grid}" height="${grid}">` +
    `<rect width="${grid}" height="${grid}" fill="#fff"/>${line("#000", cut)}` +
    `</mask>` +
    `</defs>` +
    `<g mask="url(#cut)" fill="url(#g)">${geo[kind]}</g>` +
    line(GLYPH_SLASH, slash) +
    `</svg>`;
  return sharp(Buffer.from(svg), { density: 512 })
    .resize(size, size)
    .png(PNG_OPTS)
    .toBuffer();
}

/** A red unread dot (core + light ring) as an SVG buffer, sized `d`. */
function unreadBadgeSvg(d) {
  const r = d / 2;
  const ring = Math.max(1, Math.round(d * 0.1));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}">` +
      `<circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="${UNREAD_RING}"/>` +
      `<circle cx="${r}" cy="${r}" r="${r - ring}" fill="${UNREAD_DOT}"/>` +
      `</svg>`,
  );
}

/** Composite the unread dot onto a tray tile's top-right corner. */
async function withUnreadDot(tileBuf, size) {
  const d = Math.round(size * 0.46);
  const badge = await sharp(unreadBadgeSvg(256)) // supersample the dot, then place
    .resize(d, d, { kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTS)
    .toBuffer();
  return sharp(tileBuf)
    .composite([{ input: badge, left: size - d, top: 0 }])
    .png(PNG_OPTS)
    .toBuffer();
}

/** Standalone unread badge (transparent) for the Windows taskbar overlay icon. */
async function taskbarBadge(size) {
  return sharp(unreadBadgeSvg(256))
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTS)
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Generated main-process module (tray + window icon, embedded base64)
// ---------------------------------------------------------------------------
async function writeTrayModule({ trayBases, taskbarBadge32, window256 }) {
  const b64 = (buf) => buf.toString("base64");
  /**
   * One `{ normal, unread }` pair per base, each carrying both tray pixel sizes.
   * Emitting the pair (rather than six flat variants) is what makes "the unread
   * dot combines with EVERY base" a structural property of the asset table
   * instead of six hand-kept constants that can drift apart.
   */
  const entry = (base) =>
    ["normal", "unread"]
      .map(
        (state) =>
          `    ${state}: {\n` +
          `      png16:\n        "${b64(trayBases[base][state][16])}",\n` +
          `      png32:\n        "${b64(trayBases[base][state][32])}",\n` +
          `    },`,
      )
      .join("\n");

  const body = `/**
 * AUTO-GENERATED by scripts/gen-icons.mjs from assets/brand/logo.png +
 * assets/brand/demli-character.png.
 * DO NOT EDIT BY HAND — run \\\`pnpm gen:icons\\\` to regenerate after changing the art.
 *
 * The tray + window icons are embedded as base64 so they ship inside the app
 * bundle (out/) without depending on a build/ art asset — electron-builder only
 * packs out/ + package.json, so a file under build/ would not exist at runtime.
 *
 *   TRAY_ICONS                    — the tray art table, keyed by {@link TrayIconBase}
 *                                   (what the user's VOICE state looks like) and then
 *                                   by whether there are unread notifications. Each
 *                                   leaf carries BOTH pixel sizes: Windows picks the
 *                                   16px bitmap at 100% DPI and the 32px above it, and
 *                                   the small one is drawn on its own optical grid
 *                                   rather than downscaled (see scripts/gen-icons.mjs).
 *   TASKBAR_UNREAD_BADGE_PNG_BASE64 — standalone red dot for the taskbar overlay
 *                                   icon (BrowserWindow.setOverlayIcon on Windows).
 *   WINDOW_ICON_PNG_BASE64        — 256x256 brand tile for the BrowserWindow icon
 *                                   (dev + Alt-Tab parity; packaged builds also get
 *                                   the icon baked into the exe via build/icon.ico).
 *
 * The \\\`Record<TrayIconBase, ...>\\\` annotation is load-bearing: adding a voice state
 * to the union without regenerating this file is then a TYPE ERROR, not a tray that
 * silently keeps showing the wrong icon.
 */
import type { TrayIconBase } from "./tray-icon-variant";

/** One tray image, at both sizes Windows asks for. Base64-encoded PNG payloads. */
export interface TrayIconAsset {
  /** 16x16 — Windows tray at 100% DPI. */
  readonly png16: string;
  /** 32x32 — 150-200% DPI. */
  readonly png32: string;
}

/** The normal/unread pair for one voice-state base. */
export interface TrayIconPair {
  readonly normal: TrayIconAsset;
  readonly unread: TrayIconAsset;
}

export const TRAY_ICONS: Record<TrayIconBase, TrayIconPair> = {
  default: {
${entry("default")}
  },
  micOff: {
${entry("micOff")}
  },
  deafened: {
${entry("deafened")}
  },
};

export const TASKBAR_UNREAD_BADGE_PNG_BASE64 =
  "${b64(taskbarBadge32)}";

export const WINDOW_ICON_PNG_BASE64 =
  "${b64(window256)}";
`;
  await writeFile(join(ROOT, "apps/desktop/src/main/tray-icon.ts"), body);
  const total = Object.values(trayBases).reduce(
    (sum, pair) =>
      sum +
      Object.values(pair).reduce(
        (inner, sizes) => inner + sizes[16].length + sizes[32].length,
        0,
      ),
    0,
  );
  console.log(
    `  apps/desktop/src/main/tray-icon.ts  (6 tray variants x2 sizes = ${total}b, ` +
      `taskbarBadge=${taskbarBadge32.length}b, window=${window256.length}b embedded)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Demli icon generation (single source: assets/brand/logo.png)\n");

  /** @type {any} */
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const skipWeb = process.argv.includes("--skip-web");

  try {
    await access(LOGO);
  } catch {
    throw new Error(
      "assets/brand/logo.png is missing. It is the ONE brand source — restore it from git " +
        "(or from assets/brand/logo-original.png) rather than letting this script invent a mark.",
    );
  }

  // --- Normalise the master ------------------------------------------------
  // Rule 1: padding dies here, before a single derivative exists.
  const raw = await readFile(LOGO);
  const rawBox = await inkBox(raw);
  const { buffer: master, side } = await normaliseToInk(raw);
  const masterBox = await inkBox(master);
  console.log(
    `Source: assets/brand/logo.png (${rawBox.canvasWidth}x${rawBox.canvasHeight}, ` +
      `ink=${(rawBox.coverage * 100).toFixed(1)}%)`,
  );
  console.log(
    `Master: normalised to ${side}x${side} (ink=${(masterBox.coverage * 100).toFixed(1)}%, ` +
      `stripped ${(((1 - rawBox.coverage) / 2) * 100).toFixed(1)}% padding per edge)\n`,
  );
  if (masterBox.coverage < 0.999) {
    throw new Error(
      `master normalisation failed: ink coverage is ${(masterBox.coverage * 100).toFixed(2)}%`,
    );
  }

  /** @type {Target[]} */
  const targets = manifest.targets;
  /** @param {string} p */
  const byPath = (p) => {
    const t = targets.find((x) => x.path === p);
    if (!t) throw new Error(`brand-manifest: no target declared for ${p}`);
    return t;
  };
  /** @param {string} p */
  const icoByPath = (p) => {
    const i = manifest.icons.find((/** @type {any} */ x) => x.path === p);
    if (!i) throw new Error(`brand-manifest: no .ico declared for ${p}`);
    return i;
  };

  /**
   * Render a master-derived target straight from its manifest entry.
   *
   * Opaque targets (`alpha: "drop"`) need something behind the artwork's
   * rounded corners, and which backing is right depends on how much of it shows:
   *   full bleed (safeArea 1) — only a corner sliver shows, so extend the
   *     artwork's own colours outward and the join is invisible.
   *   inset (maskable, safeArea < 1) — most of the canvas shows, so a blown-up
   *     blur of the mark would sit behind it as a ghost. Use the flat brand
   *     gradient plate, the same backdrop the Android adaptive icon uses.
   *
   * @param {string} path
   */
  const renderTarget = async (path) => {
    const t = byPath(path);
    const alpha = t.alpha ?? "keep";
    const safeArea = safeAreaFor(manifest, t);
    let background = null;
    if (alpha === "drop") {
      background =
        safeArea >= 1 ? await edgeExtendPlate(master, t.size) : await renderPlate(t.size);
    }
    return renderMark(master, {
      size: t.size,
      safeArea,
      fit: t.fit ?? "contain",
      background,
      alpha,
    });
  };

  // --- Mobile --------------------------------------------------------------
  console.log("Mobile:");
  await writePng("apps/mobile/assets/icon.png", await renderTarget("apps/mobile/assets/icon.png"));
  await writePng(
    "apps/mobile/assets/adaptive-icon.png",
    await renderTarget("apps/mobile/assets/adaptive-icon.png"),
  );
  await writePng(
    "apps/mobile/assets/adaptive-icon-background.png",
    await sharp(await renderPlate(byPath("apps/mobile/assets/adaptive-icon-background.png").size))
      .flatten({ background: BRAND })
      .removeAlpha()
      .png(PNG_OPTS)
      .toBuffer(),
  );
  await writePng(
    "apps/mobile/assets/splash-icon.png",
    await renderTarget("apps/mobile/assets/splash-icon.png"),
  );
  // In-app brand mark (BrandMark component) — the RN equivalent of the desktop
  // renderer's demli-logo.svg wrapper: transparent, full-ink, bundled via
  // require() so it rides OTA updates like any JS asset.
  await writePng(
    "apps/mobile/assets/brand-mark.png",
    await renderTarget("apps/mobile/assets/brand-mark.png"),
  );

  const notificationTarget = byPath("apps/mobile/assets/notification-icon.png");
  let notificationSource = master;
  try {
    notificationSource = await readFile(NOTIFICATION_MARK);
  } catch {
    console.warn(
      "  ! assets/brand/notification-mark.png missing — falling back to the colour tile's alpha.",
    );
  }
  await writePng(
    "apps/mobile/assets/notification-icon.png",
    await monoSilhouette(notificationSource, {
      size: notificationTarget.size,
      safeArea: safeAreaFor(manifest, notificationTarget),
    }),
  );

  // Native Android launcher art — only when a prebuilt android/ tree is checked
  // in. EAS regenerates it from app.json + assets/ at build time otherwise.
  const nativeRes = "apps/mobile/android/app/src/main/res";
  try {
    await access(join(ROOT, nativeRes));
    console.log("\nNative Android:");
    const iconSource = await readFile(join(ROOT, "apps/mobile/assets/icon.png"));
    const foregroundSource = await readFile(join(ROOT, "apps/mobile/assets/adaptive-icon.png"));
    const backgroundSource = await readFile(
      join(ROOT, "apps/mobile/assets/adaptive-icon-background.png"),
    );
    const densities = {
      mdpi: { legacy: 48, adaptive: 108 },
      hdpi: { legacy: 72, adaptive: 162 },
      xhdpi: { legacy: 96, adaptive: 216 },
      xxhdpi: { legacy: 144, adaptive: 324 },
      xxxhdpi: { legacy: 192, adaptive: 432 },
    };
    for (const [density, sizes] of Object.entries(densities)) {
      const dir = `${nativeRes}/mipmap-${density}`;
      await writeWebp(`${dir}/ic_launcher.webp`, iconSource, sizes.legacy);
      await writeWebp(`${dir}/ic_launcher_round.webp`, iconSource, sizes.legacy);
      await writeWebp(`${dir}/ic_launcher_foreground.webp`, foregroundSource, sizes.adaptive);
      await writeWebp(`${dir}/ic_launcher_background.webp`, backgroundSource, sizes.adaptive);
    }
  } catch {
    console.log("\nNative Android: skipped (no checked-in android/ directory)");
  }

  // --- Desktop -------------------------------------------------------------
  console.log("\nDesktop:");
  await writePng("apps/desktop/build/icon.png", await renderTarget("apps/desktop/build/icon.png"));

  // One high-res tile feeds every .ico on every surface, so the Windows exe, the
  // web tab and the landing tab cannot drift apart.
  const icoTile = await renderMark(master, {
    size: 1024,
    safeArea: manifest.safeArea.appIcon.value,
    fit: "contain",
    alpha: "keep",
  });
  const desktopIco = icoByPath("apps/desktop/build/icon.ico");
  await writeIco(desktopIco.path, icoTile, desktopIco.sizes);

  // Tray art. THREE bases, because the tray icon is the founder's at-a-glance
  // readout of his own voice state (CLAUDE.md §6 — voice comes first):
  //   default  — BOX-LESS Demli tea-glass (plate dropped, painted on-brand) so it
  //              reads at 16-32px instead of the illegible plated square.
  //   micOff   — microphone with an "off" slash.
  //   deafened — headphones with an "off" slash.
  // Each base then gets an unread twin with the red dot composited in, so the
  // notification signal is an overlay on the voice state rather than a fourth
  // base competing with it (see apps/desktop/src/main/tray-icon-variant.ts).
  const traySafeArea = manifest.safeArea.tray.value;
  const trayMark = await trayMarkBuffer(master);
  const trayBase = async (base, size) =>
    base === "default"
      ? fitSquare(trayMark, size, traySafeArea)
      : renderTrayGlyph(base, size);

  /** @type {Record<string, Record<string, Record<number, Buffer>>>} */
  const trayBases = {};
  for (const base of ["default", "micOff", "deafened"]) {
    const normal16 = await trayBase(base, 16);
    const normal32 = await trayBase(base, 32);
    trayBases[base] = {
      normal: { 16: normal16, 32: normal32 },
      unread: {
        16: await withUnreadDot(normal16, 16),
        32: await withUnreadDot(normal32, 32),
      },
    };
  }
  const taskbarBadge32 = await taskbarBadge(32);

  // build/ copies: not loaded at runtime (the base64 module above is), but they
  // are how a human eyeballs the tray art without launching the app, and the
  // brand checker asserts their size + transparency.
  const trayFiles = {
    default: { normal: "tray-icon", unread: "tray-icon-unread" },
    micOff: { normal: "tray-icon-mic-off", unread: "tray-icon-mic-off-unread" },
    deafened: { normal: "tray-icon-deafened", unread: "tray-icon-deafened-unread" },
  };
  for (const [base, states] of Object.entries(trayFiles)) {
    for (const [state, name] of Object.entries(states)) {
      await writePng(`apps/desktop/build/${name}.png`, trayBases[base][state][32]);
      await writePng(`apps/desktop/build/${name}-16.png`, trayBases[base][state][16]);
    }
  }
  await writePng("apps/desktop/build/taskbar-unread-badge.png", taskbarBadge32);

  const window256 = await sharp(icoTile)
    .resize(256, 256, { kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTS)
    .toBuffer();
  await writeTrayModule({ trayBases, taskbarBadge32, window256 });

  // Renderer asset: stays .svg so no component import changes (see writeSvgWrapper).
  for (const w of manifest.wrappers.filter((/** @type {any} */ x) =>
    x.path.startsWith("apps/desktop/"),
  )) {
    await writeSvgWrapper(master, w);
  }

  // --- Web (PWA + favicons) ------------------------------------------------
  if (skipWeb) {
    console.log("\nWeb + landing: skipped (--skip-web)");
  } else {
    console.log("\nWeb:");
    for (const t of targets.filter((x) => x.path.startsWith("apps/web/public/"))) {
      await writePng(t.path, await renderTarget(t.path));
    }
    const webIco = icoByPath("apps/web/public/favicon.ico");
    await writeIco(webIco.path, icoTile, webIco.sizes);
    for (const w of manifest.wrappers.filter((/** @type {any} */ x) =>
      x.path.startsWith("apps/web/"),
    )) {
      await writeSvgWrapper(master, w);
    }

    // --- Landing -----------------------------------------------------------
    console.log("\nLanding:");
    for (const t of targets.filter((x) => x.path.startsWith("apps/landing/"))) {
      await writePng(t.path, await renderTarget(t.path));
    }
    const landingIco = icoByPath("apps/landing/public/favicon.ico");
    await writeIco(landingIco.path, icoTile, landingIco.sizes);
  }

  console.log("\nDone. SPLASH_BG for expo-splash-screen backgroundColor: " + SPLASH_BG);
  console.log("Verify the committed assets with: pnpm test:brand");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
