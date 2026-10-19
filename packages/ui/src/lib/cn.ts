import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock theme. Without this, the app's own
 * font-size steps (`text-badge`, `text-label`, …) read as text COLOURS, so
 * `cn("text-badge", "text-fg-muted")` silently dropped the size; and the named
 * radius steps (`rounded-card`, …) were not recognised as radius at all, so a
 * call-site override could not replace them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["badge", "label", "2xs", "3xs"] }],
    },
    theme: {
      borderRadius: ["cta", "card", "panel", "pill"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
