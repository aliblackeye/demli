"use client";

import { SlideHoverText } from "./SlideHoverText";

type PillLinkProps = {
  href: string;
  label: string;
  /** tertiary: saydam nav sekmesi · secondary: #262626 zeminli küçük buton */
  variant?: "tertiary" | "secondary";
};

/**
 * Ölçülen ortak değerler: radius 12px, padding 8px 12px, flex row gap 8,
 * secondary zemini #262626 (token surface-2).
 */
export function PillLink({ href, label, variant = "tertiary" }: PillLinkProps) {
  return (
    <a
      href={href}
      className={
        "group flex items-center justify-center gap-2 rounded-[12px] px-3 py-2 " +
        (variant === "secondary" ? "bg-surface-2" : "")
      }
    >
      <SlideHoverText label={label} />
    </a>
  );
}
