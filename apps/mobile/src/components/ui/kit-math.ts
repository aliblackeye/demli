/**
 * Pure math behind the primitive kit — the parts worth unit-testing without a
 * device: tone derivation, counter formatting, slider stepping and the bottom
 * sheet's snap physics.
 *
 * Every function that a gesture calls is a WORKLET (`"worklet"` directive): it
 * runs on the UI thread inside Reanimated / gesture-handler callbacks, where a
 * plain JS function would crash. To node (and vitest) the directive is an
 * inert string, so the same code is tested as-is.
 */

// ── Colour ──────────────────────────────────────────────────────────────────

/**
 * `#rrggbb` token + alpha → `rgba(...)`. The RN half of Tailwind's
 * `bg-danger/20`: derived washes stay tied to the token they come from instead
 * of becoming new hand-typed colours. Non-hex input is returned unchanged.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = Number.parseInt(m[1] as string, 16);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

// ── Counters ────────────────────────────────────────────────────────────────

/**
 * Counter text: nothing for 0 or less, the number up to `max`, then "{max}+".
 * Same rule as the desktop `CountBadge` so "99+" means the same on both.
 */
export function formatCount(count: number, max = 99): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.floor(count);
  return n > max ? `${max}+` : String(n);
}

// ── Slider ──────────────────────────────────────────────────────────────────

/** Snap `value` to the step grid anchored at `min`, then clamp into range. */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  "worklet";
  if (max <= min) return min;
  const stepped = step > 0 ? min + Math.round((value - min) / step) * step : value;
  // Round off float drift (0.1 + 0.2) so a 0.1-step slider reports 0.3, not 0.30000000000000004.
  const clean = Math.round(stepped * 1e6) / 1e6;
  return Math.min(max, Math.max(min, clean));
}

/** Where `value` sits on the track, 0…1. */
export function fractionOf(value: number, min: number, max: number): number {
  "worklet";
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** A touch at `x` px along a `width` px track → a stepped value. */
export function valueAt(
  x: number,
  width: number,
  min: number,
  max: number,
  step: number,
): number {
  "worklet";
  if (width <= 0) return min;
  const f = Math.min(1, Math.max(0, x / width));
  return snapToStep(min + f * (max - min), min, max, step);
}

// ── Bottom sheet ────────────────────────────────────────────────────────────

/** A snap point: px of sheet height, or a share of the available height ("50%"). */
export type SnapPoint = number | `${number}%`;

/**
 * Resolve snap points into sheet HEIGHTS (px), ascending and de-duplicated.
 * `content` is the measured natural height, used when no points are given — a
 * menu sheet is exactly as tall as its rows, capped at `available`.
 */
export function resolveSnapHeights(
  points: readonly SnapPoint[] | undefined,
  available: number,
  content: number,
): number[] {
  if (!points || points.length === 0) return [Math.max(0, Math.min(content, available))];
  const heights = points.map((p) => {
    const px = typeof p === "number" ? p : (Number.parseFloat(p) / 100) * available;
    return Math.max(0, Math.min(Math.round(px), available));
  });
  return [...new Set(heights)].sort((a, b) => a - b);
}

/**
 * A released drag projects forward by its velocity before choosing a snap —
 * the way a thrown object keeps travelling. 0.2s of momentum makes a short
 * flick land one stop further, without letting a lazy drift skip stops.
 */
const PROJECTION_S = 0.2;
/** Downward speed (px/s) that dismisses outright, wherever the sheet is. */
export const DISMISS_VELOCITY = 1400;

/**
 * Which snap a released sheet goes to. Positions are translateY offsets of the
 * card (0 = fully open at the tallest height; larger = lower). `closed` is the
 * offset at which the card is off-screen.
 *
 * Returns the index into `offsets`, or -1 to dismiss. A non-dismissible sheet
 * never returns -1 — it springs back to its lowest stop instead.
 */
export function resolveRelease(
  position: number,
  velocity: number,
  offsets: readonly number[],
  closed: number,
  dismissible: boolean,
): number {
  "worklet";
  if (offsets.length === 0) return -1;
  if (dismissible && velocity > DISMISS_VELOCITY) return -1;
  const projected = position + velocity * PROJECTION_S;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < offsets.length; i += 1) {
    const d = Math.abs((offsets[i] as number) - projected);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (dismissible && Math.abs(closed - projected) < bestDist) return -1;
  return best;
}

/**
 * Resistance past the top stop: the card follows the finger at a decaying rate
 * (iOS rubber-band, c = 0.55), so pulling up says "this is as far as it goes"
 * instead of hitting a wall or tearing off the bottom edge.
 */
export function rubberBand(overshoot: number, dimension: number): number {
  "worklet";
  if (overshoot <= 0 || dimension <= 0) return 0;
  const c = 0.55;
  return (overshoot * dimension * c) / (dimension + c * overshoot);
}

export type TooltipPlacement = {
  /** Left edge of the tooltip pill, relative to the anchor's own left edge. */
  left: number;
  /** Top edge of the tooltip pill, relative to the anchor's own top edge. */
  top: number;
  side: "above" | "below";
};

/**
 * Where an anchored tooltip goes: centred over its anchor, nudged sideways so
 * it never leaves the screen (a header button at the right edge), and flipped
 * below the anchor when there is no room above it (a button in the top bar).
 * All inputs are window coordinates; the result is relative to the anchor so
 * it can be applied as `left`/`top` of an absolutely positioned child.
 */
export function placeTooltip(input: {
  anchorX: number;
  anchorY: number;
  anchorWidth: number;
  anchorHeight: number;
  tipWidth: number;
  tipHeight: number;
  screenWidth: number;
  /** The top area the tooltip must stay out of (status bar inset). */
  safeTop: number;
  margin: number;
  gap: number;
}): TooltipPlacement {
  const { anchorX, anchorY, anchorWidth, anchorHeight, tipWidth, tipHeight, screenWidth, safeTop, margin, gap } =
    input;
  const centred = anchorX + anchorWidth / 2 - tipWidth / 2;
  const maxLeft = screenWidth - margin - tipWidth;
  const absLeft = maxLeft < margin ? margin : Math.min(Math.max(centred, margin), maxLeft);
  const fitsAbove = anchorY - gap - tipHeight >= safeTop + margin;
  return {
    left: absLeft - anchorX,
    top: fitsAbove ? -gap - tipHeight : anchorHeight + gap,
    side: fitsAbove ? "above" : "below",
  };
}
