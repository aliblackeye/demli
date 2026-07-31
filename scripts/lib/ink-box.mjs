// @ts-check
/**
 * Ink-bounding-box measurement — shared by the icon GENERATOR
 * (scripts/gen-icons.mjs) and the drift CHECKER (scripts/check-brand-icons.mjs).
 *
 * Both must agree pixel-for-pixel on "where does the artwork actually end", or
 * the checker would police a rule the generator never enforced. Hence one
 * implementation, one alpha threshold, imported by both.
 *
 * Why this file exists at all: the shipped master used to carry ~11.7% of
 * transparent padding per edge, and every derived icon inherited it, so the
 * Demli mark rendered ~23% smaller than its canvas everywhere it was used.
 * Padding is now removed AT THE SOURCE (normaliseToInk) and the checker fails
 * the build if it ever creeps back into a committed asset.
 */
import sharp from "sharp";

/**
 * Alpha value at or above which a pixel counts as ink.
 *
 * 8/255 (~3%) ignores the near-invisible resampling halo a lanczos downscale
 * leaves outside the real edge, while still catching any genuine artwork.
 */
export const ALPHA_INK_MIN = 8;

/** Fully transparent RGBA, the canvas colour for every padded/extended surface. */
export const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * @typedef {object} InkBox
 * @property {number} canvasWidth
 * @property {number} canvasHeight
 * @property {boolean} hasAlpha    Whether the source declared an alpha channel.
 * @property {boolean} empty       True when no pixel reached ALPHA_INK_MIN.
 * @property {number} left         Ink bbox origin x (0 when empty).
 * @property {number} top          Ink bbox origin y (0 when empty).
 * @property {number} width        Ink bbox width (0 when empty).
 * @property {number} height       Ink bbox height (0 when empty).
 * @property {number} coverage     max(width/canvasWidth, height/canvasHeight).
 */

/**
 * Measure the opaque-ink bounding box of a raster image.
 *
 * Coverage is reported on the DOMINANT axis (the larger of the two ratios)
 * because artwork is rarely a perfect square: a 784x799 mark centred on a 799
 * square is 100% "full" — the 15px of horizontal slack is the drawing's own
 * aspect ratio, not padding. Measuring the dominant axis is what makes
 * "coverage == 1 means no padding" a true statement.
 *
 * @param {Buffer} buf PNG/JPEG/WebP buffer.
 * @returns {Promise<InkBox>}
 */
export async function inkBox(buf) {
  const image = sharp(buf);
  const meta = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[(row + x) * channels + 3] < ALPHA_INK_MIN) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return {
      canvasWidth: width,
      canvasHeight: height,
      hasAlpha: Boolean(meta.hasAlpha),
      empty: true,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      coverage: 0,
    };
  }

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  return {
    canvasWidth: width,
    canvasHeight: height,
    hasAlpha: Boolean(meta.hasAlpha),
    empty: false,
    left: minX,
    top: minY,
    width: boxWidth,
    height: boxHeight,
    coverage: Math.max(boxWidth / width, boxHeight / height),
  };
}

/**
 * Crop an image to its ink and re-centre it on the smallest square that holds
 * it, so the result has ZERO padding on its dominant axis.
 *
 * Pixel-exact: extract + extend only move pixels around, they never resample,
 * so the artwork survives untouched. Idempotent — running it on an already
 * tight master is a no-op, which is what lets the generator normalise its input
 * on every run without slowly eroding the art.
 *
 * @param {Buffer} buf
 * @returns {Promise<{ buffer: Buffer, box: InkBox, side: number }>}
 */
export async function normaliseToInk(buf) {
  const box = await inkBox(buf);
  if (box.empty) throw new Error("normaliseToInk: image has no visible pixels");

  const side = Math.max(box.width, box.height);
  const padX = side - box.width;
  const padY = side - box.height;
  const buffer = await sharp(buf)
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .extend({
      left: Math.floor(padX / 2),
      right: padX - Math.floor(padX / 2),
      top: Math.floor(padY / 2),
      bottom: padY - Math.floor(padY / 2),
      background: TRANSPARENT,
    })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();

  return { buffer, box, side };
}

/**
 * Tolerance for a coverage assertion on a `size`x`size` canvas.
 *
 * A resampled edge smears roughly one pixel of partial alpha beyond the true
 * boundary. On a 512px icon that pixel is 0.2% and the flat 3% budget is
 * plenty; on a 16px tray icon the SAME pixel is 6.3%, so a fixed 3% would fail
 * every small canvas for a purely physical reason. The floor therefore scales
 * with the canvas: 2 pixels expressed as a fraction of its width.
 *
 * @param {number} size Canvas edge in pixels.
 * @param {number} base Declared tolerance (default 3%).
 * @returns {number}
 */
export function toleranceFor(size, base = 0.03) {
  return Math.max(base, 2 / size);
}
