import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Koyu Masa tooltip: strong glass (92% + blur), radius 8, 12/16 text, no border
 * and no shadow. Radix gives it `role="tooltip"` and wires `aria-describedby`
 * on the trigger, opens on keyboard focus as well as hover, and closes on Esc.
 */
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // A tooltip is always the topmost thing on screen: it only exists while
        // its trigger is hovered/focused, so whatever layer the trigger lives on
        // (settings layer z-[55], confirmations z-[58], the update banner z-[90],
        // critical overlays z-[100]) it must paint above it. Radix copies this
        // z-index onto its popper wrapper. Boot splash (z-[200]) stays above.
        "z-[150] max-w-72 overflow-hidden rounded-sm surface-glass-strong px-2.5 py-1.5",
        "text-xs font-medium leading-4 text-fg",
        // A tooltip already waits out its open delay — it uses the FAST motion
        // step, not the `standard` one panels get, so it never feels laggy.
        // Enter is unconditional (covers Radix's instant-open AND delayed-open
        // states); the data-[state=closed] exit is a more specific selector so it
        // wins on dismiss → the tooltip fades out instead of vanishing.
        "animate-pop-in-fast data-[state=closed]:animate-pop-out",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";

export interface HintProps {
  /** The tooltip text. When empty, the child renders without a tooltip. */
  label: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
  /** Optional shortcut shown after the label (e.g. a <Kbd>). */
  shortcut?: React.ReactNode;
  children: React.ReactElement;
}

/**
 * One-line tooltip around a single focusable child. Needs a TooltipProvider
 * ancestor (the app root mounts one).
 */
export function Hint({ label, side = "top", shortcut, children }: HintProps): JSX.Element {
  if (label === null || label === undefined || label === "") return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
