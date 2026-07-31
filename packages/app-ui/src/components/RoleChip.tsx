import { cn } from "@demli/ui";

/** Neutral dot colour when a role carries no colour of its own. */
const ROLE_DOT_FALLBACK = "var(--color-fg-faint, #8b8b8b)";

/**
 * A single role rendered as a rounded chip with a leading colour dot — the same
 * concept the member roster shows on each row and the profile card lists in full.
 * Two intentional sizes:
 *
 *  - `sm` — the compact, background-filled, width-clipped chip that rides on a
 *    member row's second line (kept narrow so the fixed row height never grows).
 *  - `md` — the roomier, borderless-fill chip that wraps freely in the profile
 *    card's role list.
 *
 * Was two near-identical `RoleChip`/`RoleChips` definitions; unified here so the
 * dot + pill treatment lives in one place. Presentation only.
 */
export function RoleChip({
  name,
  color,
  size = "md",
  className,
}: {
  name: string;
  color: string | null;
  size?: "sm" | "md";
  className?: string;
}): JSX.Element {
  const sm = size === "sm";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-stroke text-fg-muted",
        sm
          ? "max-w-[7rem] shrink-0 bg-raised/50 px-1.5 py-px text-badge leading-none"
          : "px-2 py-0.5 text-2xs font-medium",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("shrink-0 rounded-full", sm ? "size-1.5" : "size-2")}
        style={{ backgroundColor: color ?? ROLE_DOT_FALLBACK }}
      />
      <span className={cn(sm && "truncate")}>{name}</span>
    </span>
  );
}
