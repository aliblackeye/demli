"use client";

import { VideoBg } from "../atoms/VideoBg";
import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { ReviewCard, type ReviewCardData } from "../molecules/ReviewCard";
import { TrustBadge } from "../molecules/TrustBadge";

const COL_1: ReviewCardData[] = [
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Emily Rodriguez",
    date: "Apr 13, 2026",
    title: "Incredibly Useful",
    body: "I was skeptical about AI health apps but this one is different.",
  },
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Jessica Wang",
    date: "Jan 13, 2026",
    title: "Highly Recommend",
    body: "Got my medication delivered same day. The AI suggested exactly what my doctor ended up prescribing.",
  },
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Kevin Patterson",
    date: "Aug 7, 2025",
    title: "Feels Personal",
    body: "It doesn't feel like talking to a bot. The AI asks the right questions and the doctor it matched me with was perfect.",
  },
  {
    store: "google-play",
    href: "https://play.google.com/store/games?hl=en",
    name: "Tyler Brooks",
    date: "May 2, 2025",
    title: "Simple and Smart",
    body: "Takes 30 seconds to find a verified doctor nearby. The ratings and reviews helped me pick someone I actually trusted.",
  },
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Daniel Harris",
    date: "May 13, 2024",
    title: "Best Health App",
    body: "Switched from two other apps. The UI is clean and fast.",
  },
];

const COL_2: ReviewCardData[] = [
  {
    store: "google-play",
    href: "https://play.google.com/store/games?hl=en",
    name: "Olivia Bennett",
    date: "Feb 13, 2026",
    title: "Genuinely Impressed",
    body: "The onboarding alone shows how much thought went into this. It actually remembered my medical background every single time.",
  },
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Layla Morrison",
    date: "Nov 12, 2025",
    title: "Data That Means Something",
    body: "Most health apps just collect numbers. This one tells you what they mean. My weekly snapshot caught a sleep pattern that explained months of low energy.",
  },
  {
    store: "google-play",
    href: "https://play.google.com/store/games?hl=en",
    name: "Marcus Thompson",
    date: "May 13, 2025",
    title: "So Convenient",
    body: "Described my symptoms at midnight, got an answer in seconds. Had a doctor booked for 8am. No more urgent care visits.",
  },
  {
    store: "apple",
    href: "https://www.apple.com/eg/app-store/",
    name: "Aisha Patel",
    date: "Mar 1, 2025",
    title: "Finally Keeps Up",
    body: "Managing Type 2 diabetes means tracking a dozen things daily. Medra connects the dots — glucose patterns, appointments, and medications actually talk to each other.",
  },
];

const byName = (n: string): ReviewCardData => [...COL_1, ...COL_2].find((c) => c.name === n)!;

/* Mobil (ölçüldü): C1/C2 serpiştirme, ilk 6 */
const MOBILE_ITEMS: ReviewCardData[] = [
  "Emily Rodriguez",
  "Olivia Bennett",
  "Jessica Wang",
  "Layla Morrison",
  "Kevin Patterson",
  "Marcus Thompson",
].map(byName);

/* Geniş ekran (ölçüldü): üç kolon */
const DT_COLS: ReviewCardData[][] = [
  ["Emily Rodriguez", "Layla Morrison", "Tyler Brooks"].map(byName),
  ["Olivia Bennett", "Kevin Patterson", "Aisha Patel"].map(byName),
  ["Jessica Wang", "Marcus Thompson", "Daniel Harris"].map(byName),
];

/**
 * [Section] Reviews — ölçülen: BG şeridi 467 (Features ile aynı reçete),
 * Container pt 120 / gap 80; Title: rozet (defne kanatları + avatar yığını
 * + 5 yıldız + "Trusted by 50K+ users") + 48px iki tonlu başlık;
 * Content 1357 yüksek, 2 kolon 406px gap 12, kolon içi gap 12,
 * kolon başı 83px ofset, taşan kısım kırpılır.
 */
export function Reviews() {
  return (
    <section
      id="reviews"
      className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:px-0 dt:py-[160px]"
    >
      {/* BG şeridi */}
      <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[467px] items-center justify-center overflow-clip">
        <div
          aria-hidden
          className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-full tb:left-[-318px] tb:right-[-318px] dt:left-[-398px] dt:right-[-398px]"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="rotate-180" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
          <VideoBg src="/videos/light-rays.webm" className="h-[467px] w-[1120px] object-cover" />
        </div>
        <div
          aria-hidden
          className="absolute inset-0 z-[1] opacity-70 mix-blend-screen"
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
      <div className="relative flex w-full flex-col items-center gap-20">
        <div className="flex flex-col items-center gap-8">
          <FadeIn className="hidden tb:block">
            <TrustBadge />
          </FadeIn>
          {/* authored: BLOK açılım spring {bounce .3, dur 3}, threshold .5;
              mobil varyantta metin farklı ("Here from other users have to say") */}
          <FadeIn y={0} amount={0.5} transition={{ type: "spring", bounce: 0.3, duration: 3 }}>
            <h2 className="text-center font-display text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px] dt:text-[56px] dt:leading-[61.6px]">
              <span className="tb:hidden">
                <span className="text-white">Here from other users </span>
                <span className="text-text-dim">have to say</span>
              </span>
              <span className="hidden tb:inline">
                <span className="text-white">Hear what other users</span>
                <br />
                <span className="text-text-dim">have to say</span>
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
          <div className="mx-auto flex h-[1728px] w-full max-w-[327px] flex-col gap-3 overflow-hidden tb:hidden">
            {MOBILE_ITEMS.map((c) => (
              <ReviewCard key={c.name} data={c} />
            ))}
          </div>
          {/* Tablet: iki kolon (406), 1357 kırpma */}
          <div className="mx-auto hidden h-[1357px] w-full max-w-[824px] gap-3 overflow-hidden tb:flex dt:hidden">
            {[COL_1, COL_2].map((col, i) => (
              <div key={i} className="flex w-[406px] flex-col gap-3">
                {col.map((c) => (
                  <ReviewCard key={c.name} data={c} />
                ))}
              </div>
            ))}
          </div>
          {/* Geniş: üç kolon (365), kırpmasız */}
          <div className="mx-auto hidden w-full max-w-[1119px] gap-3 dt:flex">
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
