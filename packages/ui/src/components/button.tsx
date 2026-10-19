import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Koyu Masa product button: five variants × three sizes, borderless, tone-only
 * hover (200ms), a darker/lighter tone on press, 40% when disabled.
 *
 *   primary   white fill, dark ink — the one main action of a surface
 *   secondary raised tone (#262626)
 *   accent    coral fill, dark ink — the warm call to action (join, invite)
 *   danger    pink wash + pink ink — destructive; never a solid fill, so the
 *             label keeps ≥4.5:1 (white on the pink fill is 2.6:1)
 *   ghost     no fill until hovered
 *
 * `default` (= accent) and `outline` stay as aliases so the ~175 existing call
 * sites keep compiling and keep their meaning; new code names the variant.
 */
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-[color,background-color,box-shadow,opacity] motion-hover",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
    "disabled:pointer-events-none [&:disabled:not([aria-busy])]:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-inverse text-on-inverse hover:bg-inverse-hover active:bg-inverse-pressed",
        secondary: "bg-raised text-fg hover:bg-raised-hover active:bg-raised-pressed",
        accent: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
        danger: "bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/28",
        ghost: "bg-transparent text-fg-muted hover:bg-surface hover:text-fg active:bg-app",
        default: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed",
        outline:
          "bg-transparent text-fg shadow-[inset_0_0_0_1px_var(--color-stroke-strong)] hover:bg-surface active:bg-app",
      },
      size: {
        lg: "h-11 rounded-[14px] px-5 text-[15px] leading-5",
        md: "h-9.5 rounded-lg px-4 text-sm leading-[18px]",
        sm: "h-7.25 rounded-md px-3 text-label leading-[17px]",
        icon: "size-9.5 rounded-lg",
        "icon-sm": "size-7.25 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Busy state: shows a spinner over the label, keeps the button's width, and
   * blocks further clicks (`aria-busy` + disabled) until the caller clears it.
   */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, loading = false, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="invisible inline-flex items-center gap-2">{children}</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 aria-hidden className="size-4 animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </button>
  ),
);
Button.displayName = "Button";
