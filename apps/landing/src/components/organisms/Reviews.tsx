"use client";

import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { RevealText } from "../atoms/RevealText";
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

/**
 * [Section] Reviews — ölçülen: BG şeridi 467 (Features ile aynı reçete),
 * Container pt 120 / gap 80; Title: rozet (defne kanatları + avatar yığını
 * + 5 yıldız + "Trusted by 50K+ users") + 48px iki tonlu başlık;
 * Content 1357 yüksek, 2 kolon 406px gap 12, kolon içi gap 12,
 * kolon başı 83px ofset, taşan kısım kırpılır.
 */
export function Reviews() {
  return (
    <section id="reviews" className="relative flex flex-col items-center overflow-clip">
      {/* BG şeridi */}
      <div className="absolute inset-x-0 top-0 flex h-[467px] items-center justify-center overflow-clip">
        <div
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-[1575px] -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="rotate-180">
          <video
            src="/videos/light-rays.webm"
            autoPlay
            loop
            muted
            playsInline
            className="h-[467px] w-[1120px] object-cover"
          />
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
      <div className="relative flex w-full flex-col items-center gap-20 pb-[120px] pt-[120px]">
        <div className="flex flex-col items-center gap-8">
          <FadeIn>
            <TrustBadge />
          </FadeIn>
          <h2 className="text-center font-display text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px]">
            <RevealText text="Hear what other users" mode="word" className="text-white" />
            <br />
            <RevealText text="have to say" mode="word" className="text-text-dim" />
          </h2>
        </div>

        {/* Kolonlar — mobilde tek kolon */}
        <div className="flex h-[1357px] flex-col items-center gap-3 overflow-hidden px-6 tb:flex-row tb:items-start tb:justify-center tb:px-0">
          <div className="flex w-full max-w-[327px] flex-col gap-3 tb:w-[406px] tb:max-w-none tb:pt-[83px]">
            {COL_1.map((c, i) => (
              <CardReveal key={c.name} y={40} delay={i * 0.08}>
                <ReviewCard data={c} />
              </CardReveal>
            ))}
          </div>
          <div className="flex w-full max-w-[327px] flex-col gap-3 tb:w-[406px] tb:max-w-none tb:pt-[83px]">
            {COL_2.map((c, i) => (
              <CardReveal key={c.name} y={40} delay={i * 0.08 + 0.04}>
                <ReviewCard data={c} />
              </CardReveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
