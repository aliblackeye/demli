import type { ReactNode } from "react";
import { cn } from "@demli/ui";

/**
 * The label above every grouped list in the shell — channel sections and
 * categories, the Home DM/group headings, the member roster's presence groups,
 * the friends Online/All/Pending counts. One source, so one tweak lands
 * everywhere at once.
 *
 * Koyu Masa recipe (the landing's `BolumEtiketi`): 13px, medium weight, written
 * in the catalog's own sentence case — no forced uppercase, no letter-spacing.
 * The shell is a quiet column of names; a shouting all-caps label was the one
 * loud thing in it. Text colour is `fg-faint` (#8f8f8f, AA on every column tone);
 * `tone="muted"` lifts it one step for a list whose heading carries a count.
 *
 * Presentation only — the caller passes the already-localized text as children,
 * so this stays i18n-agnostic and renders unchanged on desktop and web.
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
        "px-2 pb-1.5 pt-4 text-label font-medium tracking-[-0.01em]",
        tone === "muted" ? "text-fg-muted" : "text-fg-faint",
        className,
      )}
    >
      {children}
    </h3>
  );
}
