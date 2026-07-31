import type { ReactNode } from "react";
import { Button, cn } from "@demli/ui";

/**
 * The composed "nothing here yet" panel — a muted icon in a soft circle, a title
 * and a supporting line, optionally an action. Was hand-repeated with identical
 * markup in the Friends view and the call-history view; consolidated here so
 * every empty list reads the same and gaining an empty state is a one-liner
 * (redesign skill: "no empty states" is a finish-line miss).
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
  /** A lucide glyph (rendered at size-6 inside the circle). */
  icon: ReactNode;
  title: string;
  body?: string;
  /** Optional call-to-action below the copy (a Button, link, etc.). */
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-4 py-16 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-raised text-fg-muted">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-fg">{title}</p>
        {body && <p className="mt-1 text-xs text-fg-faint">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * The centered "couldn't load — try again" block shared by list views (friends,
 * call history). A muted message over a secondary retry button. Was duplicated
 * inline; kept next to {@link EmptyState} because the two are the same family of
 * list placeholder.
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
    <div className={cn("flex flex-col items-center gap-2 py-16 text-center", className)}>
      <p className="text-xs text-fg-muted">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
