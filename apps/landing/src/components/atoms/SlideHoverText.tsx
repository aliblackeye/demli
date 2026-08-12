"use client";

import { motion } from "framer-motion";

/** authored hover geçişi (sayfa modülü): spring { bounce .2, duration .4 } */
export const SLIDE_SPRING = { type: "spring", bounce: 0.2, duration: 0.4 } as const;

export const slideVariants = (mesafe: number) => ({
  rest: { y: 0 },
  hover: { y: -mesafe },
});

/**
 * Nav linklerindeki çift katmanlı kayan hover metni — authored:
 * Content yüksekliği 19px, kopya 23px altta; hover'da spring ile yukarı.
 * Tipografi (X7YAE preset): Inter 500, 16px (tb+) / 14px (mobil).
 * Ebeveyn motion öğesi whileHover="hover" vermelidir (PillLink verir).
 */
export function SlideHoverText({ label }: { label: string }) {
  const textCls =
    "text-[14px] font-medium leading-[1.2] tracking-[-0.02em] text-[#e5e5e5] tb:text-[16px]";
  return (
    <div className="relative flex h-[17px] flex-col items-start overflow-hidden tb:h-[19px]">
      <motion.p
        variants={slideVariants(23)}
        transition={SLIDE_SPRING}
        className="flex flex-col whitespace-pre"
      >
        <strong className={textCls}>{label}</strong>
      </motion.p>
      <motion.p
        aria-hidden
        variants={slideVariants(23)}
        transition={SLIDE_SPRING}
        className="absolute top-[23px] flex flex-col whitespace-pre"
      >
        <strong className={textCls}>{label}</strong>
      </motion.p>
    </div>
  );
}
