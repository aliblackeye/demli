/**
 * Horizontal drag divider under the embedded DM-call stage (task #104). Dragging
 * it DOWN grows the stage, UP shrinks it; the height is clamped to [minPx, maxPx]
 * so the stage can never collapse below a legible tile or grow to swallow the chat
 * beneath it.
 *
 * The row-resize twin of {@link StageResizeHandle} (same pointer-capture pattern,
 * kept a separate component so the column-resize one used inside the VideoStage is
 * untouched): pure pointer math from the drag origin — `nextHeight = startHeight +
 * dy` — so it needs no container rect, and it is keyboard-resizable (↑/↓) too.
 */

import {
  useRef,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cn } from "@demli/ui";

const clamp = (n: number, min: number, max: number): number => (n < min ? min : n > max ? max : n);
/** Keyboard resize step (px per arrow press). */
const KEY_STEP = 24;

export interface StageHeightHandleProps {
  ariaLabel: string;
  /** Current stage height in px (the value being resized). */
  heightPx: number;
  minPx: number;
  maxPx: number;
  /** Commit a new stage height in px (already clamped by this handle). */
  onResize: (px: number) => void;
}

export function StageHeightHandle({
  ariaLabel,
  heightPx,
  minPx,
  maxPx,
  onResize,
}: StageHeightHandleProps): JSX.Element {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: heightPx };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    // Dragging DOWN (positive dy) grows the stage.
    onResize(clamp(d.startHeight + (e.clientY - d.startY), minPx, maxPx));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onResize(clamp(heightPx - KEY_STEP, minPx, maxPx));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onResize(clamp(heightPx + KEY_STEP, minPx, maxPx));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        "group/resize relative flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center",
        "border-b border-stroke bg-app outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      {/* Slim grip line that thickens/accents on hover or focus. */}
      <span
        className={cn(
          "h-0.5 w-10 rounded-full bg-stroke transition-colors",
          "group-hover/resize:bg-accent group-focus-visible/resize:bg-accent",
        )}
      />
    </div>
  );
}
