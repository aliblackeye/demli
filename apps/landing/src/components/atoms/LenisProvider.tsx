"use client";

import { useEffect } from "react";
import Lenis from "lenis";

/**
 * Founder kararı (2026-08-11): Lenis kurulu ama NÖTR — referans native
 * scroll kullandığı için smoothing kapalı tutulur; sadece anchor scroll
 * gibi ihtiyaçlar için altyapı hazır durur.
 */
export function LenisProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const lenis = new Lenis({
      // Nötr ayar: yumuşatma devre dışı — native davranışla birebir.
      smoothWheel: false,
      syncTouch: false,
    });
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
