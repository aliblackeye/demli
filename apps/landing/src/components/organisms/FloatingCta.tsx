"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CtaButton } from "../atoms/CtaButton";

/**
 * Features Section Floating CTA — ölçülen davranış: fixed bottom (z10),
 * Features bölümü görünürken y 120→0 + opacity 0→1; bölümden çıkınca
 * geri iner. İçerik: beyaz "Download App" butonu (191×57).
 * Referans eğrisi: 2500 → op .92/y 10 (giriş ortası), 4500 → tam açık,
 * 5500 → op .08/y 110 (çıkış ortası).
 */
export function FloatingCta() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const features = document.querySelector("#features");
    if (!features) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      // Bölüm viewport'un ortasına yakınken tetiklenmesi için pay
      { rootMargin: "-40% 0px -20% 0px" }
    );
    io.observe(features);
    return () => io.disconnect();
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex items-end justify-center pb-[43px]">
      <motion.div
        className="pointer-events-auto"
        initial={{ opacity: 0, y: 120 }}
        animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 120 }}
        transition={{ type: "spring", duration: 0.6, bounce: 0.2 }}
      >
        <CtaButton href="#download" label="Download App" variant="primary" />
      </motion.div>
    </div>
  );
}
