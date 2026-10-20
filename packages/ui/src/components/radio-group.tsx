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

/**
 * Shared wiring for every option shape: registration for roving focus, the
 * checked/disabled state, and the arrow-key handler. Kept private so RadioItem
 * and RadioCard can never disagree about how the group behaves.
 */
function useRadioOption(value: string, disabled: boolean) {
  const ctx = React.useContext(RadioContext);
  if (!ctx) throw new Error("Radio options must be rendered inside a RadioGroup");
  const checked = ctx.value === value;
  const isDisabled = disabled || ctx.disabled;
  const { register } = ctx;
  const ref = React.useCallback(
    (node: HTMLButtonElement | null) => register(value, node, isDisabled),
    [register, value, isDisabled],
  );
  const optionProps = {
    ref,
    type: "button" as const,
    role: "radio" as const,
    "aria-checked": checked,
    disabled: isDisabled,
    tabIndex: ctx.focusValue === value ? 0 : -1,
    "data-state": checked ? "checked" : "unchecked",
    onClick: () => ctx.select(value),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const delta = KEY_MOVES[event.key];
      if (delta !== undefined) {
        event.preventDefault();
        ctx.move(value, delta);
      }
    },
  };
  return { checked, optionProps };
}

export interface RadioCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  label: React.ReactNode;
  /** Second line (a bitrate, a resolution, a one-line hint). */
  detail?: React.ReactNode;
  /** Optional leading glyph (lucide icon element). */
  icon?: React.ReactNode;
  /** `center` for compact preset grids, `start` for wider cards with an icon. */
  align?: "center" | "start";
}

/**
 * One option drawn as a CARD — for segmented preset grids (quality tiers,
 * frame rates, channel type) where a radio dot would be noise. Same group
 * semantics as {@link RadioItem} (one tab stop, arrows move AND select). The
 * selected card takes the coral wash plus a coral inner trace, so selection
 * reads without relying on colour alone (the trace is a shape change too).
 */
export function RadioCard({
  value,
  label,
  detail,
  icon,
  align = "center",
  disabled = false,
  className,
  ...props
}: RadioCardProps): JSX.Element {
  const { checked, optionProps } = useRadioOption(value, disabled);
  return (
    <button
      {...optionProps}
      className={cn(
        "flex min-w-0 cursor-pointer gap-3 rounded-lg px-3 py-2.5",
        align === "center" ? "flex-col items-center gap-0.5 text-center" : "items-start text-left",
        "transition-[background-color,box-shadow,color] motion-hover",
        checked
          ? "bg-accent-surface shadow-[inset_0_0_0_1px_rgb(255_132_100/0.45)]"
          : "bg-raised/60 hover:bg-raised active:bg-raised-pressed",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center justify-center transition-colors motion-hover [&_svg]:size-4",
            align === "start" && "mt-0.5",
            checked ? "text-accent" : "text-fg-faint",
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate text-sm font-medium leading-5 transition-colors motion-hover",
            checked ? "text-accent-hover" : "text-fg",
          )}
        >
          {label}
        </span>
        {detail && (
          <span className={cn("text-2xs leading-4 text-fg-faint", align === "center" && "line-clamp-2")}>{detail}</span>
        )}
      </span>
    </button>
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
        checked ? "bg-accent-surface" : "hover:bg-wash",
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
