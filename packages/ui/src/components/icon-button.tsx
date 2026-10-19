import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Hint } from "./tooltip";

export const iconButtonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded-lg",
    "transition-[color,background-color,opacity] motion-hover",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
    "disabled:pointer-events-none disabled:opacity-40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        /** Surface box that lifts to the raised tone on hover. */
        solid: "bg-surface text-fg hover:bg-raised active:bg-raised-pressed",
        /** Bare glyph until hovered. */
        ghost: "bg-transparent text-fg-muted hover:bg-surface hover:text-fg active:bg-app",
        /** Destructive glyph (leave call, remove). */
        danger: "bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/28",
      },
      size: {
        sm: "size-8 [&_svg]:size-4",
        md: "size-10 [&_svg]:size-5",
        lg: "size-12 [&_svg]:size-6",
      },
      active: {
        true: "bg-accent-surface text-accent-hover hover:bg-accent-surface hover:text-accent-hover",
        false: "",
      },
    },
    defaultVariants: { variant: "solid", size: "md", active: false },
  },
);

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">,
    VariantProps<typeof iconButtonVariants> {
  /**
   * What the button does, in words. REQUIRED: it is both the accessible name
   * (an icon alone announces nothing) and the built-in tooltip text, so the two
   * can never disagree.
   */
  label: string;
  /** Shortcut hint rendered inside the tooltip. */
  shortcut?: React.ReactNode;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  /**
   * For toggles (mute, camera): announces the on/off state via `aria-pressed`
   * and paints the active tone. Leave undefined for a plain action.
   */
  pressed?: boolean;
}

/** Icon-only button with its own tooltip and accessible name. */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { className, variant, size, active, label, shortcut, tooltipSide, pressed, type, children, ...props },
    ref,
  ) => (
    <Hint label={label} side={tooltipSide} shortcut={shortcut}>
      <button
        ref={ref}
        type={type ?? "button"}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(iconButtonVariants({ variant, size, active: active ?? pressed ?? false }), className)}
        {...props}
      >
        {children}
      </button>
    </Hint>
  ),
);
IconButton.displayName = "IconButton";
