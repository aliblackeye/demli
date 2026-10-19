import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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

/** A horizontal fling toward the drawer's own edge past this many px closes it. */
const SWIPE_CLOSE_PX = 64;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A lightweight slide-in drawer for the mobile shell (single-column layout).
 * Renders a tap-to-dismiss scrim plus a panel that travels in from `side`.
 *
 * Deliberately NOT a Radix Dialog: the drawer hosts the app's own interactive
 * chrome (the group rail, channel list, voice panel, member roster — each with
 * their own popovers, tooltips and context menus), and a modal focus-trap would
 * fight those nested layers. Instead it stays a plain overlay with Escape /
 * scrim / swipe / selection-driven close (the mobile shell closes it when the
 * active conversation changes).
 *
 * Motion: the panel rides the authored position spring on the way in
 * (`motion-spring`, the sampled {stiffness 500, damping 60} curve — it arrives
 * and settles, never bounces) and the fast step on the way out; the scrim is the
 * dialog scrim (veil + blur) fading with it. The panel is always mounted so both
 * directions animate; the global reduced-motion guard flattens both to instant.
 *
 * Accessibility the closed panel used to lack: when closed it is `inert`, so its
 * links and buttons are out of the Tab order and the accessibility tree (an
 * off-screen panel that still takes focus is a trap for keyboard users). On open,
 * focus moves to the first control inside; on close it returns to whatever
 * opened the drawer.
 */
export function MobileDrawer({ side, open, onClose, label, children }: MobileDrawerProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // `inert` is not in React 18's DOM typings, so it is set on the node directly.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) {
      panel.removeAttribute("inert");
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // After the first frame, so the panel is no longer pointer-events-none.
      const frame = requestAnimationFrame(() => {
        panel.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    panel.setAttribute("inert", "");
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target && panel.contains(document.activeElement)) target.focus({ preventScroll: true });
    else if (target && document.activeElement === document.body) target.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "mouse") return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // Horizontal, toward the drawer's own edge, and clearly not a vertical scroll.
    const towardEdge = side === "left" ? dx < -SWIPE_CLOSE_PX : dx > SWIPE_CLOSE_PX;
    if (towardEdge && Math.abs(dx) > Math.abs(dy) * 1.5) onClose();
  };

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 surface-scrim transition-opacity",
          open ? "opacity-100 motion-standard" : "pointer-events-none opacity-0 motion-fast",
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open}
        aria-label={label}
        aria-hidden={!open}
        data-state={open ? "open" : "closed"}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null;
        }}
        className={cn(
          "fixed inset-y-0 z-50 flex bg-rail py-2 transition-transform",
          side === "left" ? "left-0 pr-2" : "right-0 pl-2",
          open
            ? "translate-x-0 motion-spring"
            : cn("motion-fast", side === "left" ? "-translate-x-full" : "translate-x-full"),
          !open && "pointer-events-none",
        )}
        style={{
          paddingTop: "max(0.5rem, env(safe-area-inset-top))",
          paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
        }}
      >
        {children}
      </div>
    </>
  );
}
