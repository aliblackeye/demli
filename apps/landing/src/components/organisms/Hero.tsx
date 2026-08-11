"use client";

import Image from "next/image";
import { Appear, APPEAR } from "../atoms/Appear";
import { CtaButton } from "../atoms/CtaButton";
import { MaskIcon } from "../atoms/MaskIcon";
import { RevealText } from "../atoms/RevealText";
import { ShimmerText } from "../atoms/ShimmerText";

/**
 * [Section] Hero — ölçülen yerleşim (810–1439 arası; ≥1440 değerleri
 * media query ile): kolon, gap 64 (CSS) / ölçülen container gap 52,
 * üst padding 160. BG 600px: ışık huzmesi videosu (1200×500) + noise.
 * Title Wrapper gap 32: Tagline hapı + H1 (92px→112px).
 * Bottom Wrapper: telefon görseli (564×965, 736 görünür) + CTA içeriği.
 */
export function Hero() {
  return (
    <header id="hero" className="relative flex flex-col items-center overflow-clip pb-[120px] pt-[160px]">
      {/* BG: ışık huzmeleri + noise. Ölçülen: BG'de kenar vinyet maskı
          (radial 50%/50%, merkez saydam → kenar 0.32); noise sarmalayıcısı
          mask radial 65%/50% (0.88 @ %25 → 0) + mix-blend screen; karo 128px. */}
      <div
        className="absolute inset-x-0 top-0 flex h-[600px] flex-col items-center justify-center overflow-clip"
        style={{
          WebkitMaskImage:
            "radial-gradient(50% 50%, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.32) 100%)",
          maskImage:
            "radial-gradient(50% 50%, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.32) 100%)",
        }}
      >
        <Appear
          spec={APPEAR.heroLightRays}
          className="absolute left-1/2 top-0 h-[500px] w-[1200px] -translate-x-1/2"
        >
          <Appear spec={APPEAR.heroVideo} className="h-full w-full">
            {/* Referansta video sarmalayıcısı matrix(-1,0,0,-1,0,0) — 180° çevrik */}
            <div className="h-full w-full rotate-180">
              <video
                src="/videos/light-rays-hero.webm"
                autoPlay
                loop
                muted
                playsInline
                className="h-[500px] w-[1200px] object-cover"
              />
            </div>
          </Appear>
        </Appear>
        <div
          aria-hidden
          className="absolute inset-0 z-[1] mix-blend-screen"
          style={{
            WebkitMaskImage:
              "radial-gradient(65% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
            maskImage:
              "radial-gradient(65% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
          }}
        >
          <div
            className="h-full w-full"
            style={{
              backgroundImage: "url(/images/noise.png)",
              backgroundRepeat: "repeat",
              backgroundSize: "128px",
            }}
          />
        </div>
      </div>

      {/* İçerik */}
      <div className="relative flex w-full flex-col items-center gap-[52px]">
        {/* Başlık bloğu */}
        <div className="flex flex-col items-center gap-8">
          <Appear spec={APPEAR.tagline}>
            <div
              className="flex items-center gap-2 rounded-[50px] bg-[rgba(0,0,0,0.24)] py-[6px] pl-[6px] pr-[18px]"
              style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}
            >
              <div className="flex items-center gap-[10px] rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-1">
                <div className="flex items-center gap-1">
                  <p className="text-[16px] leading-[19.2px] tracking-[-0.32px] text-[#e5e5e5]">4.9</p>
                  <MaskIcon name="star" size={14} color="#eab30a" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ShimmerText
                  text="Rating"
                  color="#eab30a"
                  className="text-[16px] font-medium leading-[19.2px] text-[#e5e5e5]"
                />
                <p className="text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-dim">
                  Based on 700+ reviews
                </p>
              </div>
            </div>
          </Appear>
          <Appear spec={APPEAR.title}>
            <h1 className="hero-title mx-auto max-w-[604px] text-center font-display font-semibold text-white min-[1440px]:max-w-[882px]">
              Clarity Looks Like This
            </h1>
          </Appear>
        </div>

        {/* Alt blok: telefon + CTA */}
        <div className="flex w-full flex-col items-center">
          <div className="relative flex flex-col items-center">
            <Appear spec={APPEAR.mockup}>
              <div className="h-[736px] w-[564px] overflow-hidden">
                <Image
                  src="/images/hero-phone.webp"
                  alt="Appzen app"
                  width={564}
                  height={965}
                  priority
                  className="h-[965px] w-[564px] object-contain"
                />
              </div>
            </Appear>
          </div>

          {/* CTA içeriği */}
          <div id="download" className="flex w-[580px] flex-col items-center gap-10">
            <div className="flex flex-col items-center">
              <Image
                src="/images/app-icon.png"
                alt=""
                width={120}
                height={120}
                className="h-[120px] w-[120px] rounded-none object-cover"
              />
            </div>
            {/* Ölçülen: karakter bazlı bir-kez reveal (görünürken) */}
            <div className="flex flex-col items-center">
              <p className="text-center font-display text-[40px] font-normal leading-[48px] tracking-[-0.8px] text-text-primary">
                <RevealText text="Designed to heal, understand everything " mode="char" />
                <RevealText
                  text="and ship with confidence."
                  mode="char"
                  className="text-text-dim"
                />
              </p>
            </div>
            <div className="flex flex-col items-center gap-8">
              <Appear spec={APPEAR.buttons}>
                <div className="flex items-center justify-center gap-x-5 gap-y-4">
                  <CtaButton href="#download" label="Download App" variant="primary" />
                  <CtaButton
                    href="#demo"
                    label="Watch demo"
                    variant="secondary"
                    icon={<MaskIcon name="play" size={24} color="#a3a3a3" />}
                  />
                </div>
              </Appear>
              <div className="flex items-center gap-[10px]">
                <div className="flex items-center gap-[6px]">
                  <MaskIcon name="arrow-circle-down" size={21} color="#737373" />
                  <p className="text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-dim">
                    50K+ downloads
                  </p>
                </div>
                <div className="flex items-center gap-1 rounded-[16px] bg-base p-1">
                  <a
                    href="#appstore"
                    className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"
                  >
                    <MaskIcon name="apple" size={24} color="#e5e5e5" />
                  </a>
                  <a
                    href="#googleplay"
                    className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"
                  >
                    <MaskIcon name="google-play" size={24} color="#e5e5e5" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
