import type * as React from "react";
import { cn } from "../lib/cn";

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

/** Small keyboard-shortcut hint chip (e.g. Esc, Ctrl K): raised key cap, no border. */
export function Kbd({ children, className }: KbdProps): JSX.Element {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center",
        "rounded-[6px] bg-raised px-1.5 shadow-[inset_0_-1px_0_rgb(0_0_0/0.4)]",
        "font-sans text-2xs font-medium tabular-nums text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
