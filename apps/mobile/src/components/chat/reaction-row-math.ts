/**
 * Layout of the quick-reaction row at the top of the long-press sheet. Pure so
 * node tests can pin it at real phone widths without loading React Native.
 */

/** The cell size the row wants (a full touch target). */
export const QUICK_REACTION_CELL_MAX = 44;
/** Below this the row drops trailing emoji instead of shrinking further. */
export const QUICK_REACTION_CELL_MIN = 40;

export interface QuickReactionLayout {
  /** How many palette emoji to show (the leading ones, in palette order). */
  count: number;
  /** Width and height of every cell, the "more" button included. */
  cell: number;
}

/**
 * Fit the palette plus the optional "more" button into `rowWidth` (the width
 * inside the sheet and row padding) without ever pushing "more" off the edge.
 *
 * Every cell shares one size, capped at a 44dp touch target. When the whole
 * palette would need cells under 40dp (a 360dp phone fits nine 37dp cells), it
 * shows fewer emoji at a comfortable size instead: the rest stay one tap away
 * behind "more", which is never the one that is dropped.
 */
export function quickReactionLayout(
  rowWidth: number,
  paletteSize: number,
  hasMore: boolean,
): QuickReactionLayout {
  const extra = hasMore ? 1 : 0;
  const width = Math.max(0, rowWidth);
  const fitAll = Math.floor(width / Math.max(1, paletteSize + extra));
  if (fitAll >= QUICK_REACTION_CELL_MIN || !hasMore) {
    return { count: paletteSize, cell: Math.min(QUICK_REACTION_CELL_MAX, fitAll) };
  }
  const cells = Math.max(1 + extra, Math.floor(width / QUICK_REACTION_CELL_MIN));
  const count = Math.max(0, Math.min(paletteSize, cells - extra));
  return { count, cell: Math.min(QUICK_REACTION_CELL_MAX, Math.floor(width / (count + extra))) };
}
