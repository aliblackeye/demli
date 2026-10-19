import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { fieldClass } from "./input";
import { useControllable } from "./use-controllable";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional second line (e.g. a device's driver name). */
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Shown on the trigger while nothing is selected. */
  placeholder: string;
  disabled?: boolean;
  /** Marks the trigger invalid (danger wash), like Input. */
  invalid?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-errormessage"?: string;
}

/**
 * Single-choice select: a field-styled trigger (`aria-haspopup="listbox"`) and
 * a glass listbox in a Radix Popover (focus return, outside-click and Esc
 * dismissal come from Radix).
 *
 * Keyboard (WAI-ARIA listbox): on the trigger ArrowDown/ArrowUp/Enter/Space
 * open; inside, ArrowUp/ArrowDown move the active option (disabled ones are
 * skipped), Home/End jump, Enter/Space choose, typing a letter jumps to the
 * next matching label, Tab closes. The active option is tracked with
 * `aria-activedescendant`, so focus stays on the listbox.
 */
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled = false,
  invalid,
  id,
  className,
  ...aria
}: SelectProps): JSX.Element {
  const [current, setCurrent] = useControllable<string | undefined>(value, defaultValue, (next) => {
    if (next !== undefined) onValueChange?.(next);
  });
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState<number>(-1);
  const generated = React.useId();
  const listId = `select-${generated}-list`;
  const optionId = (index: number): string => `select-${generated}-opt-${index}`;
  const typeahead = React.useRef({ text: "", at: 0 });
  const listRef = React.useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const enabledIndexes = options.flatMap((o, i) => (o.disabled ? [] : [i]));

  const openAt = (index: number): void => {
    setActive(index);
    setOpen(true);
  };

  const step = (delta: 1 | -1): void => {
    if (enabledIndexes.length === 0) return;
    const pos = enabledIndexes.indexOf(active);
    const next =
      pos === -1
        ? delta === 1
          ? enabledIndexes[0]
          : enabledIndexes[enabledIndexes.length - 1]
        : enabledIndexes[Math.min(enabledIndexes.length - 1, Math.max(0, pos + delta))];
    if (next !== undefined) setActive(next);
  };

  const choose = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
    setCurrent(option.value);
    setOpen(false);
  };

  React.useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        return;
      case "Home":
        event.preventDefault();
        if (enabledIndexes[0] !== undefined) setActive(enabledIndexes[0]);
        return;
      case "End": {
        event.preventDefault();
        const last = enabledIndexes[enabledIndexes.length - 1];
        if (last !== undefined) setActive(last);
        return;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          const buffer = now - typeahead.current.at > 600 ? event.key : typeahead.current.text + event.key;
          typeahead.current = { text: buffer, at: now };
          const query = buffer.toLocaleLowerCase();
          const start = buffer.length === 1 ? active + 1 : active;
          const ordered = [...options.keys()].map((_, i) => (start + i + options.length) % options.length);
          const hit = ordered.find((i) => {
            const option = options[i];
            return option && !option.disabled && option.label.toLocaleLowerCase().startsWith(query);
          });
          if (hit !== undefined) setActive(hit);
        }
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => (next ? openAt(selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? -1)) : setOpen(false))}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          aria-invalid={invalid === true || aria["aria-invalid"] === true || aria["aria-invalid"] === "true" ? true : undefined}
          aria-label={aria["aria-label"]}
          aria-labelledby={aria["aria-labelledby"]}
          aria-describedby={aria["aria-describedby"]}
          aria-errormessage={aria["aria-errormessage"]}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
              event.preventDefault();
              const fallback = event.key === "ArrowUp" ? enabledIndexes[enabledIndexes.length - 1] : enabledIndexes[0];
              openAt(selectedIndex >= 0 ? selectedIndex : (fallback ?? -1));
            }
          }}
          className={cn(
            fieldClass,
            "flex h-10 cursor-pointer items-center justify-between gap-2 py-2.5 text-left",
            "data-[state=open]:bg-raised",
            className,
          )}
        >
          <span className={cn("min-w-0 truncate", !selected && "text-fg-faint")}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 text-fg-faint transition-transform motion-standard", open && "rotate-180")}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus();
          }}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-44 max-h-[min(20rem,var(--radix-popover-content-available-height))] overflow-y-auto",
            "rounded-lg surface-glass-strong p-1",
            "data-[state=open]:animate-pop-in-fast data-[state=closed]:animate-pop-out",
          )}
        >
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label={aria["aria-label"]}
            aria-labelledby={aria["aria-labelledby"]}
            onKeyDown={onListKeyDown}
            className="outline-none"
          >
            {options.map((option, index) => {
              const isSelected = option.value === current;
              return (
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-active={index === active || undefined}
                  onPointerMove={() => {
                    if (!option.disabled && index !== active) setActive(index);
                  }}
                  onClick={() => choose(index)}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium",
                    "transition-colors motion-hover",
                    isSelected ? "text-fg" : "text-fg-muted",
                    "data-[active]:bg-raised data-[active]:text-fg",
                    option.disabled && "pointer-events-none opacity-40",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.description && (
                      <span className="truncate text-xs font-normal text-fg-faint">{option.description}</span>
                    )}
                  </span>
                  {isSelected && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
                </div>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
