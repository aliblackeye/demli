import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Hint, iconButtonVariants, cn } from "@demli/ui";

/**
 * A conversation-header action (search, members, pin board, close …): the
 * Koyu Masa ghost icon button with its tooltip BELOW (headers sit at the top
 * edge), `aria-pressed` + the active tone for toggles.
 *
 * forwardRef + prop spread so it can also be the `asChild` target of a Radix
 * trigger (the group-chat options menu) — the trigger's handlers and ref land
 * on the real <button>, inside the tooltip trigger.
 */
export const HeaderAction = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    /** Longer tooltip text (e.g. with the shortcut); defaults to `label`. */
    tooltip?: string;
    pressed?: boolean;
    children: ReactNode;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children">
>(function HeaderAction({ label, tooltip, pressed, className, type, children, ...rest }, ref) {
  return (
    <Hint label={tooltip ?? label} side="bottom">
      <button
        ref={ref}
        type={type ?? "button"}
        aria-label={label}
        aria-pressed={pressed}
        {...rest}
        className={cn(iconButtonVariants({ variant: "ghost", size: "md", active: pressed ?? false }), className)}
      >
        {children}
      </button>
    </Hint>
  );
});
