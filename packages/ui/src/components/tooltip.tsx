import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-72 overflow-hidden rounded-md border border-stroke-strong bg-overlay",
        // A tooltip already waits out its open delay — it uses the FAST motion
        // step, not the `standard` one panels get, so it never feels laggy.
        // Enter is unconditional (covers Radix's instant-open AND delayed-open
        // states); the data-[state=closed] exit is a more specific selector so it
        // wins on dismiss → the tooltip fades out instead of vanishing.
        "px-2.5 py-1.5 text-xs font-medium text-fg shadow-lg animate-pop-in-fast",
        "data-[state=closed]:animate-pop-out",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";
