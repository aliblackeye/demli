/**
 * Framework-free long-press controller — the touch/coarse-pointer path of
 * {@link ../components/ActionMenu.ActionMenu}. Kept pure (no React, no DOM APIs
 * beyond `setTimeout`) so the timing/cancel rules can be unit-tested in the
 * node-only vitest env, matching this package's test philosophy (see
 * `serverFolders.test.ts`).
 *
 * Why a custom controller when Radix ContextMenu already long-presses on touch:
 *  - Radix fires at a sluggish 700ms; a premium app wants ~480ms.
 *  - Radix cancels on ANY pointer move (zero threshold) — a rock-steady finger
 *    that drifts a pixel loses the press. We use a small movement threshold so
 *    only a real scroll/drag cancels, while a still finger reliably fires.
 *
 * The controller NEVER arms for a mouse (`pointerType === "mouse"`): the wide-
 * screen right-click stays the pure Radix `onContextMenu` path, untouched. When
 * the timer fires, {@link ActionMenu} opens the SAME menu by dispatching a
 * bubbling `contextmenu` at the press point — which also clears Radix's own
 * 700ms backstop (its `onContextMenu` calls `clearLongPress`), so the menu opens
 * exactly once.
 */

/** The viewport point a long-press resolved at (for anchoring the menu). */
export interface LongPressPoint {
  clientX: number;
  clientY: number;
}

/** The minimal pointer-event shape the controller reads (React/DOM both satisfy it). */
export interface LongPressPointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPressOptions {
  /** Hold duration before the press resolves. Default 480ms. */
  durationMs?: number;
  /** Movement (px) that cancels the pending press (scroll/drag). Default 10. */
  moveThreshold?: number;
  /** Fired once when a hold completes without moving past the threshold. */
  onLongPress: (point: LongPressPoint) => void;
}

export interface LongPressController {
  onPointerDown: (event: LongPressPointerLike) => void;
  onPointerMove: (event: LongPressPointerLike) => void;
  onPointerUp: (event: LongPressPointerLike) => void;
  onPointerCancel: (event: LongPressPointerLike) => void;
  /** Clear any pending press (unmount / disable). */
  cancel: () => void;
}

/** Default hold before a long-press resolves — premium-snappy, not the 700ms Radix default. */
export const DEFAULT_LONG_PRESS_MS = 480;

/** Default movement tolerance before a pending press is treated as a scroll/drag. */
export const DEFAULT_MOVE_THRESHOLD = 10;

/**
 * Create a long-press controller. Returns pointer handlers to spread onto a
 * trigger plus a `cancel` for cleanup. Only ONE press is tracked at a time; a
 * fresh `onPointerDown` restarts it.
 */
export function createLongPress({
  durationMs = DEFAULT_LONG_PRESS_MS,
  moveThreshold = DEFAULT_MOVE_THRESHOLD,
  onLongPress,
}: LongPressOptions): LongPressController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: LongPressPoint | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    start = null;
  };

  const onPointerDown = (event: LongPressPointerLike): void => {
    // Mouse keeps the pure right-click path (Radix onContextMenu). Only touch/pen arm.
    if (event.pointerType === "mouse") return;
    clear();
    const point: LongPressPoint = { clientX: event.clientX, clientY: event.clientY };
    start = point;
    timer = setTimeout(() => {
      timer = null;
      start = null;
      onLongPress(point);
    }, durationMs);
  };

  const onPointerMove = (event: LongPressPointerLike): void => {
    if (timer === null || start === null) return;
    const dx = event.clientX - start.clientX;
    const dy = event.clientY - start.clientY;
    // Cancel once the finger travels past the threshold — i.e. a scroll or drag,
    // not a hold. (Radix cancels on any move; the threshold avoids jitter loss.)
    if (dx * dx + dy * dy > moveThreshold * moveThreshold) clear();
  };

  const onPointerUp = (): void => clear();
  const onPointerCancel = (): void => clear();

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, cancel: clear };
}
