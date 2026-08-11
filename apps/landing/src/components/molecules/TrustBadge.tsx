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
 * Defne kanatlı güven rozeti (Reviews + Footer'da aynı) — ölçülen:
 * kanatlar 28×38 #737373, orta blok gap 12: avatar yığını (32px,
 * 22px bindirme, 6px siyah halka) + 5 yıldız (12px) + 76px'te iki
 * satıra sarılan "Trusted by 50K+ users".
 */
export function TrustBadge() {
  return (
    <div className="flex items-center gap-6">
      <MaskIcon name="laurel-left" size={38} color="#737373" className="h-[38px] w-[28px]" />
      <div className="flex items-center gap-3 rounded-[100px]">
        <div className="flex h-[44px] items-center">
          {AVATARS.map((src, i) => (
            <div
              key={src}
              className={
                "box-content h-8 w-8 overflow-hidden rounded-full border-[6px] border-[#000] " +
                (i > 0 ? "-ml-[22px]" : "")
              }
            >
              <Image src={src} alt="" width={32} height={32} className="h-8 w-8 object-cover" />
            </div>
          ))}
        </div>
        <div className="flex w-[76px] flex-col items-start gap-1">
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <MaskIcon key={i} name="star" size={12} color="#eab30a" />
            ))}
          </div>
          <p className="text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-text-secondary">
            Trusted by 50K+ users
          </p>
        </div>
      </div>
      <MaskIcon name="laurel-right" size={38} color="#737373" className="h-[38px] w-[28px]" />
    </div>
  );
}
