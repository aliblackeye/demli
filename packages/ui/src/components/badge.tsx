import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  "inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-pill px-2 py-0.5 text-xs font-medium leading-4",
  {
    variants: {
      variant: {
        /** Neutral pill (white 12%) — counts, tags, "beta". */
        neutral: "bg-white/12 text-fg",
        accent: "bg-accent-surface text-accent-hover",
        success: "bg-success/12 text-success",
        warning: "bg-warning/12 text-warning",
        danger: "bg-danger/12 text-danger",
        /** Pill over video / images: veil + blur, with the inset signature line. */
        veil: "bg-veil text-fg backdrop-blur-[8px] shadow-[inset_0_-1px_0_rgb(38_49_64/0.32)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** Small status / label pill. Text only — put meaning in the words, not the colour. */
export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export interface CountBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  count: number;
  /** Above this the badge reads "{max}+". Default 99. */
  max?: number;
  /**
   * Spoken form, e.g. "3 okunmamış mesaj". Without it the badge is decorative
   * (`aria-hidden`) and the surrounding control must say the count itself.
   */
  label?: string;
  /** `muted` = grey (muted channel), `accent` = coral (unread / mention). */
  tone?: "accent" | "muted";
}

/**
 * Unread / mention counter: an 18px coral pill with dark ink (7.5:1), tabular
 * figures so the width does not jitter as the number changes. Renders nothing
 * for 0.
 */
export function CountBadge({
  count,
  max = 99,
  label,
  tone = "accent",
  className,
  ...props
}: CountBadgeProps): JSX.Element | null {
  if (count <= 0) return null;
  const text = count > max ? `${max}+` : String(count);
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5",
        "text-2xs font-semibold leading-none tabular-nums",
        tone === "accent" ? "bg-accent text-on-accent" : "bg-raised text-fg-muted",
        className,
      )}
      {...props}
    >
      {text}
    </span>
  );
}
