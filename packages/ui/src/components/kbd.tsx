import type * as React from "react";
import { cn } from "../lib/cn";

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

/** Small keyboard-shortcut hint chip (e.g. Esc, Ctrl K). */
export function Kbd({ children, className }: KbdProps): JSX.Element {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center",
        "rounded border border-stroke-strong bg-raised px-1.5",
        "font-sans text-badge font-semibold tracking-wide text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
