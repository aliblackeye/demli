import { EyeOff } from "lucide-react";
import { useTranslation } from "@demli/i18n";
import { cn } from "@demli/ui";

export interface IgnoredRunRowProps {
  /** Messages folded into this placeholder. */
  count: number;
  /** Distinct ignored authors in the run — singular vs plural copy. */
  authorCount: number;
  /** The viewer revealed the run (its message rows render below this bar). */
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The ADR 0019 §4 fold: a thin bar standing in for a run of messages from
 * ignored authors, with a Show/Hide affordance.
 *
 * An ignore is about ATTENTION, not access — the ignorer is not hiding the
 * content from themselves — so the bar is always expandable, and expanding
 * restores the real rows instantly (nothing was hidden server-side, so there is
 * no history to refetch).
 *
 * VIRTUALIZATION CONTRACT — this row's border box must be a CONSTANT `h-8`
 * (32px), matching MessageList's `estimateSize`, in both states and on hover.
 * The message list observes every row with a ResizeObserver (`measureElement`);
 * a row that grows on hover re-measures and shifts every row below it, which is
 * exactly the founder-reported "hover edince yukarı aşağı kayıyor" bug fixed in
 * MessageRow. So: no display swaps, no padding/border changes, no size-changing
 * icon — hover moves COLOR only, and both labels ride the same fixed-height line.
 */
export function IgnoredRunRow({
  count,
  authorCount,
  expanded,
  onToggle,
}: IgnoredRunRowProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const label =
    authorCount > 1
      ? t("desktop:chat.ignoredRunMany", { count })
      : t("desktop:chat.ignoredRun", { count });

  return (
    <div className="flex h-8 items-center px-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          // Safari 12: no flex `gap` → `space-x-2` reproduces the icon/text gutter.
          "group/ignored flex h-6 min-w-0 max-w-full cursor-pointer items-center space-x-2",
          "rounded-md px-2 text-2xs text-fg-faint transition-colors motion-instant",
          "hover:bg-hover hover:text-fg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        )}
      >
        <EyeOff className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate italic">{label}</span>
        <span className="shrink-0 font-semibold not-italic text-fg-muted group-hover/ignored:text-fg">
          {expanded ? t("desktop:chat.ignoredHide") : t("desktop:chat.ignoredShow")}
        </span>
      </button>
    </div>
  );
}
