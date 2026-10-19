/**
 * Crop geometry for the avatar / banner editor ({@link ../components/ImageCropDialog}).
 *
 * Pure math, no DOM: everything the editor draws and everything it exports is
 * derived from ONE small state — the zoom and the point of the source image that
 * sits under the centre of the mask. Keeping the state in SOURCE pixels (not in
 * screen pixels) is deliberate: the dialog can resize (window, phone rotation,
 * the narrow-viewport sheet) and the crop the user chose must not move when it
 * does. Screen geometry is recomputed from the measured mask every render.
 *
 * The one invariant every function here keeps: **the mask is always filled.**
 * The image can never be zoomed out below "cover" or panned far enough that an
 * empty edge shows inside the circle/rectangle — so whatever the user sees in
 * the mask is exactly, and only, what gets exported.
 */

/** Natural pixel size of the source image. */
export interface Size {
  width: number;
  height: number;
}

/** A 2D point / vector, in whatever space the caller names. */
export interface Point {
  x: number;
  y: number;
}

/**
 * The editor state. `zoom` is relative to the cover scale (1 = the image just
 * fills the mask); `center` is the source-pixel point under the mask centre.
 */
export interface CropState {
  zoom: number;
  center: Point;
}

/** A rectangle in source pixels — what `drawImage` reads from. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Avatar is a circle in a square; the banner matches the profile card (320×120). */
export const CROP_ASPECT = { avatar: 1, banner: 8 / 3 } as const;
export type CropKind = keyof typeof CROP_ASPECT;

/**
 * Export sizes. The server stores what it is given (no resize), so the client
 * decides: 512² covers the largest avatar the app draws (the 80px card avatar at
 * 3× plus the full-screen lightbox at a reasonable size); 1200×450 covers the
 * 320×120 card banner at >3× and the wider settings preview.
 */
export const CROP_OUTPUT: Record<CropKind, Size> = {
  avatar: { width: 512, height: 512 },
  banner: { width: 1200, height: 450 },
};

/** Never export smaller than this, even from a tiny source (the avatar still has to read at 80px@2×). */
const MIN_OUTPUT_EDGE = 128;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The scale (screen px per source px) at which the image exactly covers the mask. */
export function coverScale(image: Size, mask: Size): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.max(mask.width / image.width, mask.height / image.height);
}

/** Screen px per source px for a state. */
export function effectiveScale(state: CropState, image: Size, mask: Size): number {
  return coverScale(image, mask) * state.zoom;
}

/** The initial state: centred, zoom 1 (cover). */
export function initialCropState(image: Size): CropState {
  return { zoom: MIN_ZOOM, center: { x: image.width / 2, y: image.height / 2 } };
}

/**
 * Clamp a state so the mask stays filled: zoom into [MIN, MAX] and the centre
 * far enough from each edge that half the visible source span fits on either
 * side. When the visible span equals the image (zoom 1 on the constraining
 * axis) the centre is pinned to the middle of that axis.
 */
export function clampCropState(state: CropState, image: Size, mask: Size): CropState {
  const zoom = clampNumber(Number.isFinite(state.zoom) ? state.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = coverScale(image, mask) * zoom;
  const halfW = Math.min(image.width, mask.width / scale) / 2;
  const halfH = Math.min(image.height, mask.height / scale) / 2;
  return {
    zoom,
    center: {
      x: clampNumber(state.center.x, halfW, image.width - halfW),
      y: clampNumber(state.center.y, halfH, image.height - halfH),
    },
  };
}

/** Pan by a SCREEN-pixel delta (pointer drag / arrow key). Dragging right moves the image right. */
export function panCrop(state: CropState, delta: Point, image: Size, mask: Size): CropState {
  const scale = effectiveScale(state, image, mask);
  return clampCropState(
    {
      zoom: state.zoom,
      center: { x: state.center.x - delta.x / scale, y: state.center.y - delta.y / scale },
    },
    image,
    mask,
  );
}

/**
 * Zoom to `nextZoom`, keeping the source point under `anchor` (screen px,
 * relative to the MASK CENTRE) fixed on screen — the wheel / pinch behaviour
 * every image editor has, so the thing under your cursor is the thing you zoom
 * into. With no anchor it zooms about the mask centre (slider, keyboard).
 */
export function zoomCrop(
  state: CropState,
  nextZoom: number,
  image: Size,
  mask: Size,
  anchor: Point = { x: 0, y: 0 },
): CropState {
  const zoom = clampNumber(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const before = effectiveScale(state, image, mask);
  const after = coverScale(image, mask) * zoom;
  // Source point under the anchor before the zoom…
  const sx = state.center.x + anchor.x / before;
  const sy = state.center.y + anchor.y / before;
  // …must stay under the anchor after it.
  return clampCropState(
    { zoom, center: { x: sx - anchor.x / after, y: sy - anchor.y / after } },
    image,
    mask,
  );
}

/** The source rectangle the mask shows — exactly what the export reads. */
export function cropRect(state: CropState, image: Size, mask: Size): CropRect {
  const clamped = clampCropState(state, image, mask);
  const scale = effectiveScale(clamped, image, mask);
  const width = Math.min(image.width, mask.width / scale);
  const height = Math.min(image.height, mask.height / scale);
  return {
    x: clamped.center.x - width / 2,
    y: clamped.center.y - height / 2,
    width,
    height,
  };
}

/**
 * Where to draw the full image on screen so the state's centre lands on the
 * mask centre: a translate (relative to the mask's top-left) plus a uniform
 * scale, applied to an element sized to the image's natural pixels with
 * `transform-origin: 0 0`. Transform-only, so dragging never triggers layout.
 */
export function imageTransform(
  state: CropState,
  image: Size,
  mask: Size,
): { x: number; y: number; scale: number } {
  const clamped = clampCropState(state, image, mask);
  const scale = effectiveScale(clamped, image, mask);
  return {
    x: mask.width / 2 - clamped.center.x * scale,
    y: mask.height / 2 - clamped.center.y * scale,
    scale,
  };
}

/**
 * Export size for a crop: the kind's target size, but never UPSCALED past the
 * source pixels the crop actually covers (an upscaled 200px photo is just a
 * blurrier 200px photo with more bytes). Keeps the target aspect exactly.
 */
export function outputSize(rect: CropRect, kind: CropKind): Size {
  const target = CROP_OUTPUT[kind];
  const aspect = target.width / target.height;
  const width = Math.round(
    clampNumber(rect.width, Math.min(MIN_OUTPUT_EDGE * aspect, target.width), target.width),
  );
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}

/** True when the state is the untouched initial state (Reset has nothing to do). */
export function isInitialCrop(state: CropState, image: Size, mask: Size): boolean {
  const initial = clampCropState(initialCropState(image), image, mask);
  const current = clampCropState(state, image, mask);
  return (
    Math.abs(current.zoom - initial.zoom) < 1e-3 &&
    Math.abs(current.center.x - initial.center.x) < 0.5 &&
    Math.abs(current.center.y - initial.center.y) < 0.5
  );
}
