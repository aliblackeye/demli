import Image from "next/image";
import { MaskIcon } from "../atoms/MaskIcon";

const AVATARS = [
  "/images/avatar-1.jpg",
  "/images/avatar-2.jpg",
  "/images/avatar-3.jpg",
  "/images/avatar-4.jpg",
  "/images/avatar-5.jpg",
];

/**
 * Defne kanatlı güven rozeti (Reviews + Footer'da aynı "Reviews Badge") —
 * ölçülen: kanatlar 28×38 ALTIN (#eab30a, Trust token), badge flex gap 24.
 * Orta blok tb+: satır gap 12 (avatarlar 125×44 + 76px sütun) → 317×50;
 * mobil: SÜTUN gap 8 (avatarlar üstte, yıldız/metin altta ortalı) → 229×97.
 * Metin 76px'te iki satıra sarılır; 12px mobil / 14px tb+.
 */
export function TrustBadge() {
  return (
    <div className="flex items-center gap-6">
      <MaskIcon name="laurel-left" width={28} height={38} color="#eab30a" />
      <div className="flex flex-col items-center gap-2 tb:flex-row tb:gap-3">
        {/* authored Stacked Avatars: 125×44 kenar paysız; 32px görsel,
            23px merkez adımı (bindirme -9px), 2px koyu halka */}
        <div className="flex h-[44px] items-center">
          {AVATARS.map((src, i) => (
            <div
              key={src}
              className={
                "h-8 w-8 overflow-hidden rounded-[1000px] " + (i > 0 ? "-ml-[9px]" : "")
              }
            >
              <Image src={src} alt="" width={32} height={32} className="h-8 w-8 rounded-[1000px] object-cover" style={{ boxShadow: "rgb(13, 13, 13) 0px 0px 0px 2px" }} />
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
            Trusted by 50K+ users
          </p>
        </div>
      </div>
      <MaskIcon name="laurel-right" width={28} height={38} color="#eab30a" />
    </div>
  );
}
