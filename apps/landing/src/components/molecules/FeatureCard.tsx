"use client";

import { useEffect, useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { FadeIn } from "../atoms/FadeIn";
import { LightRays } from "../atoms/LightRays";
import { useIsMobile } from "../atoms/CardReveal";
import { MaskIcon } from "../atoms/MaskIcon";
import { RevealText } from "../atoms/RevealText";
import { ShimmerText } from "../atoms/ShimmerText";
import { PhoneMockup, type ShotName } from "./PhoneMockup";

export type FeatureCardData = {
  tag: string;
  title: string;
  description: string;
  bullets: string[];
  /** Telefonda gösterilecek gerçek ürün ekranı (scripts/gen-landing-shots.mjs). */
  shot: ShotName;
  /** Featured kartta BG'de ışık huzmeleri var; dt'de düzen aynalı. */
  featured?: boolean;
  /** Ölçülen: ref'te telefon içerik akışını izler — kart 3'te metin kısa
      olduğundan telefon 429'da, kart 773 (varsayılan 453/797). */
  mobilePhoneTop?: 453 | 429;
};

/**
 * Features kartı — authored CSS (referans ölçümleri):
 * dt (≥1440): 1120px YATAY düzen; içerik pad 72 0 72 64 (featured aynalı:
 *   72 64 72 0, içerik sağda), başlık/açıklama 528px, telefon flex-1.
 * tb (810–1439): 730px dikey; içerik pad 64 64 0; telefon 450px'te 730×712.
 * mobil (≤809): 342px dikey; içerik pad 32 32 0; telefon 453'te 327×329.
 * Ortak: bg #0d0d0d, radius 44 (mobil 32), nokta ızgarası, grain (screen).
 */
export function FeatureCard({ data }: { data: FeatureCardData }) {
  const kisa = data.mobilePhoneTop === 429;
  // Ölçülen: telefon SCROLL-bağlı yükselir (çift yönlü) — üst kenarı
  // viewport'un 1.272×'inden 0.208×'ine inerken y 250→0, opacity 0→1.
  // Mobilde yok (390 ön-durum envanterinde Phone transformu ölçülmedi).
  // Hesap layout-bazlı (offsetTop zinciri): useScroll(target) kendi
  // transformunu geri besleyip eğriyi kaydırıyordu.
  const telRef = useRef<HTMLDivElement | null>(null);
  const telDocTop = useRef(0);
  const mobil = useIsMobile();
  useEffect(() => {
    const hesapla = () => {
      let el: HTMLElement | null = telRef.current;
      let top = 0;
      while (el) {
        top += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      telDocTop.current = top;
    };
    hesapla();
    const ro = new ResizeObserver(hesapla);
    ro.observe(document.body);
    window.addEventListener("resize", hesapla);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", hesapla);
    };
  }, []);
  const { scrollY } = useScroll();
  const telProg = useTransform(scrollY, (sy) => {
    if (mobil || !telDocTop.current || typeof window === "undefined") return 1;
    // Ölçülen (ref, layout konumuna çözülmüş): layout üstü vh'den
    // 0.209×vh'ye inerken p 0→1 (ref rect'i transform içerdiğinden ham
    // eşikler 1.272/0.208 görünüyordu — layout karşılığı bu)
    const vh = window.innerHeight;
    const ust = telDocTop.current - sy;
    const baslangic = 1.0 * vh;
    const bitis = 0.209 * vh;
    return Math.max(0, Math.min(1, (baslangic - ust) / (baslangic - bitis)));
  });
  const telY = useTransform(telProg, (p) => 250 * (1 - p));
  const telOpacity = telProg;
  return (
    <div
      className={
        "relative w-full max-w-[342px] overflow-hidden rounded-[32px] bg-base " +
        (kisa ? "h-[773px] " : "h-[797px] ") +
        "tb:h-[1145px] tb:w-[730px] tb:max-w-[730px] tb:rounded-[44px] " +
        "dt:flex dt:h-[513px] dt:w-[1120px] dt:max-w-[1120px] dt:items-start " +
        (data.featured ? "dt:flex-row-reverse" : "dt:flex-row")
      }
    >
      {/* BG: tek maskeli ebeveyn (radial 63.4% .32) altında grain
          (op .32, screen, 65% mask) + tam-yuvarlak nokta ızgarası (CSS) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          WebkitMaskImage:
            "radial-gradient(50% 100% at 63.4% 50%, rgba(0, 0, 0, 0.32) 0%, rgba(0, 0, 0, 0) 100%)",
          maskImage:
            "radial-gradient(50% 100% at 63.4% 50%, rgba(0, 0, 0, 0.32) 0%, rgba(0, 0, 0, 0) 100%)",
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.32] mix-blend-screen"
          style={{
            WebkitMaskImage:
              "radial-gradient(65% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
            maskImage:
              "radial-gradient(65% 50%, rgba(0, 0, 0, 0.88) 25.044%, rgba(0, 0, 0, 0) 100%)",
          }}
        >
          <div className="h-full w-full" style={{ backgroundImage: "url(/images/grain.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} />
        </div>
        <div className="dot-grid absolute inset-x-0 top-[2px] h-[99%] overflow-hidden rounded-[100%]" />
      </div>
      {data.featured && (
        /* Huzmeler yalnız tb+ (mobilde sarmalayıcı boş kalır) */
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          {/* Ölçülen: mobil 880×366, tb+ 1708×712 — üst radyal maskla */}
          <div className="absolute left-1/2 top-[-22px] h-[366px] w-[880px] max-w-none -translate-x-1/2 tb:h-[712px] tb:w-[1708px]" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
            <div className="hidden h-full w-full tb:block">
              <LightRays className="h-full w-full opacity-40" />
            </div>
          </div>
        </div>
      )}

      {/* İçerik */}
      <div
        className={
          "relative z-[2] flex w-full flex-col items-start gap-8 px-8 pt-8 " +
          "tb:px-16 tb:pt-16 " +
          // Ölçülen (1440): ref içerik kolonu justify-center (h3 y107)
          "dt:w-auto dt:flex-1 dt:justify-center dt:py-[72px] " +
          (data.featured ? "dt:pl-0 dt:pr-16" : "dt:pl-16 dt:pr-0")
        }
      >
        {/* Ölçülen kademe: başlık kelimeleri ~0.15s'te blur'la başlar,
            tag ~0.6s'te y20 fade, açıklama ~0.7s, maddeler 0.8 */}
        <div className="flex w-full flex-col items-start gap-4 tb:w-[528px]">
          {/* Featured kartın tag'ı vurgu renginde (mercan); mobil 14px */}
          <FadeIn
            amount={0.1}
            transition={{ type: "spring", bounce: 0, delay: 0.6, duration: 0.6 }}
          >
            <ShimmerText
              text={data.tag}
              color="#eab30a"
              className={
                "text-[14px] font-medium leading-[16.8px] tb:text-[16px] tb:leading-[19.2px] " +
                (data.featured ? "text-accent" : "text-text-dim")
              }
            />
          </FadeIn>
          {/* authored h3 preset (1qsvjdb): 52px (tb+) / 40px (mobil), lh 1.1em */}
          <RevealText
            text={data.title}
            mode="word"
            as="h3"
            blurlu
            className="font-display text-[40px] font-normal leading-[44px] text-white tb:text-[52px] tb:leading-[57.2px]"
          />
          {/* Ölçülen: desc mobil 16/24, tb+ 18/25.2 */}
          <FadeIn
            className="w-full"
            amount={0.1}
            transition={{ type: "spring", bounce: 0, delay: 0.7, duration: 0.6 }}
          >
            <RevealText
              text={data.description}
              mode="char"
              as="p"
              className="text-[16px] leading-6 text-text-dim tb:text-[18px] tb:leading-[25.2px]"
            />
          </FadeIn>
        </div>
        {/* authored Benefits: gap 12 (mobil 8); y20 spring {bounce 0, delay .8, dur .6} */}
        <FadeIn
          amount={0.1}
          transition={{ type: "spring", bounce: 0, delay: 0.8, duration: 0.6 }}
          className="w-full tb:w-[602px] dt:w-[528px]"
        >
        <ul className="flex w-full flex-col gap-2 tb:gap-3">
          {data.bullets.map((b) => (
            <li key={b} className="flex h-6 items-center gap-3">
              <MaskIcon name="check-circle" size={24} color="#737373" />
              {/* Ölçülen (390): madde lh 19.6px (140%) */}
              <p className="text-[14px] leading-[19.6px] tracking-[-0.28px] text-text-secondary tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">{b}</p>
            </li>
          ))}
        </ul>
        </FadeIn>
      </div>

      {/* Telefon — alt solma maskı linear-gradient(0deg, saydam 0% → siyah
          56%); tb/mobil mutlak konum, dt: karşı kolonu dolduran akış öğesi.
          Telefon genişliğin %72'si, üstten %12 (yüzde margin genişliğe göre). */}
      <motion.div
        ref={telRef}
        className={
          "absolute left-0 z-[1] h-[344px] w-full overflow-hidden rounded-[32px] " +
          (kisa ? "top-[429px] " : "top-[453px] ") +
          "tb:top-[433px] tb:h-[712px] tb:w-[730px] dt:relative dt:top-0 dt:h-full dt:flex-1 dt:self-stretch"
        }
        style={{
          WebkitMaskImage: "linear-gradient(0deg, rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 56%)",
          maskImage: "linear-gradient(0deg, rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 56%)",
          y: telY,
          opacity: telOpacity,
        }}
      >
        <PhoneMockup shot={data.shot} alt={data.title} className="mx-auto mt-[12%] w-[72%]" />
      </motion.div>
    </div>
  );
}
