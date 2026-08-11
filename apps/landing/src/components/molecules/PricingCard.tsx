"use client";

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
    <div className="flex w-full max-w-[327px] flex-col gap-4 rounded-[32px] bg-[rgba(23,23,23,0.72)] p-4 tb:w-[404px] tb:max-w-none">
      <div className="relative overflow-hidden rounded-[24px] bg-surface">
        <figure className="pointer-events-none absolute inset-0">
          <Image src="/images/screen-frame.webp" alt="" fill className="object-cover" sizes="372px" />
        </figure>
        {data.featured && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute left-1/2 top-[-22px] h-[712px] w-[1708px] -translate-x-1/2 rotate-180">
              <video
                src="/videos/light-rays.webm"
                autoPlay
                loop
                muted
                playsInline
                className="h-full w-full object-cover opacity-40"
              />
            </div>
          </div>
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage: "url(/images/noise.png)",
            backgroundRepeat: "repeat",
            backgroundSize: "128px",
          }}
        />
        <div className="relative z-[1] flex flex-col gap-8 p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-[14px]">
              <ShimmerText
                text={data.plan}
                color="#eab30a"
                className="text-[16px] font-medium leading-[19.2px] text-text-dim"
              />
            </div>
          </div>
          <div className="flex flex-col items-start gap-[18px]">
            <div className="flex items-end gap-[6px]">
              <span className="font-display text-[40px] font-normal leading-[48px] tracking-[-0.8px] text-text-primary">
                {data.price}
              </span>
              {data.priceSuffix ? (
                <span className="pb-[6px] text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-dim">
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
      <ul className="flex flex-col gap-[10px] px-3 pb-5 pt-3">
        {data.features.map((f, i) => (
          <li key={f + i} className="flex h-6 items-center gap-[10px]">
            <MaskIcon name="check-circle" size={24} color="#737373" />
            <p className="text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-secondary">{f}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
