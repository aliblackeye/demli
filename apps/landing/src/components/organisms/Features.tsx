"use client";

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
 * [Section] Features — ölçülen: BG 467px (video + noise 0.72 + yeşil daire),
 * Container pad 120 üst / gap 80, başlık bloğu (Tagline + iki satırlı 48px
 * heading), kartlar kolon gap 24.
 */
export function Features() {
  return (
    <section id="features" className="relative flex flex-col items-center overflow-clip">
      {/* BG şeridi */}
      <div className="absolute inset-x-0 top-0 flex h-[467px] items-center justify-center overflow-clip">
        <div
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-[1575px] -translate-x-1/2 rounded-full opacity-100"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <div className="flex h-full w-full items-center justify-center">
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
      <div className="relative flex w-full max-w-[1185px] flex-col items-center gap-20 px-0 pt-[120px]">
        <div className="flex flex-col items-center gap-8">
          <SectionTagline label="Features" />
          <h2 className="text-center font-display text-[48px] font-medium leading-[52.8px] tracking-[-0.2px]">
            <span className="text-white">Designed for People</span>
            <br />
            <span className="text-text-dim">Powered by AI</span>
          </h2>
        </div>
        <div className="flex flex-col items-center gap-6 pb-[120px]">
          {CARDS.map((card) => (
            <FeatureCard key={card.tag} data={card} />
          ))}
        </div>
      </div>
    </section>
  );
}
