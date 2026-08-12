"use client";

import { motion } from "framer-motion";
import { SlideHoverText } from "./SlideHoverText";

type PillLinkProps = {
  href: string;
  label: string;
  /** tertiary: saydam nav sekmesi · secondary: #262626 zeminli küçük buton */
  variant?: "tertiary" | "secondary";
};

/**
 * Ölçülen ortak değerler: radius 12px, padding 8px 12px, flex row gap 8,
 * secondary zemini #262626. Hover: kayan metin (authored spring).
 */
export function PillLink({ href, label, variant = "tertiary" }: PillLinkProps) {
  return (
    <motion.a
      href={href}
      initial="rest"
      animate="rest"
      whileHover="hover"
      className={
        "flex items-center justify-center gap-2 rounded-[12px] px-3 py-2 " +
        (variant === "secondary" ? "bg-surface-2" : "")
      }
    >
      <SlideHoverText label={label} />
    </motion.a>
  );
}
