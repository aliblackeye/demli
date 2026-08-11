"use client";

import Image from "next/image";
import { FadeIn } from "../atoms/FadeIn";
import { MaskIcon } from "../atoms/MaskIcon";
import { RevealText } from "../atoms/RevealText";
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
    <div className="relative h-[782px] w-[327px] overflow-hidden rounded-[32px] bg-base tb:h-[1145px] tb:w-[730px] tb:rounded-[44px]">
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
      <div className="relative z-[1] flex w-full flex-col items-start gap-8 px-8 pt-8 tb:px-16 tb:pt-16">
        <div className="flex w-full flex-col items-start gap-4 tb:w-[528px]">
          <FadeIn>
            <ShimmerText
              text={data.tag}
              color="#eab30a"
              className="text-[16px] font-medium leading-[19.2px] text-text-dim"
            />
          </FadeIn>
          <RevealText
            text={data.title}
            mode="word"
            as="h3"
            className="font-display text-[36px] font-normal leading-[39.6px] text-white tb:text-[52px] tb:leading-[57.2px]"
          />
          <RevealText
            text={data.description}
            mode="char"
            as="p"
            className="text-[16px] leading-[22.4px] text-text-dim tb:text-[18px] tb:leading-[25.2px]"
          />
        </div>
        <ul className="flex w-full flex-col gap-3 tb:w-[602px]">
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
      <div className="absolute left-0 top-[453px] z-[1] h-[329px] w-[327px] tb:top-[450px] tb:h-[712px] tb:w-[730px]">
        <Image
          src={data.phoneImage}
          alt={data.title}
          width={730}
          height={712}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
