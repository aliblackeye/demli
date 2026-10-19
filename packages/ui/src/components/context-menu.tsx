import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import {
  menuCheckBoxClass,
  menuContentClass,
  menuDangerClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuSubOpenClass,
} from "./menu-styles";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

const contextContentClass = cn(
  menuContentClass,
  "max-h-[var(--radix-context-menu-content-available-height)]",
);

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content ref={ref} className={cn(contextContentClass, className)} {...props} />
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
    className={cn(menuItemClass, danger && menuDangerClass, className)}
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
    className={cn(menuItemClass, "group", className)}
    {...props}
  >
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {/* The box is always drawn so the row's width does not jump as it toggles;
        only the tick inside it appears. */}
    <span aria-hidden className={menuCheckBoxClass}>
      <ContextMenuPrimitive.ItemIndicator>
        <Check className="size-3" strokeWidth={3} />
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
    className={cn(menuItemClass, menuSubOpenClass, className)}
    {...props}
  >
    {children}
    <ChevronRight aria-hidden className="ml-auto size-4 opacity-70" />
  </ContextMenuPrimitive.SubTrigger>
));
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent ref={ref} className={cn(contextContentClass, className)} {...props} />
  </ContextMenuPrimitive.Portal>
));
ContextMenuSubContent.displayName = "ContextMenuSubContent";

export const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator ref={ref} className={cn(menuSeparatorClass, className)} {...props} />
));
ContextMenuSeparator.displayName = "ContextMenuSeparator";

export const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label ref={ref} className={cn(menuLabelClass, className)} {...props} />
));
ContextMenuLabel.displayName = "ContextMenuLabel";
