/**
 * Pure geometry behind the full-screen image viewer: contain-fitting, zooming
 * about a focal point, keeping a zoomed picture on screen, and where a released
 * page swipe lands. Every function a gesture calls is a worklet (inert string
 * to node, so the same code is unit-tested as-is).
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** The double-tap zoom step. */
export const DOUBLE_TAP_ZOOM = 2.5;

/** The size an image of `w×h` draws at inside a `boxW×boxH` box with `contain`. */
export function containSize(
  w: number | null,
  h: number | null,
  boxW: number,
  boxH: number,
): { width: number; height: number } {
  "worklet";
  if (!w || !h || w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return { width: boxW, height: boxH };
  const factor = Math.min(boxW / w, boxH / h);
  return { width: w * factor, height: h * factor };
}

/**
 * The furthest a picture drawn at `fitted` and zoomed by `scale` may travel
 * from centre on one axis before an edge would come off its side of the
 * screen. 0 while the zoomed picture is still smaller than the screen.
 */
export function panLimit(fitted: number, scale: number, screen: number): number {
  "worklet";
  return Math.max(0, (fitted * scale - screen) / 2);
}

/** Clamp a translation into ±limit. */
export function clampAbs(value: number, limit: number): number {
  "worklet";
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * Translation after zooming from `s0` to `s1` about a focal point `f`
 * (relative to the screen centre), so the point under the fingers stays put.
 */
export function zoomAbout(t0: number, f: number, s0: number, s1: number): number {
  "worklet";
  if (s0 <= 0) return t0;
  return f - (f - t0) * (s1 / s0);
}

/** Pinch scale with a soft rubber band below 1 and above the max. */
export function rubberScale(raw: number): number {
  "worklet";
  if (raw < MIN_ZOOM) return MIN_ZOOM - (MIN_ZOOM - raw) * 0.4;
  if (raw > MAX_ZOOM) return MAX_ZOOM + (raw - MAX_ZOOM) * 0.2;
  return raw;
}

/**
 * Which page a released horizontal swipe settles on: one step when the drag
 * passed a third of the width or was flicked (≥ 500 px/s) — never past the
 * ends, never more than one page per swipe.
 */
export function releasePage(
  index: number,
  dragX: number,
  velocityX: number,
  width: number,
  count: number,
): number {
  "worklet";
  if (count <= 1 || width <= 0) return 0;
  let next = index;
  if (dragX < -width / 3 || velocityX < -500) next = index + 1;
  else if (dragX > width / 3 || velocityX > 500) next = index - 1;
  return Math.min(count - 1, Math.max(0, next));
}

/** A vertical drag that should close the viewer (distance or a flick). */
export function shouldDismiss(dragY: number, velocityY: number): boolean {
  "worklet";
  return Math.abs(dragY) > 120 || Math.abs(velocityY) > 900;
}
