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
        {/* authored Stacked Avatars: 1px sarmalayıcılar + gap 22 → merkez
            adımı 23px; görsel 32px, px-16 kenar payı. */}
        <div className="flex h-[44px] items-center px-4">
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
      <MaskIcon name="laurel-right" size={38} color="#737373" className="h-[38px] w-[28px]" />
    </div>
  );
}
