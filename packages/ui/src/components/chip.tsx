import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const chipVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap font-medium",
  {
    variants: {
      variant: {
        /** @mention inside message text: coral wash, coral-light label, radius 6. */
        mention: "rounded-[6px] bg-accent-surface px-1 text-accent-hover",
        /** Role tag on a profile / member row: white 12% pill. */
        role: "rounded-pill bg-white/12 px-2.5 py-1 text-xs leading-4 text-fg",
        /** Generic removable filter / selection chip. */
        neutral: "rounded-pill bg-surface px-2.5 py-1 text-xs leading-4 text-fg-muted",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {
  /** Role colour shown as a leading dot (role chips). */
  dotColor?: string;
}

/** Non-interactive chip: mention, role or neutral. */
export function Chip({ className, variant, dotColor, children, ...props }: ChipProps): JSX.Element {
  return (
    <span className={cn(chipVariants({ variant }), className)} {...props}>
      {dotColor && (
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export interface ReactionChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  emoji: React.ReactNode;
  count: number;
  /** The current user reacted — coral wash, and `aria-pressed` for assistive tech. */
  mine: boolean;
  /** Spoken form, e.g. "😂 tepkisi, 3 kişi. Sen de tepki verdin." */
  label: string;
}

/**
 * Reaction pill under a message. A toggle: pressing it adds or removes your
 * reaction, so it announces as a pressed/unpressed button.
 */
export const ReactionChip = React.forwardRef<HTMLButtonElement, ReactionChipProps>(
  ({ emoji, count, mine, label, className, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-pressed={mine}
      aria-label={label}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-pill px-2.5",
        "transition-colors motion-hover",
        mine ? "bg-accent-surface hover:bg-accent/20" : "bg-surface hover:bg-raised",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="text-sm leading-none">
        {emoji}
      </span>
      <span
        aria-hidden
        className={cn("text-xs font-medium tabular-nums", mine ? "text-accent-hover" : "text-fg-muted")}
      >
        {count}
      </span>
    </button>
  ),
);
ReactionChip.displayName = "ReactionChip";
