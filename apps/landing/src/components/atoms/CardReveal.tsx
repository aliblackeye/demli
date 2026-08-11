"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Referans deseni (ölçüldü): kart görünür olunca BİR KEZ y 64→0 +
 * opacity 0→1 (~0.6s). Stagger için delay parametresi.
 * Viewport üstünde kalan kartlar açık başlasın diye amount düşük.
 */
export function CardReveal({
  children,
  delay = 0,
  y = 64,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.05 }}
      transition={{ type: "spring", duration: 0.7, bounce: 0.2, delay }}
    >
      {children}
    </motion.div>
  );
}
