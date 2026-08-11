"use client";

import Image from "next/image";
import { CtaButton } from "../atoms/CtaButton";
import { MaskIcon } from "../atoms/MaskIcon";
import { TrustBadge } from "../molecules/TrustBadge";

/**
 * [Section] Footer — ölçülen: BG şeridi 467 (ortak reçete, yeşil daire
 * daha geniş: inset 0 -398px), CTA Content 580 pt 120 gap 40:
 * TrustBadge + 3 satırlık 40px açıklama + butonlar + mağaza satırı.
 * Footer ikon 380px (üst yarısı görünür, 190 kırpma + yeşil parıltı).
 * Footer Card 1185×419: bg rgba(13,13,13,0.72) radius 32, video zemin,
 * logo satırı + mail hapı + sosyal linkler + telif satırı.
 */
export function SiteFooter() {
  return (
    <footer className="relative flex flex-col items-center overflow-clip">
      {/* BG şeridi */}
      <div className="absolute inset-x-0 top-0 flex h-[467px] items-center justify-center overflow-clip">
        <div
          aria-hidden
          className="absolute inset-y-0 left-[-398px] right-[-398px] rounded-full"
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

      {/* CTA içeriği */}
      <div className="relative flex w-[580px] flex-col items-center gap-10 pt-[120px]">
        <TrustBadge />
        <p className="text-center font-display text-[40px] font-normal leading-[48px] tracking-[-0.8px] text-text-primary">
          Designed to heal,
          <br />
          understand everything{" "}
          <span className="text-text-dim">
            <br />
            and ship with confidence.
          </span>
        </p>
        <div className="flex flex-col items-center gap-8">
          <div className="flex items-center justify-center gap-x-5 gap-y-4">
            <CtaButton href="#download" label="Download App" variant="primary" />
            <CtaButton
              href="#demo"
              label="Watch demo"
              variant="secondary"
              icon={<MaskIcon name="play" size={24} color="#a3a3a3" />}
            />
          </div>
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

      {/* Büyük footer ikonu — 380px, alt yarısı kırpılır, yeşil parıltı */}
      <div className="relative mt-16 flex h-[190px] w-[380px] flex-col items-center overflow-visible">
        <div
          aria-hidden
          className="absolute left-1/2 top-0 h-[400px] w-[872px] -translate-x-1/2 rounded-full opacity-40"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <Image
          src="/images/footer-icon.png"
          alt=""
          width={380}
          height={380}
          className="h-[380px] w-[380px] object-contain"
        />
      </div>

      {/* Footer Card */}
      <div className="relative z-[1] mt-16 flex w-full items-center justify-center px-10 pb-10">
        <div className="relative w-full max-w-[1185px] overflow-hidden rounded-[32px] bg-[rgba(13,13,13,0.72)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] overflow-hidden opacity-40">
            <video
              src="/videos/footer-bg.webm"
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover"
            />
          </div>
          <div className="relative z-[1] flex flex-col items-center gap-16 px-10 pb-10 pt-20">
            <div className="flex flex-col items-center gap-6">
              <a href="#hero" className="flex items-center gap-[10px]">
                <Image
                  src="/images/app-icon.png"
                  alt=""
                  width={44}
                  height={44}
                  className="h-11 w-11 rounded-[12px] object-cover"
                />
                <span className="font-display text-[32px] font-medium leading-[38px] text-white">
                  Appzen
                </span>
              </a>
            </div>
            <div className="flex flex-col items-center gap-6">
              <a
                href="mailto:support@appzen.com"
                className="group flex items-center gap-3 rounded-[18px] bg-surface-2 px-8 py-4"
              >
                <MaskIcon name="mail" size={24} color="#a3a3a3" />
                <div className="relative flex h-[21px] flex-col items-start overflow-hidden">
                  <strong className="text-[16px] font-medium leading-[21px] tracking-[-0.32px] text-text-primary transition-transform duration-300 ease-out group-hover:-translate-y-[29px]">
                    support@appzen.com
                  </strong>
                  <strong
                    aria-hidden
                    className="absolute top-[29px] text-[16px] font-medium leading-[21px] tracking-[-0.32px] text-text-primary transition-transform duration-300 ease-out group-hover:-translate-y-[29px]"
                  >
                    support@appzen.com
                  </strong>
                </div>
              </a>
              <div className="flex items-center gap-8">
                <a
                  href="https://x.com/ahmedwalidlab"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[18px] font-medium leading-[25.2px] text-text-secondary"
                >
                  X(Twitter)
                </a>
                <MaskIcon name="dot" size={4} color="#737373" />
                <a
                  href="https://www.linkedin.com/in/ahmed-walid-designer/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[18px] font-medium leading-[25.2px] text-text-secondary"
                >
                  Linkedin
                </a>
              </div>
            </div>
            <p className="text-center text-[16px] leading-[19.2px] tracking-[-0.32px] text-text-dim">
              Copyright © 2026 Appzen. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
