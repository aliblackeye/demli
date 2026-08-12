"use client";

import Image from "next/image";
import { motion, useScroll, useTransform } from "framer-motion";
import { Appear, APPEAR } from "../atoms/Appear";
import { useIsMobile } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
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
  // Ölçülen: ref Mockup Wrapper'ı 0.28×scrollY parallax taşır (doğrusal,
  // klampsız, spring'siz — anlık bağ; 3000→840 doğrulandı)
  const { scrollY } = useScroll();
  const mockupParallax = useTransform(scrollY, (v) => v * 0.28);
  // Ölçülen: parıltı salınımı 390'da yok (maxY 0) — yalnız tb+
  const mobil = useIsMobile();
  return (
    <header
      id="hero"
      className="relative flex flex-col items-center overflow-clip px-6 pb-20 pt-[120px] tb:px-0 tb:pb-[120px] tb:pt-[160px] dt:pb-[160px]"
    >
      {/* BG — authored: BG maskı radial 50%/50% (mobil 75%/50%) saydam →
          #00000052; Light Rays Wrapper'ın KENDİ maskı radial 50% 150% at
          50% 0, #000 %82.24 → saydam; noise sarmalayıcı mask radial 65%/50%
          #000000e0 %25 → saydam + mix-blend screen; karo 128px. */}
      <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[600px] flex-col items-center justify-center overflow-clip">
        {/* Ortalamayı motion-DIŞI div taşır: framer-motion inline transform'u
            -translate-x-1/2 sınıfını eziyordu (video sağa kayıyordu). */}
        <div
          className="absolute left-1/2 top-0 h-[392px] w-[720px] max-w-none -translate-x-1/2 tb:h-[500px] tb:w-[1200px]"
          style={{
            WebkitMaskImage:
              "radial-gradient(50% 150% at 50% 0, rgb(0, 0, 0) 82.2354%, rgba(0, 0, 0, 0) 100%)",
            maskImage:
              "radial-gradient(50% 150% at 50% 0, rgb(0, 0, 0) 82.2354%, rgba(0, 0, 0, 0) 100%)",
          }}
        >
        <Appear spec={APPEAR.heroLightRays} className="h-full w-full">
          <Appear spec={APPEAR.heroVideo} className="h-full w-full">
            {/* Referansta video sarmalayıcısı matrix(-1,0,0,-1,0,0) — 180° çevrik */}
            <div className="h-full w-full rotate-180">
              <video
                src="/videos/light-rays-hero.webm"
                autoPlay
                loop
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            </div>
          </Appear>
        </Appear>
        </div>
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
      <div className="relative flex w-full flex-col items-center gap-10 tb:gap-[52px] dt:gap-16">
        {/* Başlık bloğu — authored: max-w 880 (dt) / 604 (tb), gap 32 (mobil 24) */}
        <div className="flex w-full max-w-[604px] flex-col items-center gap-6 tb:gap-8 dt:max-w-[880px]">
          <Appear spec={APPEAR.tagline}>
            <div
              className="flex items-center gap-2 rounded-[50px] bg-[rgba(0,0,0,0.24)] py-[6px] pl-[6px] pr-[18px] backdrop-blur-[8px]"
              style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}
            >
              <div className="flex items-center gap-[10px] rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-1">
                <div className="flex items-center gap-1">
                  <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5] tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">4.9</p>
                  <MaskIcon name="star" size={14} color="#eab30a" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block">
                  <ShimmerText
                    text="Rating"
                    color="#eab30a"
                    className="text-[14px] font-medium leading-[16.8px] text-[#e5e5e5] tb:text-[16px] tb:leading-[19.2px]"
                  />
                </span>
                <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-dim tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
                  Based on 700+ reviews
                </p>
              </div>
            </div>
          </Appear>
          <Appear spec={APPEAR.title} className="w-full" style={{ WebkitMaskImage: "linear-gradient(rgb(0,0,0) 50%, rgba(0,0,0,0.64) 100%)", maskImage: "linear-gradient(rgb(0,0,0) 50%, rgba(0,0,0,0.64) 100%)" }}>
            <h1 className="hero-title w-full text-center font-display font-semibold text-white">
              Clarity Looks Like This
            </h1>
          </Appear>
        </div>

        {/* Alt blok: telefon + CTA — authored Visual: aspect .766667,
            max-w 344 (mobil) / 564 (tb) / 644 (dt); Mockup Wrapper maskı
            linear-gradient(#000 12%, saydam 100%) — kırpma değil solma. */}
        <div className="flex w-full flex-col items-center">
          <div className="relative flex aspect-[0.766667] w-full max-w-[344px] flex-col items-center tb:max-w-[564px] dt:max-w-[644px]">
            {/* Ölçülen (rAF): parıltı scroll'a değil ZAMANA bağlı — tek döngüde
                0→380→0, tam periyot 7017 ms, ease [.44,0,.56,1] */}
            <motion.div
              aria-hidden
              className="absolute inset-y-0 left-[-318px] right-[-318px] rounded-[100%] opacity-[0.48] dt:left-[-398px] dt:right-[-398px]"
              style={{
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
                filter: "blur(8px)",
              }}
              animate={mobil ? { y: 0 } : { y: [0, 380, 0] }}
              transition={mobil ? undefined : { duration: 7.017, ease: [0.44, 0, 0.56, 1], repeat: Infinity, times: [0, 0.5, 1] }}
            />
            <motion.div className="w-full" style={{ y: mockupParallax }}>
              <Appear
                spec={APPEAR.mockup}
                className="w-full"
                style={{
                  WebkitMaskImage: "linear-gradient(rgb(0, 0, 0) 12%, rgba(0, 0, 0, 0) 100%)",
                  maskImage: "linear-gradient(rgb(0, 0, 0) 12%, rgba(0, 0, 0, 0) 100%)",
                }}
              >
                <Image
                  src="/images/hero-phone.webp"
                  alt="Appzen app"
                  width={644}
                  height={1102}
                  priority
                  className="h-auto w-full object-contain"
                />
              </Appear>
            </motion.div>
          </div>

          {/* CTA içeriği */}
          {/* authored CTA Content: max-w 580, gap 64 (dt) / 40 (tb) / 32 (mobil) */}
          <div id="download" className="flex w-full max-w-[580px] flex-col items-center gap-8 tb:gap-10 dt:gap-16">
            <div className="flex flex-col items-center">
              {/* Ölçülen: ikon 80 (mobil) / 120 (tb) / 140 (dt) */}
              <Image
                src="/images/app-icon.png"
                alt=""
                width={140}
                height={140}
                className="h-20 w-20 rounded-none object-cover tb:h-[120px] tb:w-[120px] dt:h-[140px] dt:w-[140px]"
              />
            </div>
            {/* Ölçülen: karakter bazlı bir-kez reveal (görünürken) */}
            <div className="flex flex-col items-center">
              {/* authored whhy8i: 32 (mobil) / 40 (tb) / 44 (dt), lh %120, ls -.02em */}
              <FadeIn y={0} amount={0.2}><p className="whitespace-pre-wrap text-center font-display text-[32px] font-normal leading-[38.4px] tracking-[-0.02em] text-text-primary tb:text-[40px] tb:leading-[48px] dt:text-[44px] dt:leading-[52.8px]"><span>Designed to heal, understand everything </span><span className="text-text-dim">and ship with confidence.</span></p></FadeIn>
            </div>
            <div className="flex w-full flex-col items-center gap-8 tb:w-auto">
              {/* Sarmalayıcı genişliksiz kalınca flex-col ebeveynde büzüşüyordu
                  (butonlar 197px) — ref mobil 342 tam-genişlik */}
              <Appear spec={APPEAR.buttons} className="w-full tb:w-auto">
                {/* authored Buttons: flex-wrap gap 20/16; mobil kolon gap 12 */}
                <div className="flex w-full flex-col items-stretch justify-center gap-3 tb:w-auto tb:flex-row tb:flex-wrap tb:items-center tb:gap-x-4 tb:gap-y-5 [&>a]:w-full tb:[&>a]:w-auto">
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
                  <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-dim tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
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
