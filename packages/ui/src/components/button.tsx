import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
    // Tactile press: a subtle scale-down on active gives every button physical
    // "give" without pulling framer into this shared primitive. Transform-only, so
    // it never affects layout; `transition-transform` is added alongside colors.
    "text-sm font-medium transition-[color,background-color,border-color,transform] motion-instant",
    "active:scale-[0.97]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:bg-accent-hover",
        secondary: "bg-raised text-fg hover:bg-overlay",
        outline: "border border-stroke-strong text-fg hover:bg-raised",
        ghost: "text-fg-muted hover:bg-white/[0.06] hover:text-fg",
        danger: "bg-danger text-white hover:bg-danger/85",
      },
      size: {
        // UI overhaul spec: one step up across the scale (primary CTA ≈ 44px).
        sm: "h-8 px-2.5 text-xs",
        md: "h-9 px-3.5",
        lg: "h-11 px-4",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
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
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
