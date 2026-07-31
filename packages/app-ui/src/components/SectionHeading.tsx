import type { ReactNode } from "react";
import { cn } from "@demli/ui";

/**
 * The uppercase, letter-spaced list-section label used above every grouped list
 * in the shell — member roster sections, channel categories, the Home DM/group
 * headings, the friends Online/All/Pending counts. Was ~7 hand-repeated
 * `<h3 className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wider
 * text-fg-faint">` literals across desktop + app-ui; this is the single source so
 * one tweak (padding, tracking, colour) lands everywhere at once.
 *
 * Presentation only — the caller passes the already-localized text as children,
 * so this stays i18n-agnostic and renders unchanged on desktop and web.
 *
 * `tone` picks the muted vs faint text colour: the member roster uses the
 * slightly brighter `muted`, every other list uses the default `faint`.
 */
export function SectionHeading({
  children,
  tone = "faint",
  className,
}: {
  children: ReactNode;
  tone?: "faint" | "muted";
  className?: string;
}): JSX.Element {
  return (
    <h3
      className={cn(
        "px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wider",
        tone === "muted" ? "text-fg-muted" : "text-fg-faint",
        className,
      )}
    >
      {children}
    </h3>
  );
}
