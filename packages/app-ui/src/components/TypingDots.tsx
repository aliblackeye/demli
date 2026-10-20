import { cn } from "@demli/ui";

/** Per-dot phase offset: the three dots breathe in sequence, left to right. */
const DOT_DELAYS = ["0s", "0.2s", "0.4s"] as const;

/**
 * The "someone is typing" glyph: three small dots breathing in turn on a 1.2s
 * cycle (design system §5.1 "yazıyor"). Pure CSS opacity (`animate-pulse`), so
 * it costs no JS per frame. `motion-reduce:animate-none` leaves a still
 * ellipsis for viewers who asked for less motion (an infinite animation merely
 * clamped to 0.01ms by the global guard would flicker instead of stopping).
 * Decorative: the words next to it carry the meaning for assistive tech.
 */
export function TypingDots({ className }: { className?: string }): JSX.Element {
  return (
    <span aria-hidden className={cn("inline-flex items-center gap-[3px]", className)}>
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="size-1 animate-pulse rounded-full bg-fg-muted motion-reduce:animate-none"
          style={{ animationDuration: "1.2s", animationDelay: delay }}
        />
      ))}
    </span>
  );
}
