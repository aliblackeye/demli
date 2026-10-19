import * as React from "react";
import { cn } from "../lib/cn";
import { useControllable } from "./use-controllable";

type Move = 1 | -1 | "first" | "last";

interface RadioContextValue {
  value: string | undefined;
  focusValue: string | undefined;
  select: (value: string) => void;
  register: (value: string, node: HTMLButtonElement | null, disabled: boolean) => void;
  move: (from: string, delta: Move) => void;
  disabled: boolean;
}

const RadioContext = React.createContext<RadioContextValue | null>(null);

export interface RadioGroupProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue" | "dir"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

const KEY_MOVES: Record<string, Move> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

/**
 * Radio group with WAI-ARIA keyboard behaviour: the group is ONE tab stop (the
 * selected option, or the first one), arrow keys move AND select, Home/End jump
 * to the ends, disabled options are skipped. Name it with `aria-label` or
 * `aria-labelledby`.
 */
export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  className,
  children,
  ...props
}: RadioGroupProps): JSX.Element {
  const [current, setCurrent] = useControllable<string | undefined>(value, defaultValue, (next) => {
    if (next !== undefined) onValueChange?.(next);
  });
  const items = React.useRef(new Map<string, { node: HTMLButtonElement; disabled: boolean }>());
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);

  const register = React.useCallback(
    (v: string, node: HTMLButtonElement | null, itemDisabled: boolean) => {
      const had = items.current.has(v);
      if (node) items.current.set(v, { node, disabled: itemDisabled });
      else items.current.delete(v);
      if (had !== Boolean(node)) rerender();
    },
    [],
  );

  /** Enabled values in DOM order. */
  const enabled = (): string[] =>
    [...items.current.entries()]
      .filter(([, item]) => !item.disabled)
      .sort(([, a], [, b]) =>
        a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      .map(([v]) => v);

  const select = React.useCallback(
    (v: string) => {
      setCurrent(v);
      items.current.get(v)?.node.focus();
    },
    [setCurrent],
  );

  const move = (from: string, delta: Move): void => {
    const list = enabled();
    if (list.length === 0) return;
    let target: string | undefined;
    if (delta === "first") target = list[0];
    else if (delta === "last") target = list[list.length - 1];
    else {
      const index = list.indexOf(from);
      target = list[(index + delta + list.length) % list.length];
    }
    if (target !== undefined) select(target);
  };

  const list = enabled();
  const focusValue = current !== undefined && list.includes(current) ? current : list[0];

  return (
    <RadioContext.Provider value={{ value: current, focusValue, select, register, move, disabled }}>
      <div
        role="radiogroup"
        aria-disabled={disabled || undefined}
        className={cn("flex flex-col gap-1", className)}
        {...props}
      >
        {children}
      </div>
    </RadioContext.Provider>
  );
}

export interface RadioItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * One option, drawn as the Koyu Masa radio ROW: the whole row is the hit
 * target, and the selected row takes the coral wash and a coral label.
 */
export function RadioItem({
  value,
  label,
  description,
  disabled = false,
  className,
  ...props
}: RadioItemProps): JSX.Element {
  const ctx = React.useContext(RadioContext);
  if (!ctx) throw new Error("RadioItem must be rendered inside a RadioGroup");
  const generated = React.useId();
  const descriptionId = description ? `radio-${generated}-description` : undefined;
  const checked = ctx.value === value;
  const isDisabled = disabled || ctx.disabled;
  const { register } = ctx;
  const ref = React.useCallback(
    (node: HTMLButtonElement | null) => register(value, node, isDisabled),
    [register, value, isDisabled],
  );

  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-describedby={descriptionId}
      disabled={isDisabled}
      tabIndex={ctx.focusValue === value ? 0 : -1}
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => ctx.select(value)}
      onKeyDown={(event) => {
        const delta = KEY_MOVES[event.key];
        if (delta !== undefined) {
          event.preventDefault();
          ctx.move(value, delta);
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 text-left",
        "transition-colors motion-hover",
        checked ? "bg-accent-surface" : "hover:bg-surface",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full transition-colors motion-hover",
          checked ? "bg-accent" : "bg-raised",
        )}
      >
        {checked && <span className="size-[7px] rounded-full bg-on-accent" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn("text-sm font-medium leading-5", checked ? "text-accent-hover" : "text-fg")}
        >
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="text-label text-fg-faint">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}
