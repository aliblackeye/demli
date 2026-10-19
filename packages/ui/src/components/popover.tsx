import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../lib/cn";

/**
 * Floating panel anchored to a trigger (Radix Popover). Used for the profile
 * card that opens from member-sidebar rows and message avatars (ADR 0010 §5).
 * Unlike DropdownMenu this is not a menu — its content is arbitrary and not
 * arrow-key navigated, which suits a profile card with a few actions.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // Surface tone, not the base: a popover opens OVER the base-toned
        // conversation column, and with no border or shadow (Koyu Masa) the
        // tone step is the only thing that separates the two.
        "z-50 w-72 overflow-hidden rounded-xl bg-surface",
        "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
        "focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
