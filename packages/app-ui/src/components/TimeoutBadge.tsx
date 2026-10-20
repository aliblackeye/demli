import { Clock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import { formatTimeoutUntil } from "./memberTimeout";

export interface TimeoutBadgeProps {
  /** ISO instant the mute lapses — drives the tooltip's "until …" copy. */
  timedOutUntil: string;
  className?: string;
}

/**
 * The timed-out (muted) indicator — ADR 0019 §3. A small clock beside the name,
 * in the roster and on the message row, with the expiry instant in a tooltip.
 *
 * Deliberately an ICON, not a colored pill: a timeout is temporary and
 * reversible, and the roster already spends its color budget on roles and
 * presence. It carries an `aria-label` so it is not a purely visual fact.
 *
 * Whether it renders at all is the caller's decision — `useActiveTimeouts`
 * removes an id the instant its mute lapses, so this component never has to
 * decide whether a stored instant is still in force.
 */
export function TimeoutBadge({ timedOutUntil, className }: TimeoutBadgeProps): JSX.Element {
  const { t, i18n } = useTranslation(["common", "desktop"]);
  const until = formatTimeoutUntil(timedOutUntil, i18n.language);
  const label = until
    ? t("desktop:members.timedOutUntil", { date: until })
    : t("desktop:members.timedOut");

  // `role="img"` so the label is announced as the glyph's name (an <svg> with a
  // bare aria-label is skipped by several screen readers). The tooltip opens on
  // hover; the same text reaches keyboard and screen-reader users through the
  // label, so the badge stays out of the tab order of a 50-row roster.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Clock
          role="img"
          aria-label={label}
          className={cn("size-3.5 shrink-0 self-center text-warning", className)}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
