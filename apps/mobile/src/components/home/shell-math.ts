/**
 * Pure geometry and state rules behind the mobile shell's moving parts — the
 * bottom tab bar's sliding indicator and the server rail's edge pill. Kept free
 * of React Native so node unit tests pin the numbers the animations land on.
 *
 * Functions a Reanimated worklet calls carry the `"worklet"` directive (inert to
 * node and vitest, so the same code is what the tests exercise).
 */

/** Inner padding of the floating tab pill, px. */
export const TAB_PILL_PAD = 4;
/** Height of the floating tab pill, px — sits inside TAB_BAR_CONTENT_HEIGHT. */
export const TAB_PILL_HEIGHT = 52;

/**
 * Width of one tab slot inside a pill `width` px wide holding `count` tabs.
 * Zero until the pill has been measured (the indicator stays unmounted then).
 */
export function tabSlotWidth(width: number, count: number): number {
  "worklet";
  if (width <= 0 || count <= 0) return 0;
  return Math.max(0, (width - TAB_PILL_PAD * 2) / count);
}

/** Where the indicator sits (translateX from the pill's inner left edge) for tab `index`. */
export function tabIndicatorX(index: number, width: number, count: number): number {
  "worklet";
  const slot = tabSlotWidth(width, count);
  if (slot === 0) return 0;
  const clamped = Math.min(Math.max(0, index), count - 1);
  return clamped * slot;
}

/**
 * The rail's edge pill — one language for the whole rail, mirroring the desktop
 * GroupRail `RailPill`:
 *   selected  tall coral pill (36px)
 *   unread    short white pill (8px) — the same white as a row's unread pip
 *   idle      no pill (0)
 * A selected server never shows the unread step (you are already looking at it).
 */
export const RAIL_PILL = { selected: 36, unread: 8, idle: 0 } as const;

export type RailPillKind = keyof typeof RAIL_PILL;

export function railPillKind(selected: boolean, unread: boolean): RailPillKind {
  if (selected) return "selected";
  if (unread) return "unread";
  return "idle";
}
