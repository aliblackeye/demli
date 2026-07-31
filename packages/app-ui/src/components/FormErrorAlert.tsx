import type { ReactNode } from "react";
import { cn } from "@demli/ui";

/**
 * The inline form-error banner — a soft danger-tinted chip with `role="alert"`
 * so a submit failure is announced. Was hand-repeated as
 * `<p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">`
 * across a dozen dialogs and settings panels; this is the single source.
 *
 * The bottom margin between the banner and the field it precedes varies by form
 * (`mb-3`, `mb-4`, or none), so it is left to the caller via `className` — the
 * banner itself owns only its own box.
 */
export function FormErrorAlert({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p
      role="alert"
      className={cn("rounded-md bg-danger/10 px-3 py-2 text-xs text-danger", className)}
    >
      {children}
    </p>
  );
}
