"use client";

import Image from "next/image";
import { MaskIcon } from "../atoms/MaskIcon";
import { ShimmerText } from "../atoms/ShimmerText";

export type FeatureCardData = {
  tag: string;
  title: string;
  description: string;
  bullets: string[];
  phoneImage: string;
};

/**
 * Features kartı — ölçülen: 730×1145, bg #0d0d0d, radius 44,
 * dot-frame figürü (730×1134, cover) + noise 0.32, içerik pad 64/64/0,
 * başlık Stack Sans 400 52px/57.2, açıklama Inter 18px #737373,
 * madde satırları 602×24 + check ikonu, telefon görseli altta 730×712.
 */
export function FeatureCard({ data }: { data: FeatureCardData }) {
  return (
    <div className="relative h-[1145px] w-[730px] overflow-hidden rounded-[44px] bg-base">
      {/* Dekor: dot-frame + noise */}
      <figure className="pointer-events-none absolute inset-x-0 top-[2px] h-[1134px] overflow-hidden rounded-[44px]">
        <Image
          src="/images/screen-frame.webp"
          alt=""
          fill
          className="object-cover"
          sizes="730px"
        />
      </figure>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: "url(/images/noise.png)",
          backgroundRepeat: "repeat",
          backgroundSize: "128px",
        }}
      />

      {/* İçerik */}
      <div className="relative z-[1] flex w-full flex-col items-start gap-8 px-16 pt-16">
        <div className="flex w-[528px] flex-col items-start gap-4">
          <ShimmerText
            text={data.tag}
            color="#eab30a"
            className="text-[16px] font-medium leading-[19.2px] text-text-dim"
          />
          <h3 className="font-display text-[52px] font-normal leading-[57.2px] text-white">
            {data.title}
          </h3>
          <p className="text-[18px] leading-[25.2px] text-text-dim">{data.description}</p>
        </div>
        <ul className="flex w-[602px] flex-col gap-3">
          {data.bullets.map((b) => (
            <li key={b} className="flex h-6 items-center gap-3">
              <MaskIcon name="check-circle" size={20} color="#22c55e" />
              <p className="text-[16px] leading-[19.2px] tracking-[-0.32px] text-[#e5e5e5]">{b}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Telefon görseli — ölçülen: kart üstünden 450px, 730×712,
          kartın altından 17px taşar (overflow ile kırpılır). */}
      <div className="absolute left-0 top-[450px] z-[1] h-[712px] w-[730px]">
        <Image
          src={data.phoneImage}
          alt={data.title}
          width={730}
          height={712}
          className="h-[712px] w-[730px] object-cover"
        />
      </div>
    </div>
  );
}
