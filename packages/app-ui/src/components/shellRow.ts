import { cn } from "@demli/ui";

/**
 * The ONE row language of the shell (Koyu Masa): every list row in the channel
 * sidebar, the home sidebar, the member rosters and the command palette paints
 * its selected / hover / pressed / unread / muted states from here, so "selected"
 * means the same thing — and looks the same — everywhere it appears.
 *
 *   rest      muted label, no fill
 *   hover     surface tone (#171717 on the #0d0d0d column) — a 200ms TONE change,
 *             never a slide, lift or scale (founder rule; landing-only effects stay
 *             on the landing)
 *   pressed   one step deeper (`raised-pressed`)
 *   selected  coral wash + light-coral label (`selected` / `accent-hover`) — the
 *             landing's channel-list recipe, and the same coral the rail's selected
 *             pill uses
 *   unread    the label lifts to `fg` (callers also bold the name and draw the
 *             white left-edge pip from {@link shellUnreadPipClass})
 *   muted     the whole row quiets to 55% unless it is selected or carries a badge
 *
 * Focus is an INSET ring: rows live in scroll containers with `overflow: hidden`
 * edges, where an outset ring is clipped on the first and last row.
 */
export interface ShellRowState {
  selected?: boolean;
  unread?: boolean;
  muted?: boolean;
}

export const shellRowFocusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70";

export function shellRowClass({ selected = false, unread = false, muted = false }: ShellRowState): string {
  return cn(
    "relative flex w-full cursor-pointer items-center rounded-md text-left",
    "transition-[color,background-color,opacity] motion-hover",
    shellRowFocusClass,
    selected
      ? "bg-selected text-accent-hover"
      : unread
        ? "text-fg hover:bg-hover active:bg-raised-pressed"
        : "text-fg-muted hover:bg-hover hover:text-fg active:bg-raised-pressed",
    muted && !selected && !unread && "opacity-55",
  );
}

/**
 * The unread pip on a row's left edge: a short white pill that peeks out of the
 * column's gutter — the same signal, at the same edge, as the rail's short
 * unread pill. `mention` swaps it to coral, the colour of every mention badge.
 */
export function shellUnreadPipClass(mention: boolean): string {
  return cn(
    "pointer-events-none absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r-full",
    "animate-pop-in-fast",
    mention ? "bg-accent" : "bg-fg",
  );
}

/**
 * Corner icon control that lives ON a row (close-DM ✕, remove member, the
 * channel row's chat / invite controls): a translucent wash so it shows on the
 * row's hover tone AND on its selected coral wash.
 */
export const shellRowIconButtonClass = cn(
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-faint",
  "transition-[opacity,color,background-color] motion-hover",
  "hover:bg-wash-strong hover:text-fg active:bg-wash",
  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
);

/**
 * A floating corner pill (age-verify reminder, web "get the app" nudge): glass,
 * fully rounded, the landing's inset pill line instead of a border or a shadow.
 */
export const floatingPillClass = cn(
  "flex items-center gap-0.5 rounded-pill surface-glass p-1",
  "shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]",
  "animate-toast-in",
);

/** A control INSIDE {@link floatingPillClass}. */
export const floatingPillItemClass = cn(
  "inline-flex cursor-pointer items-center gap-2 rounded-pill px-3 py-1.5 text-xs font-medium text-fg",
  "transition-colors motion-hover hover:bg-wash-strong active:bg-wash",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
);
