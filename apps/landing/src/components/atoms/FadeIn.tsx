"use client";

import { motion, type Transition } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Görünürken bir kez oynayan giriş (authored __framer__enter/animate).
 * Varsayılan: y20 + spring {bounce .2, delay .4, duration .7} — bölüm
 * tagline'larının authored konfigürasyonu (threshold .5).
 */
export function FadeIn({
  children,
  className,
  y = 20,
  amount = 0.5,
  transition = { type: "spring", bounce: 0.2, delay: 0.4, duration: 0.7 },
}: {
  children: ReactNode;
  className?: string;
  y?: number;
  amount?: number;
  transition?: Transition;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}
