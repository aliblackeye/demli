import { cn } from "@demli/ui";

/** Per-dot phase offset: the three dots breathe in sequence, left to right. */
const DOT_DELAYS = ["0s", "0.16s", "0.32s"] as const;

/**
 * The "someone is typing" glyph: three small dots breathing in turn on a 1.2s
 * cycle (design system §5.1 "yazıyor"). Pure CSS opacity (`animate-pulse`), so
 * it costs no JS per frame and the global prefers-reduced-motion guard freezes
 * it — the inline duration/delay are plain declarations, which that guard's
 * `!important` override still wins over. Decorative: the words next to it carry
 * the meaning for assistive tech.
 */
export function TypingDots({ className }: { className?: string }): JSX.Element {
  return (
    <span aria-hidden className={cn("inline-flex items-center gap-[3px]", className)}>
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="size-1 rounded-full bg-fg-muted animate-pulse"
          style={{ animationDuration: "1.2s", animationDelay: delay }}
        />
      ))}
    </span>
  );
}
