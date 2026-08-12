"use client";

import { motion, type Transition } from "framer-motion";
import { useEffect, useState } from "react";
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
  
  // authored: mobil varyantta styleTransformEffect kapalı
  if (mobil) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.05 }}
      transition={{ ...(transition ?? AUTHORED_SPRING), delay }}
    >
      {children}
    </motion.div>
  );
}
