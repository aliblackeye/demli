import * as React from "react";
import { cn } from "../lib/cn";
import { useControllable } from "./use-controllable";

export interface SliderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue" | "dir"> {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** Fires once when a drag or key press settles (persist here, not on every move). */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Human reading of a value ("%80"); announced and shown in the value chip. */
  formatValue?: (value: number) => string;
  /** Show the value chip to the right of the track. */
  showValue?: boolean;
}

const STEP_KEYS = ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

function snap(raw: number, min: number, max: number, step: number): number {
  const stepped = Math.round((raw - min) / step) * step + min;
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Math.min(max, Math.max(min, Number(stepped.toFixed(decimals))));
}

/**
 * Volume-style slider: 4px raised track, coral fill, 14px white thumb with a
 * 2px dark ring. The thumb is `role="slider"` with value/min/max/valuetext;
 * Arrow keys step, PageUp/PageDown step ×10, Home/End jump to the ends; pointer
 * drag uses pointer capture so it keeps tracking outside the track. Name it
 * with `aria-label` or `aria-labelledby` (forwarded to the thumb).
 */
export const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  (
    {
      value,
      defaultValue,
      onValueChange,
      onValueCommit,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      formatValue,
      showValue = false,
      className,
      ...props
    },
    ref,
  ) => {
    const [current, setCurrent] = useControllable(value, defaultValue ?? min, onValueChange);
    const track = React.useRef<HTMLDivElement>(null);
    const thumb = React.useRef<HTMLDivElement | null>(null);
    const dragging = React.useRef(false);
    const latest = React.useRef(current);
    latest.current = current;
    const ratio = max === min ? 0 : (current - min) / (max - min);
    const text = formatValue ? formatValue(current) : String(current);

    const setThumb = React.useCallback(
      (node: HTMLDivElement | null) => {
        thumb.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const fromPointer = (clientX: number): number => {
      const rect = track.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return latest.current;
      const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return snap(min + r * (max - min), min, max, step);
    };

    const update = (next: number): void => {
      if (next !== latest.current) {
        latest.current = next;
        setCurrent(next);
      }
    };

    return (
      <div className={cn("flex items-center gap-3", disabled && "pointer-events-none opacity-40", className)}>
        <div
          ref={track}
          className="relative h-5 flex-1 cursor-pointer touch-none"
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            update(fromPointer(event.clientX));
            thumb.current?.focus();
          }}
          onPointerMove={(event) => {
            if (dragging.current) update(fromPointer(event.clientX));
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return;
            dragging.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
            onValueCommit?.(latest.current);
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-raised" />
          <div
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
            style={{ width: `${ratio * 100}%` }}
          />
          <div
            ref={setThumb}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={current}
            aria-valuetext={text}
            aria-disabled={disabled || undefined}
            aria-orientation="horizontal"
            onKeyDown={(event) => {
              const big = step * 10;
              const targets: Record<string, number> = {
                ArrowRight: current + step,
                ArrowUp: current + step,
                ArrowLeft: current - step,
                ArrowDown: current - step,
                PageUp: current + big,
                PageDown: current - big,
                Home: min,
                End: max,
              };
              const target = targets[event.key];
              if (target === undefined) return;
              event.preventDefault();
              update(snap(target, min, max, step));
            }}
            onKeyUp={(event) => {
              if (STEP_KEYS.includes(event.key)) onValueCommit?.(latest.current);
            }}
            className={cn(
              "absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-inverse",
              "shadow-[0_0_0_2px_var(--color-app)] transition-shadow motion-hover",
              "focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--color-app),0_0_0_4px_var(--color-accent)]",
            )}
            style={{ left: `${ratio * 100}%` }}
            {...props}
          />
        </div>
        {showValue && (
          <span
            aria-hidden
            className="min-w-12 shrink-0 rounded-pill bg-white/12 px-2 py-0.5 text-center text-xs font-medium tabular-nums text-fg"
          >
            {text}
          </span>
        )}
      </div>
    );
  },
);
Slider.displayName = "Slider";
