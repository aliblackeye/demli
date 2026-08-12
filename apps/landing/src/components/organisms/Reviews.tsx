"use client";

import { VideoBg } from "../atoms/VideoBg";
import { useTranslation, type TFunction } from "@demli/i18n";
import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { ReviewCard, type ReviewCardData } from "../molecules/ReviewCard";
import { TrustBadge } from "../molecules/TrustBadge";
import { DOWNLOAD_ANDROID_URL, DOWNLOAD_WINDOWS_URL } from "../../lib/links";

/* Yorumlar katalogdan gelir (r1..r9); ikon = platform (monitor/phone). */
type LandingT = TFunction<"landing">;
type YorumId = "r1" | "r2" | "r3" | "r4" | "r5" | "r6" | "r7" | "r8" | "r9";

const yorum = (t: LandingT, id: YorumId, store: string, href: string): ReviewCardData => ({
  store,
  href,
  name: t(`reviews.items.${id}.name`),
  date: t(`reviews.items.${id}.date`),
  title: t(`reviews.items.${id}.title`),
  body: t(`reviews.items.${id}.body`),
});

function yorumlar(t: LandingT) {
  const W = DOWNLOAD_WINDOWS_URL;
  const A = DOWNLOAD_ANDROID_URL;
  const hepsi: Record<string, ReviewCardData> = {
    r1: yorum(t, "r1", "monitor", W),
    r2: yorum(t, "r2", "monitor", W),
    r3: yorum(t, "r3", "phone", A),
    r4: yorum(t, "r4", "monitor", W),
    r5: yorum(t, "r5", "phone", A),
    r6: yorum(t, "r6", "monitor", W),
    r7: yorum(t, "r7", "phone", A),
    r8: yorum(t, "r8", "monitor", W),
    r9: yorum(t, "r9", "phone", A),
  };
  return {
    /* Tablet: iki kolon 5+4 (yapı korunur) */
    COL_1: [hepsi.r1, hepsi.r3, hepsi.r5, hepsi.r7, hepsi.r9],
    COL_2: [hepsi.r2, hepsi.r4, hepsi.r6, hepsi.r8],
    /* Mobil: ilk 6 */
    MOBILE_ITEMS: [hepsi.r1, hepsi.r2, hepsi.r3, hepsi.r4, hepsi.r5, hepsi.r6],
    /* Geniş ekran: üç kolon 3+3+3 */
    DT_COLS: [
      [hepsi.r1, hepsi.r4, hepsi.r7],
      [hepsi.r2, hepsi.r5, hepsi.r8],
      [hepsi.r3, hepsi.r6, hepsi.r9],
    ],
  };
}

/**
 * [Section] Reviews — ölçülen: BG şeridi 467 (Features ile aynı reçete),
 * Container pt 120 / gap 80; Title: rozet (defne kanatları + avatar yığını
 * + 5 yıldız + "Trusted by 50K+ users") + 48px iki tonlu başlık;
 * Content 1357 yüksek, 2 kolon 406px gap 12, kolon içi gap 12,
 * kolon başı 83px ofset, taşan kısım kırpılır.
 */
export function Reviews() {
  const { t } = useTranslation("landing");
  const { COL_1, COL_2, MOBILE_ITEMS, DT_COLS } = yorumlar(t);
  return (
    <section
      id="reviews"
      className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:px-0 dt:py-[160px]"
    >
      {/* BG şeridi */}
      <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[300px] items-center justify-center overflow-clip tb:h-[467px]">
        <div
          aria-hidden
          className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-[100%] tb:left-[-155px] tb:right-[-155px] dt:left-[-398px] dt:right-[-398px]"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="rotate-180" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
          <VideoBg src="/videos/light-rays.webm" className="h-[300px] w-[720px] max-w-none object-cover tb:h-[467px] tb:w-[1120px]" />
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
              backgroundImage: "url(/images/noise.png)",
              backgroundRepeat: "repeat",
              backgroundSize: "128px",
            }}
          />
        </div>
      </div>

      {/* İçerik */}
      {/* Ölçülen (390): container gap 40, başlık bloğu gap 24 */}
      <div className="relative flex w-full flex-col items-center gap-10 tb:gap-20">
        <div className="flex flex-col items-center gap-6 tb:gap-8">
          <FadeIn>
            <TrustBadge />
          </FadeIn>
          {/* authored: BLOK açılım spring {bounce .3, dur 3}, threshold .5;
              mobil varyantta metin farklı ("Here from other users have to say") */}
          <FadeIn y={0} amount={0.5} transition={{ type: "spring", bounce: 0.3, duration: 3 }}>
            <h2 className="whitespace-pre-wrap text-center font-display text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px] dt:text-[56px] dt:leading-[61.6px]">
              <span className="tb:hidden">
                <span className="text-white">{t("reviews.headingLight")} </span>
                <span className="text-text-dim">{t("reviews.headingDim")}</span>
              </span>
              <span className="hidden tb:inline">
                <span className="text-white">{t("reviews.headingLight")}</span>
                <br />
                <span className="text-text-dim">{t("reviews.headingDim")}</span>
              </span>
            </h2>
          </FadeIn>
        </div>

        {/* authored: column-masonry grid, trackCount 3 (dt) / 2 (tb) / 1 (mobil),
            rowGap 12; TÜM grid onInView y250→0 spring (damping60/stiffness500). */}
        <CardReveal y={250} className="w-full">
          {/* Ölçülen sıralar (ref): mobil = C1/C2 serpiştirme ilk 6;
              tb = C1(5)+C2(4) iki kolon; dt = üç kolon
              [Emily,Layla,Tyler | Olivia,Kevin,Aisha | Jessica,Marcus,Daniel].
              CSS columns dengelemesi deterministik değil — açık kolonlar. */}
          {/* Mobil: tek kolon, 6 kart, 1728 kırpma */}
          {/* Ölçülen: mobil kolonun içerik bloğunda 44px üst ofset var
              (tb'deki 83px kolon başı ofsetinin mobil karşılığı) */}
          <div className="mx-auto mt-11 flex h-[1728px] w-full max-w-[342px] flex-col gap-3 overflow-hidden tb:mt-0 tb:hidden" style={{ WebkitMaskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)", maskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)" }}>
            {MOBILE_ITEMS.map((c) => (
              <ReviewCard key={c.name} data={c} />
            ))}
          </div>
          {/* Tablet: iki kolon (406), 1357 kırpma */}
          <div className="mx-auto hidden h-[1357px] w-full max-w-[824px] gap-3 overflow-hidden tb:flex dt:hidden" style={{ WebkitMaskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)", maskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)" }}>
            {[COL_1, COL_2].map((col, i) => (
              <div key={i} className="flex w-[406px] flex-col gap-3">
                {col.map((c) => (
                  <ReviewCard key={c.name} data={c} />
                ))}
              </div>
            ))}
          </div>
          {/* Geniş: üç kolon (365), kırpmasız */}
          <div className="mx-auto hidden w-full max-w-[1120px] gap-3 overflow-hidden dt:flex dt:h-[950px]" style={{ WebkitMaskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)", maskImage: "linear-gradient(rgb(0,0,0) 44%, rgba(0,0,0,0) 100%)" }}>
            {DT_COLS.map((col, i) => (
              <div key={i} className="flex w-[365px] flex-col gap-3">
                {col.map((c) => (
                  <ReviewCard key={c.name} data={c} />
                ))}
              </div>
            ))}
          </div>
        </CardReveal>
      </div>
    </section>
  );
}
