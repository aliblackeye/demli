import { useEffect, type ReactNode } from "react";
import { cn } from "@demli/ui";

interface MobileDrawerProps {
  /** Which edge the panel slides in from. */
  side: "left" | "right";
  open: boolean;
  onClose: () => void;
  /** Accessible name for the panel dialog. */
  label: string;
  children: ReactNode;
}

/**
 * A lightweight slide-in drawer for the mobile shell (single-column layout).
 * Renders a tap-to-dismiss scrim plus a panel that translates in from `side`.
 *
 * Deliberately NOT a Radix Dialog: the drawer hosts the app's own interactive
 * chrome (the group rail, channel list, voice panel, member roster — each with
 * their own popovers, tooltips and context menus), and a modal focus-trap would
 * fight those nested layers. Instead it stays a plain overlay with Escape /
 * scrim / selection-driven close (the mobile shell closes it when the active
 * conversation changes). The panel is always mounted so the open/close slide
 * animates both ways; when closed it is translated off-screen and made
 * inert with `pointer-events-none`.
 */
export function MobileDrawer({ side, open, onClose, label, children }: MobileDrawerProps): JSX.Element {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity motion-standard",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        role="dialog"
        aria-modal={open}
        aria-label={label}
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 z-50 flex transition-transform motion-standard",
          side === "left" ? "left-0" : "right-0",
          open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full",
          !open && "pointer-events-none",
        )}
      >
        {children}
      </div>
    </>
  );
}
