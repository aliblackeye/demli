import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "../lib/cn";
import { useControllable } from "./use-controllable";

export type CheckedState = boolean | "indeterminate";

export interface CheckboxProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "value" | "defaultValue" | "defaultChecked"
  > {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible label; clicking it toggles the box. */
  label?: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
}

/**
 * 18px, radius 6 checkbox: raised tone when off, coral with a dark tick when on,
 * a dash for the mixed state. `role="checkbox"` with `aria-checked`
 * true/false/"mixed"; Space toggles it (native button), the label is a real
 * <label> so clicking the text works too.
 */
export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    { checked, defaultChecked = false, onCheckedChange, label, description, className, id, disabled, onClick, ...props },
    ref,
  ) => {
    const [state, setState] = useControllable<CheckedState>(checked, defaultChecked, (next) =>
      onCheckedChange?.(next === true),
    );
    const generated = React.useId();
    const boxId = id ?? `checkbox-${generated}`;
    const descriptionId = description ? `${boxId}-description` : undefined;
    const on = state === true;
    const mixed = state === "indeterminate";

    const box = (
      <button
        ref={ref}
        id={boxId}
        type="button"
        role="checkbox"
        aria-checked={mixed ? "mixed" : on}
        aria-describedby={descriptionId}
        disabled={disabled}
        data-state={mixed ? "indeterminate" : on ? "checked" : "unchecked"}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setState(!on);
        }}
        className={cn(
          "mt-px inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[6px]",
          "transition-colors motion-hover",
          on || mixed ? "bg-accent text-on-accent hover:bg-accent-hover" : "bg-raised hover:bg-raised-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
          "disabled:pointer-events-none disabled:opacity-40",
          !label && className,
        )}
        {...props}
      >
        {mixed ? (
          <Minus aria-hidden className="size-3" strokeWidth={3} />
        ) : on ? (
          <Check aria-hidden className="size-3" strokeWidth={3} />
        ) : null}
      </button>
    );

    if (!label) return box;
    return (
      <span className={cn("inline-flex items-start gap-2.5", className)}>
        {box}
        <span className={cn("flex min-w-0 flex-col", disabled && "opacity-40")}>
          <label htmlFor={boxId} className="cursor-pointer text-sm font-medium leading-5 text-fg">
            {label}
          </label>
          {description && (
            <span id={descriptionId} className="text-label text-fg-faint">
              {description}
            </span>
          )}
        </span>
      </span>
    );
  },
);
Checkbox.displayName = "Checkbox";
