"use client";

import { VideoBg } from "../atoms/VideoBg";
import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { FeatureCard, type FeatureCardData } from "../molecules/FeatureCard";
import { SectionTagline } from "../molecules/SectionTagline";

const CARDS: FeatureCardData[] = [
  {
    tag: "Personalized Onboarding",
    title: "Built Around You, From Day One",
    description:
      "Set your health preferences, body metrics, lifestyle habits, and medical background, so every recommendation feels made specifically for you.",
    bullets: [
      "Tailored health profile setup",
      "Tracks body & lifestyle metrics",
      "Gets smarter every session",
    ],
    phoneImage: "/images/feature-phone-1.png",
  },
  {
    tag: "AI Chat",
    title: "Ask Anything. Get Answers Fast.",
    description:
      "Chat with your 24/7 AI health assistant for symptom guidance, medication advice, and instant answers, no waiting rooms, no appointments needed.",
    bullets: [
      "24/7 AI availability",
      "Symptom & medication guidance",
      "Instant personalized responses",
    ],
    phoneImage: "/images/feature-phone-2.png",
  },
  {
    tag: "Doctor Booking",
    title: "Stop Searching. Start Healing.",
    description:
      "Browse verified doctors by specialty and location, compare real patient ratings, pick a slot, and confirm your appointment in minutes.",
    bullets: [
      "Instant booking confirmation",
      "Live appointment availability",
      "Filter by specialty and location",
    ],
    phoneImage: "/images/feature-phone-3.png",
  },
];

/**
 * [Section] Features — authored: section padding 160 0 (dt) / 120 40 (tb) /
 * 80 24 (mobil); Container gap 80; kartlar gap 24 (mobil 16).
 * BG şeridi 467px (video + noise 0.72 + yeşil daire).
 */
export function Features() {
  return (
    <section
      id="features"
      className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:px-0 dt:py-[160px]"
    >
      {/* BG şeridi */}
      <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[467px] items-center justify-center overflow-clip">
        <div
          aria-hidden
          className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-[100%] tb:left-[-155px] tb:right-[-155px] dt:left-[-398px] dt:right-[-398px]"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="flex h-full w-full items-center justify-center">
          <div className="rotate-180" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
          <VideoBg src="/videos/light-rays.webm" className="h-[300px] w-[720px] object-cover tb:h-[467px] tb:w-[1120px]" />
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
          <FadeIn>
            <SectionTagline label="Features" />
          </FadeIn>
          {/* authored: başlık BLOK olarak açılır — spring {bounce .3, dur 3}, threshold .5 */}
          <FadeIn y={0} amount={0.5} transition={{ type: "spring", bounce: 0.3, duration: 3 }}>
            <h2 className="text-center font-display text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px] dt:text-[56px] dt:leading-[61.6px]">
              <span className="tb:hidden"><span className="text-white">Built for human thinking</span><br /><span className="text-text-dim">automated Intelligently</span></span><span className="hidden tb:inline"><span className="text-white">Designed for People</span><br /><span className="text-text-dim">Powered by AI</span></span>
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
              <FeatureCard data={{ ...card, featured: i === 1 }} />
            </CardReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
