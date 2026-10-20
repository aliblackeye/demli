import { cn } from "@demli/ui";

/** Per-dot phase offset: the three dots bounce in sequence, left to right. */
const DOT_DELAYS = ["0s", "0.2s", "0.4s"] as const;

/**
 * The "someone is typing" glyph: three small dots bouncing in turn on a 1.4s
 * cycle. Each dot translates upward and back, staggered by 200ms — the same
 * rhythm Discord popularised. Pure CSS animation, no JS per frame.
 * `motion-reduce:animate-none` leaves a still ellipsis for a11y.
 */
export function TypingDots({ className }: { className?: string }): JSX.Element {
  return (
    <span aria-hidden className={cn("inline-flex items-center gap-[3px]", className)}>
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-typing-bounce rounded-full bg-fg-muted motion-reduce:animate-none"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}
