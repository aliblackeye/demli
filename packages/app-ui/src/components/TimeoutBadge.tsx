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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Clock
          aria-label={label}
          className={cn("size-3.5 shrink-0 self-center text-idle", className)}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
