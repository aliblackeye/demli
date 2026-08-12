"use client";

import { motion, type Transition } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Görünürken oynayan giriş (referans giriş animasyonundan ölçüldü).
 * Varsayılan: y20 + spring {bounce .2, delay .4, duration .7} — bölüm
 * tagline'larının authored konfigürasyonu (threshold .5).
 * Founder kararı: reveal'ler ÇİFT YÖNLÜ (ref'ten bilinçli sapma) —
 * görünümden çıkınca gecikmesiz geri sarar, tekrar girince yeniden oynar.
 */
export function FadeIn({
  children,
  className,
  y = 20,
  amount = 0.3,
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
      initial="gizli"
      whileInView="acik"
      variants={{
        gizli: { opacity: 0, y, transition: { ...transition, delay: 0 } },
        acik: { opacity: 1, y: 0, transition },
      }}
      viewport={{ amount }}
    >
      {children}
    </motion.div>
  );
}
