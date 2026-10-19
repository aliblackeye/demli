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
 * The centered "couldn't load — try again" block shared by list views (friends,
 * call history, the home group list). The message in the muted step over a
 * secondary retry button. Kept next to {@link EmptyState} because the two are the
 * same family of list placeholder.
 */
export function RetryNotice({
  message,
  retryLabel,
  onRetry,
  className,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
  className?: string;
}): JSX.Element {
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
