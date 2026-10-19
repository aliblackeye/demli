import * as React from "react";
import { cn } from "../lib/cn";

export interface FieldProps {
  /** Visible label above the control (13px). */
  label: React.ReactNode;
  /** Helper line under the control; replaced by `error` while one is shown. */
  help?: React.ReactNode;
  /** Validation message. Present = the control is invalid. */
  error?: React.ReactNode;
  /** Keeps the label for screen readers only (search boxes, composer-like rows). */
  hideLabel?: boolean;
  /**
   * Announce the error line the moment it appears (`role="alert"`). For errors
   * raised by a SUBMIT, where the user may still be on the field (pressing Enter
   * in it) and a changed description alone would be silent. Leave off for
   * live-as-you-type validation, which would interrupt on every keystroke.
   */
  announceError?: boolean;
  className?: string;
  /** Exactly one form control (Input, Textarea, Select trigger, …). */
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-errormessage"?: string;
  }>;
}

/**
 * Label + control + help/error, wired for assistive tech: the label is
 * associated with the control, the help or error line is its description, and
 * an error marks the control `aria-invalid` with `aria-errormessage` — so the
 * invalid look (driven by aria-invalid) and the announcement cannot disagree.
 */
export function Field({
  label,
  help,
  error,
  hideLabel = false,
  announceError = false,
  className,
  children,
}: FieldProps): JSX.Element {
  const generated = React.useId();
  const id = children.props.id ?? `field-${generated}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const describedBy = [children.props["aria-describedby"], hasError ? errorId : help ? helpId : undefined]
    .filter(Boolean)
    .join(" ");

  const control = React.cloneElement(children, {
    id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": hasError ? true : children.props["aria-invalid"],
    "aria-errormessage": hasError ? errorId : undefined,
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-label font-medium text-fg-muted", hideLabel && "sr-only")}>
        {label}
      </label>
      {control}
      {hasError ? (
        <p id={errorId} role={announceError ? "alert" : undefined} className="text-label text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-label text-fg-faint">
          {help}
        </p>
      ) : null}
    </div>
  );
}
