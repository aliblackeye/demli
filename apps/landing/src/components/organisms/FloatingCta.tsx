"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "@demli/i18n";
import { CtaButton } from "../atoms/CtaButton";
import { MaskIcon } from "../atoms/MaskIcon";
import { DOWNLOAD_ANDROID_URL, DOWNLOAD_WINDOWS_URL } from "../../lib/links";

/**
 * Features Section Floating CTA — authored (audit2):
 * fixed bottom 0, left %50 translate(-50%), z10, radius 16,
 * genişlik 1120 (dt) / 810 (tb) / 390 (mobil), padding 12 12 56,
 * bg radial-gradient(50% 100% at 50% 100%, rgba(0,0,0,0.85), saydam),
 * overflow hidden. İçinde beyaz Download App butonu.
 * Davranış (ölçüldü): Features görünürken y 120→0 + op 0→1 spring.
 */
export function FloatingCta() {
  const { t } = useTranslation("landing");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const features = document.querySelector("#features");
    if (!features) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { rootMargin: "-40% 0px -20% 0px" }
    );
    io.observe(features);
    return () => io.disconnect();
  }, []);

  return (
    <motion.div
      className="pointer-events-none fixed bottom-0 left-1/2 z-10 flex w-[390px] -translate-x-1/2 flex-col items-center justify-center gap-2 overflow-hidden rounded-[16px] px-3 pb-14 pt-3 tb:w-[810px] tb:flex-row dt:w-[1120px]"
      style={{
        background:
          "radial-gradient(50% 100% at 50% 100%, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0) 100%)",
        x: "-50%",
      }}
      initial={{ opacity: 0, y: 120 }}
      animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 120 }}
      transition={{ type: "spring", duration: 2, bounce: 0.2 }}
    >
      <div className="pointer-events-auto flex items-center gap-2 [&_a]:!w-auto">
        <CtaButton href={DOWNLOAD_WINDOWS_URL} label={t("floating.cta")} variant="primary" mobileSmall />
        <a href={DOWNLOAD_WINDOWS_URL} aria-label={t("hero.windows")} className="flex h-[57px] w-[57px] items-center justify-center rounded-[12px] bg-surface">
          <MaskIcon name="monitor" size={24} color="#e5e5e5" />
        </a>
        <a href={DOWNLOAD_ANDROID_URL} aria-label={t("hero.android")} className="flex h-[57px] w-[57px] items-center justify-center rounded-[12px] bg-surface">
          <MaskIcon name="phone" size={24} color="#e5e5e5" />
        </a>
      </div>
    </motion.div>
  );
}
