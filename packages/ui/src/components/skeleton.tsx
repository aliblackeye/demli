import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type SkeletonShape = "line" | "circle" | "rect";

/** Corner treatment per shape — a text-line pill, a full circle, a soft block. */
const SHAPE_RADIUS: Record<SkeletonShape, string> = {
  line: "rounded",
  circle: "rounded-full",
  rect: "rounded-md",
};

export interface SkeletonProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Placeholder geometry: text line, avatar circle, or content block. Default "rect". */
  shape?: SkeletonShape;
  /** Explicit width; a bare number is treated as px, else any CSS length. */
  width?: number | string;
  /** Explicit height; a bare number is treated as px, else any CSS length. */
  height?: number | string;
  /** Pulse animation. Default true; the global prefers-reduced-motion guard already
   *  neutralizes it for users who ask for less motion (see globals.css §reduced-motion). */
  animated?: boolean;
}

const toDim = (value: number | string | undefined): string | undefined =>
  typeof value === "number" ? `${value}px` : value;

/**
 * The one skeleton primitive (founder standing rule: "skeletons instead of
 * spinner loaders"). A single muted, pulsing block used to reserve the SHAPE of
 * content while it loads — never for button/action progress (those keep a
 * spinner). Compose several to mirror a real layout (avatar circle + name line +
 * body lines) rather than showing a spinner.
 *
 * Decorative by default (`aria-hidden`); wrap a skeleton group in an element with
 * `role="status"` + an aria-label so screen readers announce "loading" once,
 * not per shape. Uses the shared `bg-raised` token + Tailwind's `animate-pulse`
 * so it renders identically on desktop and web (Safari 12 safe — opacity only).
 */
export function Skeleton({
  shape = "rect",
  width,
  height,
  animated = true,
  className,
  style,
  ...rest
}: SkeletonProps): JSX.Element {
  // A circle collapses to a square: whichever dimension the caller sets drives both.
  const resolvedWidth = width ?? (shape === "circle" ? height : undefined);
  const resolvedHeight = height ?? (shape === "circle" ? width : undefined);

  const dimensionStyle: CSSProperties = {
    width: toDim(resolvedWidth),
    height: toDim(resolvedHeight),
    ...style,
  };

  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0 bg-raised",
        animated && "animate-pulse",
        SHAPE_RADIUS[shape],
        // Sensible text-line defaults when the caller gives no dimensions.
        shape === "line" && resolvedHeight === undefined && "h-3.5",
        shape === "line" && resolvedWidth === undefined && "w-full",
        className,
      )}
      style={dimensionStyle}
      {...rest}
    />
  );
}
