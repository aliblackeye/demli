import * as React from "react";
import { cn } from "../lib/cn";
import { useControllable } from "./use-controllable";

export interface SwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "value" | "defaultValue" | "defaultChecked"
  > {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * On/off switch, 44×24 with an 18px thumb that travels on the authored position
 * spring (CSS `motion-spring`). `role="switch"` + `aria-checked`; Space and
 * Enter toggle it because it is a real <button>. Give it a name with
 * `aria-label`, `aria-labelledby`, or a wrapping <label>.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, defaultChecked = false, onCheckedChange, className, onClick, disabled, ...props }, ref) => {
    const [on, setOn] = useControllable(checked, defaultChecked, onCheckedChange);
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        data-state={on ? "checked" : "unchecked"}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setOn(!on);
        }}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full",
          "transition-colors motion-hover",
          on ? "bg-accent hover:bg-accent-hover" : "bg-raised hover:bg-raised-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
          "disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0.5 top-[3px] size-[18px] rounded-full bg-inverse",
            "transition-transform motion-spring",
            on ? "translate-x-[22px]" : "translate-x-0",
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";
