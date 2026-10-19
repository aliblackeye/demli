import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Shared field recipe (Koyu Masa): borderless, radius 12, surface tone at rest,
 * raised tone + coral caret + a faint coral inner trace on focus. Invalid =
 * the danger wash as the field's own background (no red frame, no icon); the
 * message itself is rendered by {@link Field} underneath.
 *
 * `aria-invalid` drives the invalid look, so a field marked invalid for
 * assistive tech is always the one that LOOKS invalid.
 */
export const fieldClass = cn(
  "w-full rounded-lg bg-surface px-3.5 text-sm text-fg caret-accent",
  "placeholder:text-fg-faint",
  "transition-[background-color,box-shadow] motion-hover",
  "hover:bg-raised/60",
  "focus:outline-none focus-visible:outline-none focus:bg-raised focus:shadow-[inset_0_0_0_1px_rgb(255_132_100/0.35)]",
  "aria-[invalid=true]:bg-danger/12 aria-[invalid=true]:focus:shadow-[inset_0_0_0_1px_rgb(255_111_181/0.45)]",
  "disabled:pointer-events-none disabled:opacity-40",
);

/** `aria-invalid` accepts booleans and the strings "true"/"false"/"grammar"/"spelling". */
export function isInvalid(
  invalid: boolean | undefined,
  aria: React.AriaAttributes["aria-invalid"],
): true | undefined {
  return invalid === true || aria === true || aria === "true" ? true : undefined;
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Shorthand for `aria-invalid`. */
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(fieldClass, "h-10 py-2.5", className)}
      {...props}
      aria-invalid={isInvalid(invalid, props["aria-invalid"])}
    />
  ),
);
Input.displayName = "Input";
