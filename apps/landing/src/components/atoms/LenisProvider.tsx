"use client";

import { useEffect } from "react";
import Lenis from "lenis";

/**
 * authored (script_main): referans sitenin kendisi Lenis 1.1.2 çalıştırıyor —
 * `new Lenis({ duration: (prop||10)/10 })` → duration 1, smoothWheel açık,
 * varsayılan easing. Klonda aynı ayar.
 */
export function LenisProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const lenis = new Lenis({ duration: 1 });
    let raf: number;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
  return <>{children}</>;
}
