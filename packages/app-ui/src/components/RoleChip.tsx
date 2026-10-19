import { cn } from "@demli/ui";

/** Neutral dot colour when a role carries no colour of its own (a token, never a literal). */
const ROLE_DOT_FALLBACK = "var(--color-fg-faint)";

/**
 * A single role rendered as a pill with a leading colour dot — the same concept
 * the member roster shows on each row and the profile card lists in full. Koyu
 * Masa recipe: borderless white-wash pill (the `role` chip of @demli/ui), the
 * role's own colour carried only by the dot so a dozen coloured roles never
 * turn a card into a rainbow. Two intentional sizes:
 *
 *  - `sm` — compact, width-clipped, rides on a member row's second line (kept
 *    narrow so the fixed row height never grows).
 *  - `md` — the roomier chip that wraps freely in the profile card's role list.
 *
 * Presentation only; the full name is on `title` for the clipped `sm` chip.
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
      title={sm ? name : undefined}
      className={cn(
        "inline-flex items-center rounded-pill text-fg-muted",
        sm
          ? "max-w-[7rem] shrink-0 gap-1 bg-wash px-1.5 py-px text-badge leading-none"
          : "gap-1.5 bg-wash-strong px-2.5 py-1 text-2xs font-medium leading-4 text-fg",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("shrink-0 rounded-full", sm ? "size-1.5" : "size-2")}
        style={{ backgroundColor: color ?? ROLE_DOT_FALLBACK }}
      />
      <span className={cn("min-w-0", sm && "truncate")}>{name}</span>
    </span>
  );
}
