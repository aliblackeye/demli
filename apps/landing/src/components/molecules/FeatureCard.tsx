"use client";

import { VideoBg } from "../atoms/VideoBg";
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
  /** Featured kartta BG'de ışık huzmesi videosu var; dt'de düzen aynalı. */
  featured?: boolean;
};

/**
 * Features kartı — authored CSS (audit2 + framer-IV7QC kuralları):
 * dt (≥1440): 1120px YATAY düzen; içerik pad 72 0 72 64 (featured aynalı:
 *   72 64 72 0, içerik sağda), başlık/açıklama 528px, telefon flex-1.
 * tb (810–1439): 730px dikey; içerik pad 64 64 0; telefon 450px'te 730×712.
 * mobil (≤809): 342px dikey; içerik pad 32 32 0; telefon 453'te 327×329.
 * Ortak: bg #0d0d0d, radius 44 (mobil 32), dots figürü, noise (screen).
 */
export function FeatureCard({ data }: { data: FeatureCardData }) {
  return (
    <div
      className={
        "relative h-[782px] w-full max-w-[342px] overflow-hidden rounded-[32px] bg-base " +
        "tb:h-[1145px] tb:w-[730px] tb:max-w-[730px] tb:rounded-[44px] " +
        "dt:flex dt:h-[513px] dt:w-[1120px] dt:max-w-[1120px] dt:items-start " +
        (data.featured ? "dt:flex-row-reverse" : "dt:flex-row")
      }
    >
      {/* Dekor: dot-frame + noise (+ featured'da ışık huzmesi).
          authored dots maskı: radial 50% 100% at 63.4% 50%, 0.32 → 0 */}
      <figure
        className="pointer-events-none absolute inset-x-0 top-[2px] h-[99%] overflow-hidden rounded-[inherit]"
        style={{
          WebkitMaskImage:
            "radial-gradient(50% 100% at 63.4% 50%, rgba(0, 0, 0, 0.32) 0%, rgba(0, 0, 0, 0) 100%)",
          maskImage:
            "radial-gradient(50% 100% at 63.4% 50%, rgba(0, 0, 0, 0.32) 0%, rgba(0, 0, 0, 0) 100%)",
        }}
      >
        <Image src="/images/screen-frame.webp" alt="" fill className="object-cover" sizes="1120px" />
      </figure>
      {data.featured && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          <div className="absolute left-1/2 top-[-22px] h-[712px] w-[1708px] -translate-x-1/2 rotate-180">
            <VideoBg src="/videos/light-rays.webm" className="h-full w-full object-cover opacity-40" />
          </div>
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] opacity-[0.32] mix-blend-screen"
        style={{
          backgroundImage: "url(/images/noise.png)",
          backgroundRepeat: "repeat",
          backgroundSize: "128px",
          WebkitMaskImage:
            "radial-gradient(65% 50% at 50% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
          maskImage:
            "radial-gradient(65% 50% at 50% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
        }}
      />

      {/* İçerik */}
      <div
        className={
          "relative z-[2] flex w-full flex-col items-start gap-8 px-8 pt-8 " +
          "tb:px-16 tb:pt-16 " +
          "dt:w-auto dt:flex-1 dt:py-[72px] " +
          (data.featured ? "dt:pl-0 dt:pr-16" : "dt:pl-16 dt:pr-0")
        }
      >
        {/* authored: Details bloğu y20 spring {bounce 0, delay .7, dur .6} */}
        <FadeIn
          className="flex w-full flex-col items-start gap-4 tb:w-[528px]"
          amount={0.1}
          transition={{ type: "spring", bounce: 0, delay: 0.7, duration: 0.6 }}
        >
          {/* Fark motoru: featured kartın tag'ı YEŞİL (#22c55e); mobil 14px */}
          <ShimmerText
            text={data.tag}
            color="#eab30a"
            className={
              "text-[14px] font-medium leading-[16.8px] tb:text-[16px] tb:leading-[19.2px] " +
              (data.featured ? "text-accent" : "text-text-dim")
            }
          />
          {/* authored h3 preset (1qsvjdb): 52px (tb+) / 40px (mobil), lh 1.1em */}
          <RevealText
            text={data.title}
            mode="word"
            as="h3"
            className="font-display text-[40px] font-normal leading-[44px] text-white tb:text-[52px] tb:leading-[57.2px]"
          />
          <RevealText
            text={data.description}
            mode="char"
            as="p"
            className="text-[16px] leading-[22.4px] text-text-dim tb:text-[18px] tb:leading-[25.2px]"
          />
        </FadeIn>
        {/* authored Benefits: gap 12 (mobil 8); y20 spring {bounce 0, delay .8, dur .6} */}
        <FadeIn
          amount={0.1}
          transition={{ type: "spring", bounce: 0, delay: 0.8, duration: 0.6 }}
          className="w-full tb:w-[602px] dt:w-[528px]"
        >
        <ul className="flex w-full flex-col gap-2 tb:gap-3">
          {data.bullets.map((b) => (
            <li key={b} className="flex h-6 items-center gap-3">
              <MaskIcon name="check-circle" size={20} color="#22c55e" />
              <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-secondary tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">{b}</p>
            </li>
          ))}
        </ul>
        </FadeIn>
      </div>

      {/* Telefon görseli — authored: alt solma maskı linear-gradient(0deg,
          saydam 0% → siyah 56%) + saturate(1.4); tb/mobil mutlak konum,
          dt: karşı kolonu dolduran akış öğesi. */}
      <div
        className="absolute left-0 top-[453px] z-[1] h-[329px] w-full tb:top-[450px] tb:h-[712px] tb:w-[730px] dt:relative dt:top-0 dt:h-full dt:flex-1 dt:self-stretch"
        style={{
          WebkitMaskImage: "linear-gradient(0deg, rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 56%)",
          maskImage: "linear-gradient(0deg, rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 56%)",
          filter: "saturate(1.4)",
        }}
      >
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
