import { Skeleton, cn } from "@demli/ui";

export interface ShellListSkeletonProps {
  /** Spoken once for the whole block ("Kanallar yükleniyor"). */
  label: string;
  /** Row geometry: a compact channel row, or a roster row with an avatar. */
  variant: "channel" | "member";
  /** How many placeholder rows. */
  rows?: number;
  className?: string;
}

/** Fixed, varied widths so the placeholder reads as a list of names, not bars. */
const WIDTHS = [72, 56, 84, 64, 48, 76, 60, 68];

/**
 * The loading state of a shell list (channel column, member roster): skeleton
 * rows in the exact geometry of the rows that will replace them, so nothing
 * jumps when the data lands (founder standing rule: skeletons, not spinners).
 * One `role="status"` for the block — screen readers hear "loading" once, not
 * per bar.
 */
export function ShellListSkeleton({
  label,
  variant,
  rows = 6,
  className,
}: ShellListSkeletonProps): JSX.Element {
  return (
    <div role="status" aria-label={label} className={cn("space-y-px", className)}>
      {Array.from({ length: rows }, (_, index) => {
        const width = `${WIDTHS[index % WIDTHS.length] ?? 64}%`;
        return variant === "channel" ? (
          <div key={index} className="flex h-8 items-center gap-2 px-2">
            <Skeleton shape="rect" width={18} height={18} className="rounded-sm" />
            <Skeleton shape="line" width={width} height={10} />
          </div>
        ) : (
          <div key={index} className="flex h-12 items-center gap-2.5 px-2">
            <Skeleton shape="circle" width={32} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton shape="line" width={width} height={10} />
              {index % 3 === 0 && <Skeleton shape="line" width="40%" height={8} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
