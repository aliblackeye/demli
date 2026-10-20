"use client";

import { useTranslation } from "@demli/i18n";
import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { LightRays } from "../atoms/LightRays";
import { FeatureCard, type FeatureCardData } from "../molecules/FeatureCard";
import { SectionTagline } from "../molecules/SectionTagline";

/**
 * [Section] Features — authored: section padding 160 0 (dt) / 120 40 (tb) /
 * 80 24 (mobil); Container gap 80; kartlar gap 24 (mobil 16).
 * BG şeridi 467px (CSS ışık huzmeleri + grain 0.72 + mercan daire).
 */
export function Features() {
  const { t } = useTranslation("landing");
  const CARDS: FeatureCardData[] = (["voice", "screen", "table"] as const).map((k) => ({
    tag: t(`features.cards.${k}.tag`),
    title: t(`features.cards.${k}.title`),
    description: t(`features.cards.${k}.desc`),
    bullets: [t(`features.cards.${k}.b1`), t(`features.cards.${k}.b2`), t(`features.cards.${k}.b3`)],
    shot: k,
  }));
  return (
    <section
      id="features"
      className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:px-0 dt:py-[160px]"
    >
      {/* BG şeridi */}
      <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[300px] items-center justify-center overflow-clip tb:h-[467px]">
        <div
          aria-hidden
          className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-[100%] tb:left-[-155px] tb:right-[-155px] dt:left-[-398px] dt:right-[-398px]"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(255, 132, 100, 0.24) 0%, rgba(255, 132, 100, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="flex h-full w-full items-center justify-center">
          <div style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
          <LightRays className="h-[300px] w-[720px] max-w-none tb:h-[467px] tb:w-[1120px]" />
          </div>
        </div>
        <div
          aria-hidden
          className="absolute inset-0 z-[1] opacity-70 mix-blend-screen backdrop-blur-[2px]"
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
              backgroundImage: "url(/images/grain.png)",
              backgroundRepeat: "repeat",
              backgroundSize: "128px",
            }}
          />
        </div>
      </div>

      {/* İçerik — Ölçülen (390): container gap 40, başlık bloğu gap 24 */}
      <div className="relative flex w-full flex-col items-center gap-10 tb:gap-20">
        <div className="flex flex-col items-center gap-6 tb:gap-8">
          <FadeIn>
            <SectionTagline label="Features" />
          </FadeIn>
          {/* authored: başlık BLOK olarak açılır — spring {bounce .3, dur 3}, threshold .5 */}
          <FadeIn y={0} amount={0.5} transition={{ type: "spring", bounce: 0.3, duration: 3 }}>
            <h2 className="whitespace-pre-wrap text-center font-display text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px] dt:text-[56px] dt:leading-[61.6px]">
              {/* Yapı korunur: mobilde <br> yok (doğal sarım), tb+ iki satır */}
              <span className="tb:hidden"><span className="text-white">{t("features.headingLight")} </span><span className="text-text-dim">{t("features.headingDim")}</span></span><span className="hidden tb:inline"><span className="text-white">{t("features.headingLight")}</span><br /><span className="text-text-dim">{t("features.headingDim")}</span></span>
            </h2>
          </FadeIn>
        </div>
        {/* authored Features Cards: gap 24 (mobil 16); kart girişi
            y64 + spring {bounce 0, delay .45, duration .6} */}
        <div className="flex w-full flex-col items-center gap-4 tb:gap-6">
          {CARDS.map((card, i) => (
            <CardReveal
              key={card.tag}
              y={64}
              transition={{ type: "spring", bounce: 0, delay: 0.45, duration: 0.6 }}
            >
              {/* Demli metinlerinde üç kartın içerik boyu dengeli — tek konum */}
              <FeatureCard data={{ ...card, featured: i === 1 }} />
            </CardReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
