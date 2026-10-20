"use client";

import { motion } from "framer-motion";
import { useTranslation } from "@demli/i18n";
import { MaskIcon } from "../atoms/MaskIcon";

/** Rozetteki yüzler: yorum yazan ilk beş kişinin baş harfleri, kendi
    gradyanlarımızla — fotoğraf yok. */
const AVATARS = [
  { id: "r1", bg: "linear-gradient(135deg, #ffb08f 0%, #e8624a 100%)" },
  { id: "r2", bg: "linear-gradient(135deg, #f6c177 0%, #c97b2a 100%)" },
  { id: "r3", bg: "linear-gradient(135deg, #9aa7ff 0%, #4b4fb8 100%)" },
  { id: "r4", bg: "linear-gradient(135deg, #8fd3c1 0%, #2f7d6d 100%)" },
  { id: "r5", bg: "linear-gradient(135deg, #d9a1e6 0%, #7d3f96 100%)" },
] as const;

/**
 * Defne kanatlı güven rozeti (Reviews + Footer'da aynı "Reviews Badge") —
 * ölçülen: kanatlar 28×38 ALTIN (#eab30a, Trust token), badge flex gap 24.
 * Orta blok tb+: satır gap 12 (avatarlar 125×44 + 76px sütun) → 317×50;
 * mobil: SÜTUN gap 8 (avatarlar üstte, yıldız/metin altta ortalı) → 229×97.
 * Metin 76px'te iki satıra sarılır; 12px mobil / 14px tb+.
 */
export function TrustBadge() {
  const { t } = useTranslation("landing");
  return (
    <div className="flex items-center gap-6">
      <MaskIcon name="laurel-left" width={28} height={38} color="#eab30a" />
      <div className="flex flex-col items-center gap-2 tb:flex-row tb:gap-3">
        {/* Yığılmış avatarlar: 125×44 kenar paysız; 32px daire,
            23px merkez adımı (bindirme -9px), 2px koyu halka */}
        <div className="flex h-[44px] items-center">
          {AVATARS.map((a, i) => (
            <div
              key={a.id}
              className={
                "h-8 w-8 overflow-hidden rounded-[1000px] " + (i > 0 ? "-ml-[9px]" : "")
              }
            >
              {/* Ölçülen (390 scroll-0): avatarlar y:-16 ön-durumdan kayarak gelir */}
              <motion.div
                initial={{ y: -16 }}
                whileInView={{ y: 0 }}
                viewport={{ amount: 0.5 }}
                transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1 }}
              >
                <span
                  className="flex h-8 w-8 select-none items-center justify-center rounded-[1000px] font-display text-[13px] font-semibold leading-none text-white"
                  style={{ background: a.bg, boxShadow: "rgb(13, 13, 13) 0px 0px 0px 2px" }}
                >
                  {t(`reviews.items.${a.id}.name`).charAt(0)}
                </span>
              </motion.div>
            </div>
          ))}
        </div>
        <div className="flex w-[76px] flex-col items-start gap-1">
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <MaskIcon key={i} name="star" size={12} color="#eab30a" />
            ))}
          </div>
          <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-secondary tb:text-[14px] tb:leading-[16.8px] tb:tracking-[-0.28px]">
            {t("reviews.badge")}
          </p>
        </div>
      </div>
      <MaskIcon name="laurel-right" width={28} height={38} color="#eab30a" />
    </div>
  );
}
