/**
 * Crop geometry for the mobile avatar / banner editor
 * (components/profile/ImageCropEditor.tsx).
 *
 * The SAME model the desktop editor uses (apps/desktop/src/renderer/src/lib/
 * image-crop.ts): one small state — the zoom and the source-pixel point under
 * the mask centre — from which everything drawn and everything exported is
 * derived. Same aspect ratios, same zoom range, same export sizes, so an avatar
 * cropped on the phone and one cropped on Windows come out identical.
 *
 * Why a mobile copy instead of an import: every function here runs on the UI
 * thread inside gesture-handler callbacks (pinch/pan at frame rate), so each
 * one is a Reanimated worklet — the `"worklet"` directive is inert to node and
 * to the unit tests, and the babel plugin compiles it for the UI thread in the
 * app. The desktop module is DOM-side code with no such constraint.
 *
 * The one invariant every function keeps: **the mask is always filled.** The
 * image can never be zoomed out below "cover" nor panned far enough that an
 * empty edge shows inside the circle / frame, so what the user sees in the mask
 * is exactly, and only, what gets exported.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `zoom` is relative to the cover scale (1 = the image just fills the mask). */
export interface CropState {
  zoom: number;
  center: Point;
}

/** A rectangle in source pixels — what the manipulator crops. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Double-tap target when zoomed out (and back to 1 when zoomed in). */
export const DOUBLE_TAP_ZOOM = 2;

/** Avatar: a circle in a square. Banner: the profile card's 8:3 (desktop 320×120). */
export const CROP_ASPECT = { avatar: 1, banner: 8 / 3 } as const;
export type CropKind = keyof typeof CROP_ASPECT;

/**
 * Export sizes — identical to the desktop. The server stores what it is given
 * (no resize), so the client decides: 512² covers the largest avatar the app
 * draws at 3×; 1200×450 covers the 8:3 card banner on a phone at >3×.
 */
export const CROP_OUTPUT: Record<CropKind, Size> = {
  avatar: { width: 512, height: 512 },
  banner: { width: 1200, height: 450 },
};

/**
 * Longest edge of the decoded image the editor works on. Big enough that the
 * largest crop the editor allows (zoom 4 on the short side) still has ≥512 real
 * pixels for an avatar, small enough that a 48 MP photo does not decode into a
 * 190 MB bitmap on a mid-range phone.
 */
export const EDIT_MAX_EDGE_PX = 2048;

/** Never export smaller than this, even from a tiny source. */
const MIN_OUTPUT_EDGE = 128;

function clampNumber(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, value));
}

/** Screen px per source px at which the image exactly covers the mask. */
export function coverScale(image: Size, mask: Size): number {
  "worklet";
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.max(mask.width / image.width, mask.height / image.height);
}

/** The initial state: centred, zoom 1 (cover). */
export function initialCropState(image: Size): CropState {
  "worklet";
  return { zoom: MIN_ZOOM, center: { x: image.width / 2, y: image.height / 2 } };
}

/**
 * Clamp a state so the mask stays filled: zoom into [MIN, MAX], and the centre
 * far enough from each edge that half the visible source span fits either side.
 */
