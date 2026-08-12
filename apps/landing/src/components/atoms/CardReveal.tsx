"use client";

import { motion, type Transition } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * authored scroll-transform (sayfa modülü __framer__styleTransformEffect):
 * spring { damping:60, stiffness:500, mass:1 }, trigger onInView (bir kez),
 * hedefler örn. y250→0 (reviews grid), y200/y400 (pricing), y64 (features).
 */
const AUTHORED_SPRING: Transition = {
  type: "spring",
  damping: 60,
  stiffness: 500,
  mass: 1,
};

function useIsMobile() {
  const [m, setM] = require("react").useState(false);
  require("react").useEffect(() => {
    const mq = window.matchMedia("(max-width: 809.98px)");
    setM(mq.matches);
    const fn = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return m;
}

export function CardReveal({
  children,
  delay = 0,
  y = 64,
  className,
  transition,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  transition?: Transition;
}) {
  const mobil = useIsMobile();
  const ref = useRef<HTMLDivElement | null>(null);
  const [acik, setAcik] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || mobil) return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting) setAcik(true);
        // authored davranış: yalnız öğe viewport'un ALTINDAYSA resetle
        else if (e.boundingClientRect.top > window.innerHeight) setAcik(false);
      }
    }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [mobil]);
  // authored: mobil varyantta styleTransformEffect kapalı
  if (mobil) return <div className={className}>{children}</div>;
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y }}
      animate={acik ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ ...(transition ?? AUTHORED_SPRING), delay }}
    >
      {children}
    </motion.div>
  );
}
