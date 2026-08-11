"use client";

import { CardReveal } from "../atoms/CardReveal";
import { FadeIn } from "../atoms/FadeIn";
import { RevealText } from "../atoms/RevealText";
import { PricingCard, type PricingCardData } from "../molecules/PricingCard";
import { SectionTagline } from "../molecules/SectionTagline";

const PLANS: PricingCardData[] = [
  {
    plan: "Starter",
    price: "Free",
    description: "AI-guided symptom checks and basic doctor discovery, no commitment needed.",
    ctaLabel: "Get Started",
    ctaVariant: "secondary",
    features: [
      "Basic AI health chat",
      "Advanced budgeting tools",
      "Doctor search & profiles",
      "Doctor search & profiles",
    ],
  },
  {
    plan: "Premium",
    price: "$7",
    priceSuffix: "/month",
    description: "Unlimited AI consultations, full medical history, and priority specialist access.",
    ctaLabel: "Get Started with Pro",
    ctaVariant: "primary",
    features: [
      "Unlimited AI consultations",
      "Full medical history & reports",
      "Priority health alerts & insights",
      "Early access to new features",
    ],
    featured: true,
  },
];

/**
 * [Section] Pricing — ölçülen: BG şeridi 467 (ortak reçete), Container
 * pt 120 / gap 80, Title (Tagline + iki tonlu 48px başlık), Cards Wrapper
 * 824 (2×404 + 16 gap), bölüm sonu 120 boşluk.
 */
export function Pricing() {
  return (
    <section id="pricing" className="relative flex flex-col items-center overflow-clip">
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

      <div className="relative flex w-full flex-col items-center gap-20 pb-[120px] pt-[120px]">
        <div className="flex flex-col items-center gap-8">
          <FadeIn>
            <SectionTagline label="Pricing" />
          </FadeIn>
          <h2 className="text-center font-display text-[48px] font-medium leading-[52.8px] tracking-[-0.2px]">
            <RevealText text="Choose the perfect plan" mode="word" className="text-white" />
            <br />
            <RevealText text="for your needs" mode="word" className="text-text-dim" />
          </h2>
        </div>
        <div className="flex items-start gap-4">
          {PLANS.map((p, i) => (
            <CardReveal key={p.plan} y={200} delay={i * 0.15}>
              <PricingCard data={p} />
            </CardReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
