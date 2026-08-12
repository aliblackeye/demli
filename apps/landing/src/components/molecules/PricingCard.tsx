"use client";

import { VideoBg } from "../atoms/VideoBg";
import Image from "next/image";
import { CtaButton } from "../atoms/CtaButton";
import { MaskIcon } from "../atoms/MaskIcon";
import { ShimmerText } from "../atoms/ShimmerText";

export type PricingCardData = {
  plan: string;
  price: string;
  priceSuffix?: string;
  description: string;
  ctaLabel: string;
  ctaVariant: "primary" | "secondary";
  features: string[];
  featured?: boolean;
};

/**
 * Fiyat kartı — ölçülen: 404×499, bg rgba(23,23,23,0.72), radius 32, pad 16.
 * Top Content 372×293: bg #171717 radius 24, dots figürü, pad 24, kolon gap 32
 * [plan satırı, fiyat(40px Stack Sans)+açıklama(gap 18), CTA 57px].
 * Bottom: 4 maddelik liste (24px ikon, gap 10).
 */
export function PricingCard({ data }: { data: PricingCardData }) {
  return (
    // authored: gap 16, padding 16 16 24, radius 32, bg #171717b8
    <div className="relative flex w-full max-w-[327px] flex-col gap-4 overflow-hidden rounded-[32px] bg-[rgba(23,23,23,0.72)] p-4 pb-6 tb:w-[404px] tb:max-w-none">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.32] mix-blend-screen" style={{ WebkitMaskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)" }}><div className="h-full w-full" style={{ backgroundImage: "url(/images/noise.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} /></div>
      <div className={"relative overflow-hidden rounded-[24px] " + (data.featured ? "bg-base backdrop-blur-[10px]" : "bg-surface")}>
        <div className="pointer-events-none absolute inset-0" style={{ WebkitMaskImage: "radial-gradient(100% 86% at 19.3% 33.5%, rgba(0,0,0,0.8) 50.637%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(100% 86% at 19.3% 33.5%, rgba(0,0,0,0.8) 50.637%, rgba(0,0,0,0) 100%)" }}><figure className="absolute inset-0 overflow-hidden rounded-[100%]"><Image src="/images/screen-frame.webp" alt="" fill className="object-cover" sizes="372px" /></figure></div>
        {data.featured && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
            <div className="absolute left-1/2 top-[-22px] h-[712px] w-[1708px] -translate-x-1/2 rotate-180">
              <VideoBg src="/videos/light-rays.webm" className="h-full w-full object-cover opacity-40" />
            </div>
          </div>
        )}
        
        <div className="relative z-[1] flex flex-col gap-8 p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-[14px]">
              <ShimmerText
                text={data.plan}
                color="#eab30a"
                className={"text-[16px] font-medium leading-[19.2px] " + (data.featured ? "text-accent" : "text-text-dim")}
              />
            </div>
          </div>
          <div className="flex flex-col items-start gap-[18px]">
            <div className="flex items-end gap-[6px]">
              {/* Fark motoru: fiyat mobil 32px; /month rengi #e5e5e5, mobil 14px */}
              <span className="font-display text-[32px] font-normal leading-[38.4px] tracking-[-0.64px] text-text-primary tb:text-[40px] tb:leading-[48px] tb:tracking-[-0.8px] dt:text-[44px] dt:leading-[52.8px] dt:tracking-[-0.88px]">
                {data.price}
              </span>
              {data.priceSuffix ? (
                <span className="pb-[6px] text-[14px] leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5] tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
                  {data.priceSuffix}
                </span>
              ) : null}
            </div>
            <p className="w-full text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-secondary tb:w-[324px]">
              {data.description}
            </p>
          </div>
          <div className="flex w-full flex-col tb:w-[324px] [&>a]:w-full">
            <CtaButton href="#download" label={data.ctaLabel} variant={data.ctaVariant} />
          </div>
        </div>
      </div>
      {/* authored Bottom Content: padding 12, Features ul gap 10 */}
      <ul className="flex flex-col gap-[10px] p-3">
        {data.features.map((f, i) => (
          <li key={f + i} className="flex h-6 items-center gap-[10px]">
            <MaskIcon name="check-circle" size={24} color="#737373" />
            <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-secondary tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">{f}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