export function clampCropState(state: CropState, image: Size, mask: Size): CropState {
  "worklet";
  const zoom = clampNumber(Number.isFinite(state.zoom) ? state.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = coverScale(image, mask) * zoom;
  const halfW = Math.min(image.width, mask.width / scale) / 2;
  const halfH = Math.min(image.height, mask.height / scale) / 2;
  const cx = Number.isFinite(state.center.x) ? state.center.x : image.width / 2;
  const cy = Number.isFinite(state.center.y) ? state.center.y : image.height / 2;
  return {
    zoom,
    center: {
      x: clampNumber(cx, halfW, image.width - halfW),
      y: clampNumber(cy, halfH, image.height - halfH),
    },
  };
}

/** Pan by a SCREEN-pixel delta. Dragging right moves the image right. */
export function panCrop(state: CropState, delta: Point, image: Size, mask: Size): CropState {
  "worklet";
  const scale = coverScale(image, mask) * state.zoom;
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
 * relative to the MASK CENTRE) fixed on screen — so a pinch zooms into what is
 * between your fingers. No anchor: zoom about the mask centre (slider, buttons).
 */
export function zoomCrop(
  state: CropState,
  nextZoom: number,
  image: Size,
  mask: Size,
  anchor: Point = { x: 0, y: 0 },
): CropState {
  "worklet";
  const zoom = clampNumber(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const cover = coverScale(image, mask);
  const before = cover * state.zoom;
  const after = cover * zoom;
  const sx = state.center.x + anchor.x / before;
  const sy = state.center.y + anchor.y / before;
  return clampCropState(
    { zoom, center: { x: sx - anchor.x / after, y: sy - anchor.y / after } },
    image,
    mask,
  );
}

/** The source rectangle the mask shows — exactly what the export reads. */
export function cropRect(state: CropState, image: Size, mask: Size): CropRect {
  "worklet";
  const clamped = clampCropState(state, image, mask);
  const scale = coverScale(image, mask) * clamped.zoom;
  const width = Math.min(image.width, mask.width / scale);
  const height = Math.min(image.height, mask.height / scale);
  return { x: clamped.center.x - width / 2, y: clamped.center.y - height / 2, width, height };
}

/**
 * How to draw the image so the state's centre lands on the mask centre.
 *
 * The image view is laid out ONCE at its cover size (`coverScale × natural`,
 * so its layout is about the mask's size and a 2048px bitmap is not laid out at
 * 2048pt), with `transformOrigin` at its top-left; `scale` is then just the zoom
 * and `x`/`y` the translate relative to the mask's top-left. Transform-only, so a
 * pinch never triggers layout.
 */
export function imageTransform(
  state: CropState,
  image: Size,
  mask: Size,
): { x: number; y: number; scale: number } {
  "worklet";
  const clamped = clampCropState(state, image, mask);
  const scale = coverScale(image, mask) * clamped.zoom;
  return {
    x: mask.width / 2 - clamped.center.x * scale,
    y: mask.height / 2 - clamped.center.y * scale,
    scale: clamped.zoom,
  };
}

/**
 * The integer, in-bounds rectangle handed to the native cropper. The manipulator
 * throws on a rect that pokes 1px outside the bitmap, and float maths routinely
 * lands at `width + 0.0000001` — so round inward and re-clamp to the image.
 */
export function pixelCropRect(rect: CropRect, image: Size): CropRect {
  const x = clampNumber(Math.round(rect.x), 0, Math.max(0, image.width - 1));
  const y = clampNumber(Math.round(rect.y), 0, Math.max(0, image.height - 1));
  const width = clampNumber(Math.round(rect.width), 1, image.width - x);
  const height = clampNumber(Math.round(rect.height), 1, image.height - y);
  return { x, y, width, height };
}

/**
 * Export size for a crop: the kind's target, but never UPSCALED past the source
 * pixels the crop covers (an upscaled 200px photo is only a blurrier 200px photo
 * with more bytes). Keeps the target aspect exactly.
 */
export function outputSize(rect: CropRect, kind: CropKind): Size {
  const target = CROP_OUTPUT[kind];
  const aspect = target.width / target.height;
  const width = Math.round(
    clampNumber(rect.width, Math.min(MIN_OUTPUT_EDGE * aspect, target.width), target.width),
  );
  return { width, height: Math.max(1, Math.round(width / aspect)) };
}

/** True when the state is the untouched initial one (Reset has nothing to do). */
export function isInitialCrop(state: CropState, image: Size, mask: Size): boolean {
  "worklet";
  const initial = clampCropState(initialCropState(image), image, mask);
  const current = clampCropState(state, image, mask);
  return (
    Math.abs(current.zoom - initial.zoom) < 1e-3 &&
    Math.abs(current.center.x - initial.center.x) < 0.5 &&
    Math.abs(current.center.y - initial.center.y) < 0.5
  );
}

/**
 * The mask's on-screen size inside a stage: the avatar circle is the largest
 * square that leaves `inset` on every side; the banner frame spans the width
 * (minus inset) at 8:3, shrinking to fit a short stage.
 */
export function maskSizeFor(kind: CropKind, stage: Size, inset: number): Size {
  const aspect = CROP_ASPECT[kind];
  const maxW = Math.max(1, stage.width - inset * 2);
  const maxH = Math.max(1, stage.height - inset * 2);
  const width = Math.min(maxW, maxH * aspect);
  return { width: Math.round(width), height: Math.round(width / aspect) };
}

/**
 * Fit a source into the editor's working size (longest edge
 * {@link EDIT_MAX_EDGE_PX}); `null` when it already fits.
 */
export function editingResize(image: Size): Size | null {
  const longest = Math.max(image.width, image.height);
  if (longest <= EDIT_MAX_EDGE_PX || longest <= 0) return null;
  const f = EDIT_MAX_EDGE_PX / longest;
  return { width: Math.round(image.width * f), height: Math.round(image.height * f) };
}
