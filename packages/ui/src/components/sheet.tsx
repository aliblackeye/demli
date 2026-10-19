import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { DialogOverlay, DialogPortal } from "./dialog";

/**
 * Edge-anchored panel (member roster on a narrow window, settings drawer,
 * mobile-web action sheet). Built on the same Radix Dialog as {@link Dialog},
 * so it keeps the focus trap, Esc, scroll lock and `role="dialog"` wiring —
 * give it a SheetTitle (visible or `sr-only`).
 *
 * Arrives on the authored position spring, leaves on the fast step; the
 * global reduced-motion guard collapses both.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  ["fixed z-50 flex flex-col bg-app focus:outline-none", "pb-[env(safe-area-inset-bottom,0px)]"].join(" "),
  {
    variants: {
      side: {
        right: [
          "inset-y-0 right-0 h-full w-[min(24rem,calc(100vw-3rem))] rounded-l-card",
          "data-[state=open]:animate-sheet-right-in data-[state=closed]:animate-sheet-right-out",
        ].join(" "),
        left: [
          "inset-y-0 left-0 h-full w-[min(24rem,calc(100vw-3rem))] rounded-r-card",
          "data-[state=open]:animate-sheet-left-in data-[state=closed]:animate-sheet-left-out",
        ].join(" "),
        bottom: [
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card",
          "data-[state=open]:animate-sheet-bottom-in data-[state=closed]:animate-sheet-bottom-out",
        ].join(" "),
      },
    },
    defaultVariants: { side: "right" },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** Accessible name of the close button — pass the translated "Kapat". */
  closeLabel: string;
}

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side, className, children, closeLabel, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      {side === "bottom" && (
        <span aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-raised" />
      )}
      {children}
      <DialogPrimitive.Close
        aria-label={closeLabel}
        className={cn(
          "absolute right-4 top-4 z-10 flex min-h-9 min-w-9 cursor-pointer items-center justify-center rounded-md",
          "text-fg-faint transition-colors motion-hover hover:bg-surface hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <X aria-hidden className="size-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
SheetContent.displayName = "SheetContent";

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("flex shrink-0 flex-col gap-1 px-6 pb-3 pr-14 pt-6", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6", className)} {...props} />
  );
}

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-display text-lg font-medium leading-tight text-fg-display", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-fg-muted", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";
