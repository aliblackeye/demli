import { cn } from "@demli/ui";

/**
 * The small numeric unread badge (#110) shared by the channel sidebar, the Home
 * DM/group-chat rows, and the group rail. A pill that hugs its text — an 18px
 * circle for one digit, widening for "12" / "99+". The text is produced upstream
 * by `unreadBadgeText` (the "no fake number" rule lives there); this is
 * presentation only.
 *
 * Two tones, one meaning each, identical on every surface:
 *   `accent`  — coral fill, dark ink (7.5:1): someone spoke TO you (a mention, a DM)
 *   `neutral` — light chip, dark ink: the channel simply moved
 *
 * Same geometry and figures as `@demli/ui`'s CountBadge (18px, tabular), so a
 * count reads the same wherever it sits. It pops in (fast step, scale .98 → 1)
 * when it first appears and again when its number changes (callers key it by
 * text), which is the feedback that something new arrived; the global
 * reduced-motion guard flattens that to an instant change.
 */
export function UnreadCountBadge({
  text,
  tone = "accent",
  className,
  "aria-label": ariaLabel,
}: {
  text: string;
  tone?: "accent" | "neutral";
  className?: string;
  "aria-label"?: string;
}): JSX.Element {
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5",
        "text-2xs font-semibold leading-none tabular-nums animate-pop-in-fast",
        tone === "accent" ? "bg-accent text-on-accent" : "bg-fg text-on-inverse",
        className,
      )}
    >
      {text}
    </span>
  );
}
