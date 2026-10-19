import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

/**
 * The raw Radix namespace, re-exported so product surfaces can compose the
 * `forceMount` + `asChild` pattern needed to drive enter/exit with Framer's
 * <AnimatePresence> while KEEPING Radix's focus trap, Esc handling, and
 * scroll-lock (e.g. the full-screen SettingsShell). Prefer the styled wrappers
 * above for ordinary dialogs.
 */
export { DialogPrimitive };

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 surface-scrim",
      // Radix awaits the data-[state=closed] animation before unmount → real
      // fade-in AND fade-out for the scrim (single source: globals.css keyframes).
      "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

/**
 * Standard dialog card with overlay and close button.
 *
 * WIDE viewport — a centered card. Height is capped at 85vh and the card is a
 * flex column so a {@link DialogBody} region scrolls while the header stays put
 * and the close button never scrolls out of reach; long content (device lists,
 * source grids) never spills outside the viewport.
 *
 * NARROW viewport (a phone on the web build) — the same card becomes a
 * bottom-anchored sheet whose SHAPE follows its own content height: a confirm
 * box stays a small sheet, a settings/invite dialog grows until it fills the
 * screen and reads as a page. That is the founder's "small stays small, big
 * becomes the screen" rule, and it deliberately needs no per-call-site prop:
 * the branch is on measured content height, which no call site knows and only
 * the layout engine can decide.
 *
 * `dialog-sheet` / `dialog-sheet-close` carry NO styles above 900px — the whole
 * narrow behaviour is one media query in
 * apps/desktop/src/renderer/src/styles/globals.css (the single stylesheet,
 * imported by apps/web too). Read that block before touching the classes here:
 * it relies on being unlayered so it can override both these base utilities and
 * whatever width a call site passes.
 */
export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Accessible name of the corner close button — pass the translated "Kapat". */
  closeLabel?: string;
  /**
   * Extra classes for the scrim. Exists for LAYERING: a dialog opened from
   * inside a full-screen surface that sits above z-50 (the settings layer)
   * must lift its scrim together with its card — lifting only the card
   * (`className`) leaves the scrim underneath that surface.
   */
  overlayClassName?: string;
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, closeLabel = "Close", overlayClassName, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col",
        // Koyu Masa card: base tone on the blurred scrim, radius 24, no border
        // and no outer shadow — the scrim alone separates it from the app.
        "overflow-hidden rounded-card bg-app",
        "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
        "focus:outline-none",
        // Consumer className stays BEFORE the responsive hook so a call-site
        // width (max-w-sm … max-w-2xl) keeps winning on wide screens, while the
        // narrow media query still overrides it on a phone.
        className,
        "dialog-sheet",
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label={closeLabel}
        className={cn(
          "absolute right-4 top-4 z-10 cursor-pointer rounded-md p-1.5 text-fg-faint transition-colors motion-hover",
          "hover:bg-wash hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          // Grows to a 44px thumb target and clears the landscape notch on a
          // phone; inert above 900px.
          "dialog-sheet-close",
        )}
      >
        <X className="size-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

/**
 * Unstyled portal content — for full-screen surfaces (e.g. a settings shell)
 * that still want Radix focus trapping, Esc handling, and aria wiring.
 */
export const DialogBareContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogPrimitive.Content ref={ref} className={cn("focus:outline-none", className)} {...props}>
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogBareContent.displayName = "DialogBareContent";

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-1.5 px-6 pb-4 pr-12 pt-6", className)}
      {...props}
    />
  );
}

/**
 * Scrolling body region of a dialog. Grows to fill the capped-height card and
 * scrolls its own overflow, so tall content never pushes the dialog past the
 * viewport. Place between {@link DialogHeader} and an optional
 * {@link DialogFooter}.
 *
 * `overscroll-contain` is not cosmetic: without it, flicking past the end of
 * this list on a phone chains the scroll into whatever is behind the sheet.
 * `dialog-scroll` marks it as the sheet's scroll surface for the narrow-viewport
 * rules in globals.css (iOS momentum scrolling).
 */
export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "dialog-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6",
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "flex shrink-0 justify-end gap-2 px-6 pb-6 pt-2",
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-display text-xl font-medium leading-tight text-fg-display", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm leading-relaxed text-fg-muted", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
