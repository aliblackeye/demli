import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

const menuContentClass = cn(
  "z-50 min-w-44 max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto",
  "rounded-lg border border-stroke-strong bg-overlay p-1",
  "shadow-elevated data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
);

const menuItemClass = cn(
  // rounded-sm = --radius − 4px: the derived nesting step for an item inside a
  // rounded-lg menu with p-1 (matches DropdownMenuItem).
  "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5",
  "text-[13px] font-medium text-fg-muted outline-none transition-colors motion-instant",
  "data-[highlighted]:bg-accent data-[highlighted]:text-on-accent",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
);

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(menuContentClass, className)}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export interface ContextMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> {
  danger?: boolean;
}

export const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  ContextMenuItemProps
>(({ className, danger = false, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      menuItemClass,
      danger && "text-danger data-[highlighted]:bg-danger data-[highlighted]:text-white",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = "ContextMenuItem";

/**
 * A menu row that carries its own on/off state — a personal VIEW preference the
 * menu can flip without navigating anywhere ("hide muted channels").
 *
 * The tick sits on the RIGHT rather than in a leading gutter, matching the
 * reference the founder supplied and, more usefully, leaving the leading
 * position free for the icon every other row in these menus already uses. A
 * leading indicator would have forced every sibling row to indent for a column
 * only one of them fills.
 *
 * Radix supplies the `role="menuitemcheckbox"` + `aria-checked` wiring, so the
 * state is announced rather than merely drawn.
 */
export const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(menuItemClass, "pr-2", className)}
    {...props}
  >
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {/* The box is always drawn so the row's width does not jump as it toggles;
        only the tick inside it appears. */}
    <span
      aria-hidden
      className="ml-2 grid size-4 shrink-0 place-items-center rounded-[4px] border border-stroke-strong"
    >
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="size-3" />
      </ContextMenuPrimitive.ItemIndicator>
    </span>
  </ContextMenuPrimitive.CheckboxItem>
));
ContextMenuCheckboxItem.displayName = "ContextMenuCheckboxItem";

export const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(menuItemClass, "data-[state=open]:bg-accent data-[state=open]:text-on-accent", className)}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto size-3.5 shrink-0 opacity-70" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      className={cn(menuContentClass, className)}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuSubContent.displayName = "ContextMenuSubContent";

export const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("mx-1 my-1 h-px bg-stroke-strong", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = "ContextMenuSeparator";

export const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-faint",
      className,
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = "ContextMenuLabel";
