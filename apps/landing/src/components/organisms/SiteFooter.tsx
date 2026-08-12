"use client";

import { VideoBg } from "../atoms/VideoBg";
import Image from "next/image";
import { CtaButton } from "../atoms/CtaButton";
import { FadeIn } from "../atoms/FadeIn";
import { MaskIcon } from "../atoms/MaskIcon";
import { RevealText } from "../atoms/RevealText";
import { TrustBadge } from "../molecules/TrustBadge";

/**
 * [Section] Footer — authored (audit2):
 * footer: column gap 64 (mobil 40), padding 160 0 0 (dt) / 120 0 0 (tb) /
 * 80 0 0 (mobil). Çocuklar: [BG şeridi(abs), CTA Content, Footer App Icon
 * Wrapper, Footer Card Wrapper].
 * Icon Wrapper yüksekliği 210/190/120; Footer Icon 420/380/240 (alt kırpık).
 * Card Wrapper pad 0 40 40 (mobil 0 24 24). Footer Card: bg #0d0d0db8,
 * radius 40 (dt) / 32, pad 80 80 40 (mobil 64 24 24), gap 64.
 * Sosyal linkler: ul p-1 gap 16 (mobil 4), radius 16.
 */
export function SiteFooter() {
  return (
    <footer className="relative flex flex-col items-center gap-10 overflow-clip pt-20 tb:gap-16 tb:pt-[120px] dt:pt-[160px]">
      {/* BG şeridi */}
      <div className="footer-strip-mask absolute inset-x-0 top-0 flex h-[300px] items-center justify-center overflow-clip tb:h-[467px] dt:h-[600px]">
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
          <VideoBg src="/videos/light-rays.webm" className="h-[300px] w-[720px] object-cover tb:h-[467px] tb:w-[1120px] dt:h-[600px] dt:w-[1440px]" />
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

      {/* CTA içeriği — authored CTA Content: max-w 580, gap 64/40/32 */}
      <div className="relative flex w-full max-w-[580px] flex-col items-center gap-8 px-6 tb:gap-10 tb:px-0 dt:gap-16">
        <FadeIn>
          <TrustBadge />
        </FadeIn>
        <p className="text-center font-display text-[32px] font-normal leading-[38.4px] tracking-[-0.02em] text-text-primary tb:text-[40px] tb:leading-[48px] dt:text-[44px] dt:leading-[52.8px]">
          <RevealText text="Designed to heal, understand everything " mode="char" />
          <RevealText text="and ship with confidence." mode="char" className="text-text-dim" />
        </p>
        <div className="flex w-full flex-col items-center gap-8 tb:w-auto">
          <div className="flex w-full flex-col items-stretch justify-center gap-3 tb:w-auto tb:flex-row tb:flex-wrap tb:items-center tb:gap-x-4 tb:gap-y-5 [&>a]:w-full tb:[&>a]:w-auto">
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
              <MaskIcon name="arrow-circle-down" size={24} color="#737373" />
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

      {/* Büyük footer ikonu — authored: sarmalayıcı 120/190/210, ikon 240/380/420 */}
      <div className="relative flex h-[120px] w-[240px] flex-col items-center tb:h-[190px] tb:w-[380px] dt:h-[210px] dt:w-[420px]">
        <div
          aria-hidden
          className="absolute left-1/2 top-0 h-[400px] w-[872px] -translate-x-1/2 rounded-[100%] opacity-40"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
        />
        <Image
          src="/images/footer-icon.png"
          alt=""
          width={420}
          height={420}
          className="h-[240px] w-[240px] object-contain tb:h-[380px] tb:w-[380px] dt:h-[420px] dt:w-[420px]"
        />
      </div>

      {/* Footer Card — authored: wrapper pad 0 40 40 (mobil 0 24 24) */}
      <div className="relative z-[1] flex w-full items-center justify-center px-6 pb-6 tb:px-10 tb:pb-10">
        <div className="relative flex w-full max-w-[1440px] flex-col items-center overflow-hidden rounded-[32px] bg-[#0d0d0db8] dt:rounded-[40px]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] overflow-hidden" style={{ WebkitMaskImage: "radial-gradient(50% 34% at 50% 64.3%, rgba(0,0,0,0.08) 37.7182%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 34% at 50% 64.3%, rgba(0,0,0,0.08) 37.7182%, rgba(0,0,0,0) 100%)" }}>
            <VideoBg src="/videos/footer-bg.webm" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute left-1/2 top-0 h-[600px] w-[1440px] -translate-x-1/2" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
              <VideoBg src="/videos/light-rays.webm" className="h-full w-full rotate-180 object-cover" />
            </div>
            <div className="absolute inset-0 mix-blend-screen" style={{ WebkitMaskImage: "radial-gradient(64% 50% at 51.2% 0, rgba(0,0,0,0.88) 23.3143%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(64% 50% at 51.2% 0, rgba(0,0,0,0.88) 23.3143%, rgba(0,0,0,0) 100%)" }}><div className="h-full w-full" style={{ backgroundImage: "url(/images/noise.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} /></div>
            <div className="absolute left-1/2 top-[-4px] h-[400px] w-[872px] -translate-x-1/2 rounded-[100%] dt:h-[420px] dt:w-[912px]" style={{ background: "radial-gradient(50% 50%, rgba(34,197,94,0.24) 0%, rgba(34,197,94,0) 100%)" }} />
          </div>
          {/* authored card padding 80 80 40 (mobil 64 24 24); iç ofsetler
              referans render'ından: logo →50→ mail →36→ sosyal →68→ telif */}
          <div className="relative z-[1] flex w-full flex-col items-center px-6 pb-6 pt-16 tb:px-20 tb:pb-10 tb:pt-20">
            <div className="flex flex-col items-center">
              <a href="#hero" className="flex h-11 items-center gap-[10px]">
                <Image
                  src="/images/app-icon.png"
                  alt=""
                  width={44}
                  height={44}
                  className="h-11 w-11 rounded-[12px] object-cover"
                />
                <span className="font-display text-[28px] font-bold leading-[33.6px] text-text-primary">
                  Appzen
                </span>
              </a>
            </div>
            <div className="mt-[50px] flex flex-col items-center">
              <a
                href="mailto:support@appzen.com"
                className="group flex items-center gap-3 rounded-[18px] bg-surface-2 px-8 py-4"
              >
                <MaskIcon name="mail" size={24} color="#a3a3a3" />
                <div className="relative flex h-[21px] flex-col items-start overflow-hidden">
                  <strong className="whitespace-pre text-[16px] font-medium leading-[21px] text-text-primary transition-transform duration-300 ease-out group-hover:-translate-y-[29px] tb:text-[18px]">
                    support@appzen.com
                  </strong>
                  <strong
                    aria-hidden
                    className="absolute top-[29px] whitespace-pre text-[16px] font-medium leading-[21px] text-text-primary transition-transform duration-300 ease-out group-hover:-translate-y-[29px] tb:text-[18px]"
                  >
                    support@appzen.com
                  </strong>
                </div>
              </a>
              {/* authored Social CTA Wrapper: radius 16, gap 16 (mobil 4) */}
              <ul className="mt-9 flex items-center gap-1 rounded-[16px] tb:gap-4">
                <li>
                  <a
                    href="https://x.com/ahmedwalidlab"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[16px] font-medium leading-[22.4px] text-text-secondary tb:text-[18px] tb:leading-[25.2px]"
                  >
                    X(Twitter)
                  </a>
                </li>
                <li className="flex items-center px-3">
                  <MaskIcon name="dot" size={24} color="#404040" />
                </li>
                <li>
                  <a
                    href="https://www.linkedin.com/in/ahmed-walid-designer/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[16px] font-medium leading-[22.4px] text-text-secondary tb:text-[18px] tb:leading-[25.2px]"
                  >
                    Linkedin
                  </a>
                </li>
              </ul>
            </div>
            <p className="mt-[68px] text-center text-[14px] leading-[16.8px] tracking-[-0.28px] text-[#404040] tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
              Copyright © 2026 Appzen. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
