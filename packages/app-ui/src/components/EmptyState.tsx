import type { ReactNode } from "react";
import { Button, cn } from "@demli/ui";

/**
 * The composed "nothing here yet" panel — the landing's `BosDurum` recipe: a
 * glyph in a 48px surface box (radius 16), a display-face title, a supporting
 * line in the faint step, optionally one action. Every empty list in the app
 * reads the same, and gaining an empty state is a one-liner.
 *
 * Arrives with the fast fade so a list that resolves to empty does not blink
 * from skeleton to text.
 *
 * Presentation only — the caller passes already-localized strings, so it renders
 * unchanged on desktop and web.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  /** A lucide glyph (rendered at size-6 inside the box). */
  icon: ReactNode;
  title: string;
  body?: string;
  /** Optional call-to-action below the copy (a Button, link, etc.). */
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex animate-fade-in flex-col items-center gap-3 px-4 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-xl bg-surface text-fg-faint [&_svg]:size-6">
        {icon}
      </div>
      <div className="flex max-w-72 flex-col gap-1">
        <p className="font-display text-lg font-medium leading-tight text-fg-display">{title}</p>
        {body && <p className="text-label text-fg-faint">{body}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/**
 * The "couldn't load — try again" placeholder shared by list views. Kept next to
 * {@link EmptyState} because the two are the same family of list placeholder:
 * a list shows exactly one of skeleton / retry / empty / rows.
 *
 * - `variant="block"` (default): centered, for a full view (friends, call
 *   history) — the message in the muted step over a secondary retry button.
 * - `variant="band"`: a danger-tinted card for a sidebar list section (the
 *   channel column, the roster, the home DM / group-chat lists), with an
 *   optional `title` naming WHAT failed above the localized reason.
 */
export function RetryNotice({
  message,
  title,
  retryLabel,
  onRetry,
  variant = "block",
  className,
}: {
  message: string;
  /** Band only: names what failed ("Kanallar yüklenemedi"); `message` says why. */
  title?: string;
  retryLabel: string;
  onRetry: () => void;
  variant?: "block" | "band";
  className?: string;
}): JSX.Element {
  if (variant === "band") {
    return (
      <div
        role="alert"
        className={cn(
          "mx-1 flex animate-fade-in flex-col items-start gap-1 rounded-lg bg-danger-surface px-3 py-2.5",
          className,
        )}
      >
        {title && <p className="text-label font-medium text-danger">{title}</p>}
        <p className={title ? "text-2xs leading-snug text-fg-muted" : "text-label text-danger"}>
          {message}
        </p>
        <Button variant="ghost" size="sm" className="-ml-2 mt-1" onClick={onRetry}>
          {retryLabel}
        </Button>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn("flex animate-fade-in flex-col items-center gap-3 py-16 text-center", className)}
    >
      <p className="max-w-72 text-label text-fg-muted">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
