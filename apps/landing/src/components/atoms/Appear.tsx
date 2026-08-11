"use client";

import { motion, type Transition } from "framer-motion";
import type { ReactNode } from "react";

export type AppearSpec = {
  from: { opacity?: number; x?: number; y?: number; scale?: number };
  transition: Transition;
};

/**
 * Referansın appear kayıt defterinden (__framer__appearAnimationsContent)
 * çıkarılan değerlerle bire bir sayfa-yüklenince animasyonu.
 * Spring'ler {type:'spring', bounce, duration}, tween'ler {ease:[...]}.
 */
export function Appear({
  spec,
  children,
  className,
  style,
}: {
  spec: AppearSpec;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0.001, x: 0, y: 0, scale: 1, ...spec.from }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={spec.transition}
    >
      {children}
    </motion.div>
  );
}

/** Appear kayıt defteri — id'ler referanstaki data-framer-appear-id ile aynı. */
export const APPEAR: Record<string, AppearSpec> = {
  // Hero
  heroLightRays: { from: { opacity: 0.001 }, transition: { type: "tween", duration: 2.5, delay: 1, ease: [0.12, 0.23, 0.5, 1] } }, // 1j3h5kb
  heroVideo: { from: { opacity: 0.001, y: -350 }, transition: { type: "tween", duration: 2, delay: 1, ease: [0.1, 0.59, 0.5, 1] } }, // 10y1739
  tagline: { from: { opacity: 0.001, y: 20 }, transition: { type: "spring", duration: 0.7, delay: 1.4, bounce: 0.2 } }, // zlsn0h
  title: { from: { opacity: 0.001, y: -44, scale: 1.3 }, transition: { type: "spring", duration: 4, delay: 0.8, bounce: 0.4 } }, // 104ds94
  mockup: { from: { opacity: 0.001, y: 120 }, transition: { type: "spring", duration: 1.8, delay: 0.6, bounce: 0.4 } }, // 1wcalc7
  buttons: { from: { opacity: 0.001, y: 20 }, transition: { type: "spring", duration: 0.6, delay: 0.4, bounce: 0 } }, // 16uhrn6 / ss0937
  // Bölüm videoları (görünürken)
  sectionVideo: { from: { opacity: 0.001 }, transition: { type: "tween", duration: 0.4, delay: 0, ease: [0.44, 0, 0.56, 1] } }, // huez5z/qw1lfp/199dp89/1ce75jz
  sectionLightRays: { from: { opacity: 0.001 }, transition: { type: "tween", duration: 2.5, delay: 1, ease: [0.12, 0.23, 0.5, 1] } }, // 1tgb26y/1l4gf9m
  floatingCta: { from: { opacity: 0.001, y: 4 }, transition: { type: "spring", duration: 0.6, delay: 3, bounce: 0.2 } }, // 1d66xvy
  footerVideo: { from: { opacity: 0.001 }, transition: { type: "tween", duration: 2, delay: 1, ease: [0.1, 0.59, 0.5, 1] } }, // 13159a5
};
