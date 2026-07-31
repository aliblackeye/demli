import { cn } from "@demli/ui";

/**
 * The small numeric unread badge (#110) shared by the channel sidebar, the Home
 * DM/group-chat rows, and the group rail. A pill that hugs its text — a ~20px
 * circle for one digit, widening for "12" / "99+" / "1+". The text is produced
 * upstream by `unreadBadgeText` (the "no fake number" rule lives there); this is
 * presentation only.
 *
 * `accent` (blurple/white) marks a mention or a DM; `neutral` (a light chip with
 * dark text) is the plain-unread count — the split keeps "someone spoke to ME"
 * visually distinct from "the channel moved".
 *
 * Moved to @demli/app-ui (Phase 1) so the shared rail/sidebar can use it; the
 * desktop's `./UnreadCountBadge` re-exports this so voice-coupled ChannelItem
 * (which stays desktop) keeps its import unchanged.
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
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5",
        "text-2xs font-bold leading-none tabular-nums",
        tone === "accent" ? "bg-accent text-on-accent" : "bg-fg text-app",
        className,
      )}
    >
      {text}
    </span>
  );
}
