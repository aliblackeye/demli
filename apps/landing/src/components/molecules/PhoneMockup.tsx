"use client";

import Image from "next/image";
import { useTranslation } from "@demli/i18n";

export type ShotName = "hero" | "voice" | "screen" | "table";

/** Kademeli bulanıklık katmanları (alt kısım): blur px, mask başlangıç/bitiş %. */
const SOFT_LAYERS: Array<[number, number, number]> = [
  [1, 0, 22],
  [2, 12, 36],
  [4, 26, 52],
  [8, 42, 70],
  [14, 58, 100],
];

/**
 * A phone drawn in CSS around a REAL Demli screenshot.
 *
 * The screen content is a headless capture of the shipping product
 * (scripts/gen-landing-shots.mjs → public/images/shots/<shot>-<tr|en>.webp,
 * 390×844 @2x); the bezel, side keys, camera punch-hole and status bar are
 * this component. The picture follows the page language.
 *
 * Every measure is in `cqw` of the phone's own width (it is a size container),
 * so one component scales from the 246px mobile feature card to the ~500px
 * hero without per-breakpoint numbers.
 */
export function PhoneMockup({
  shot,
  alt,
  priority = false,
  softFrom,
  className = "",
}: {
  shot: ShotName;
  alt: string;
  priority?: boolean;
  /** Ekranın bu yüzdesinden aşağısı kademeli bulanıp kararır (hero: telefonun
      alt yarısı başlık metninin arkasına girer, okunur kalmalı). */
  softFrom?: number;
  className?: string;
}) {
  const { i18n } = useTranslation("landing");
  const lng = (i18n.resolvedLanguage ?? i18n.language ?? "tr").startsWith("tr") ? "tr" : "en";
  return (
    <div className={`relative [container-type:inline-size] ${className}`}>
      <div
        className="relative rounded-[15cqw] bg-[#141414] p-[2.4cqw]"
        style={{
          boxShadow:
            "inset 0 0 0 0.35cqw rgba(255,255,255,0.10), inset 0 0.6cqw 0.8cqw rgba(255,255,255,0.05), 0 6cqw 14cqw -4cqw rgba(0,0,0,0.85)",
        }}
      >
        {/* Yan tuşlar */}
        <span aria-hidden className="absolute left-[-0.7cqw] top-[19%] h-[7%] w-[0.9cqw] rounded-l-[1cqw] bg-[#1d1d1d]" />
        <span aria-hidden className="absolute right-[-0.7cqw] top-[16%] h-[5%] w-[0.9cqw] rounded-r-[1cqw] bg-[#1d1d1d]" />
        <span aria-hidden className="absolute right-[-0.7cqw] top-[23%] h-[11%] w-[0.9cqw] rounded-r-[1cqw] bg-[#1d1d1d]" />
        <div className="relative overflow-hidden rounded-[12.8cqw] bg-black">
          {/* Durum çubuğu — ürün ekranı bunun altında başlar */}
          <div
            aria-hidden
            className="relative flex h-[10cqw] items-center justify-between px-[8cqw] pt-[1cqw] font-sans text-[3.7cqw] font-semibold tracking-[-0.01em] text-white"
          >
            <span>21:40</span>
            <span className="absolute left-1/2 top-[2.6cqw] h-[4.4cqw] w-[4.4cqw] -translate-x-1/2 rounded-full bg-[#0b0b0b] shadow-[inset_0_0_0_0.5cqw_#1a1a1a]" />
            <span className="flex items-end gap-[0.6cqw]">
              <span className="block h-[1.2cqw] w-[0.9cqw] rounded-[0.3cqw] bg-white" />
              <span className="block h-[1.8cqw] w-[0.9cqw] rounded-[0.3cqw] bg-white" />
              <span className="block h-[2.4cqw] w-[0.9cqw] rounded-[0.3cqw] bg-white" />
              <span className="block h-[3cqw] w-[0.9cqw] rounded-[0.3cqw] bg-white/40" />
              <span className="relative ml-[1.4cqw] block h-[3cqw] w-[6cqw] rounded-[0.9cqw] border-[0.3cqw] border-white/45 p-[0.4cqw]">
                <span className="block h-full w-[72%] rounded-[0.4cqw] bg-white" />
              </span>
            </span>
          </div>
          <Image
            src={`/images/shots/${shot}-${lng}.webp`}
            alt={alt}
            width={780}
            height={1688}
            priority={priority}
            className="block h-auto w-full"
          />
          {softFrom !== undefined && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0" style={{ top: `${softFrom}%` }}>
              {SOFT_LAYERS.map(([blur, from, to]) => (
                <div
                  key={blur}
                  className="absolute inset-0"
                  style={{
                    backdropFilter: `blur(${blur}px)`,
                    WebkitBackdropFilter: `blur(${blur}px)`,
                    WebkitMaskImage: `linear-gradient(rgba(0,0,0,0) ${from}%, #000 ${to}%)`,
                    maskImage: `linear-gradient(rgba(0,0,0,0) ${from}%, #000 ${to}%)`,
                  }}
                />
              ))}
              <div className="absolute inset-0 bg-gradient-to-b from-black/0 via-black/40 to-black/80" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
