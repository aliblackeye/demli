/**
 * The draggable divider between the screen-share stage and the right-hand camera
 * panel (a resizable side rail, video-stage requirement #2). Dragging it
 * left widens the panel, right narrows it; the panel width is clamped to
 * [minPx, maxPx] so it can never collapse below a legible camera tile or grow to
 * eat the stream.
 *
 * Pure pointer math (delta from the drag origin), so it needs no container rect:
 * `nextWidth = startWidth − dx`. Uses pointer capture so a fast drag never loses
 * the pointer, and reports the new panel width in px on every move; the parent
 * converts it to the stored resolution-independent fraction. Keyboard-resizable
 * too (←/→) for accessibility.
 */

import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@demli/ui";

const clamp = (n: number, min: number, max: number): number => (n < min ? min : n > max ? max : n);
/** Keyboard resize step (px per arrow press). */
const KEY_STEP = 24;

export interface StageResizeHandleProps {
  ariaLabel: string;
  /** Current panel width in px (the value being resized). */
  widthPx: number;
  minPx: number;
  maxPx: number;
  /** Commit a new panel width in px (already the raw value; parent clamps/stores). */
  onResize: (px: number) => void;
}

export function StageResizeHandle({
  ariaLabel,
  widthPx,
  minPx,
  maxPx,
  onResize,
}: StageResizeHandleProps): JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: widthPx };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    // Dragging LEFT (negative dx) widens the panel.
    const next = clamp(d.startWidth - (e.clientX - d.startX), minPx, maxPx);
    onResize(next);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(clamp(widthPx + KEY_STEP, minPx, maxPx));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(clamp(widthPx - KEY_STEP, minPx, maxPx));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        "group/resize relative flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      {/* Slim grip line that thickens/accents on hover or focus. */}
      <span
        className={cn(
          "h-10 w-0.5 rounded-full bg-stroke transition-colors",
          "group-hover/resize:bg-accent group-focus-visible/resize:bg-accent",
        )}
      />
    </div>
  );
}
