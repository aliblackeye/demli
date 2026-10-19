import { cn } from "../lib/cn";

/**
 * Koyu Masa menu recipe, shared by DropdownMenu and ContextMenu so the two can
 * never drift: strong glass panel (92% + blur), radius 12, 4px inset; rows
 * radius 8 (the nesting rule: 12 − 4), muted label that lifts to `fg` on the
 * raised tone when highlighted (pointer OR keyboard — Radix sets
 * data-highlighted for both). No border, no outer shadow.
 */
export const menuContentClass = cn(
  "z-50 min-w-48 overflow-y-auto rounded-lg surface-glass-strong p-1",
  "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
);

export const menuItemClass = cn(
  "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-3 py-2",
  "text-sm font-medium text-fg-muted outline-none transition-colors motion-hover",
  "[&_svg]:shrink-0",
  "data-[highlighted]:bg-raised data-[highlighted]:text-fg",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
);

/** Destructive row: pink label, pink wash when highlighted (never a solid fill). */
export const menuDangerClass = "text-danger data-[highlighted]:bg-danger/12 data-[highlighted]:text-danger";

export const menuSeparatorClass = "mx-2 my-1 h-px bg-stroke";

export const menuLabelClass =
  "px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-fg-faint";

export const menuSubOpenClass = "data-[state=open]:bg-raised data-[state=open]:text-fg";

/** Right-hand tick box for checkbox items. */
export const menuCheckBoxClass =
  "ml-2 grid size-4 shrink-0 place-items-center rounded-[5px] bg-raised text-on-accent group-data-[state=checked]:bg-accent";
