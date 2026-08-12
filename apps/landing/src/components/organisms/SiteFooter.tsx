"use client";

import { VideoBg } from "../atoms/VideoBg";
import { motion } from "framer-motion";
import Image from "next/image";
import { useTranslation } from "@demli/i18n";
import { CtaButton } from "../atoms/CtaButton";
import { FadeIn } from "../atoms/FadeIn";
import { MaskIcon } from "../atoms/MaskIcon";
import { RevealText } from "../atoms/RevealText";
import { SLIDE_SPRING, slideVariants } from "../atoms/SlideHoverText";
import { useIsMobile } from "../atoms/CardReveal";
import { TrustBadge } from "../molecules/TrustBadge";
import { APP_URL, DOWNLOAD_ANDROID_URL, DOWNLOAD_WINDOWS_URL, GITHUB_URL } from "../../lib/links";

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
  const { t } = useTranslation("landing");
  // Ölçülen: şerit parıltısı tb+'da 0→380→0 salınır (periyot 4017 ms),
  // 390'da statik — hero parıltısıyla aynı ease, farklı süre
  const mobil = useIsMobile();
  return (
    <footer className="relative flex flex-col items-center gap-10 overflow-clip pt-20 tb:gap-16 tb:pt-[120px] dt:pt-[160px]">
      {/* BG şeridi */}
      <div className="footer-strip-mask absolute inset-x-0 top-0 flex h-[300px] items-center justify-center overflow-clip tb:h-[467px] dt:h-[600px]">
        <motion.div
          aria-hidden
          className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-[100%] tb:left-[-155px] tb:right-[-155px] dt:left-[-398px] dt:right-[-398px]"
          style={{
            background:
              "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            filter: "blur(8px)",
          }}
          animate={mobil ? { y: 0 } : { y: [0, 380, 0] }}
          transition={mobil ? undefined : { duration: 4.017, ease: [0.44, 0, 0.56, 1], repeat: Infinity, times: [0, 0.5, 1] }}
        />
        <div className="rotate-180" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
          <VideoBg src="/videos/light-rays.webm" className="h-[300px] w-[720px] max-w-none object-cover tb:h-[467px] tb:w-[1120px] dt:h-[600px] dt:w-[1440px]" />
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
        <p className="whitespace-pre-wrap text-center font-display text-[32px] font-normal leading-[38.4px] tracking-[-0.02em] text-text-primary tb:text-[40px] tb:leading-[48px] dt:text-[44px] dt:leading-[52.8px]">
          {/* Yapı korunur: <br> yok — 580'lik kapta doğal sarım */}
          <RevealText text={t("footer.descLight")} mode="char" />
          <RevealText text={t("footer.descDim")} mode="char" className="text-text-dim" />
        </p>
        <div className="flex w-full flex-col items-center gap-8 tb:w-auto">
          <div className="flex w-full flex-col items-stretch justify-center gap-3 tb:w-auto tb:flex-row tb:flex-wrap tb:items-center tb:gap-x-4 tb:gap-y-5 [&>a]:w-full tb:[&>a]:w-auto">
            <CtaButton href={DOWNLOAD_WINDOWS_URL} label={t("hero.ctaDownload")} variant="primary" />
            <CtaButton href={APP_URL} label={t("hero.ctaOpen")} variant="secondary" external />
          </div>
          <div className="flex items-center gap-[10px]">
            <div className="flex items-center gap-[6px]">
              <MaskIcon name="arrow-circle-down" size={24} color="#737373" />
              <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-dim tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
                {t("hero.platformsNote")}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-[16px] bg-base p-1">
              <a
                href={DOWNLOAD_WINDOWS_URL}
                aria-label={t("hero.windows")}
                className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"
              >
                <MaskIcon name="monitor" size={24} color="#e5e5e5" />
              </a>
              <a
                href={DOWNLOAD_ANDROID_URL}
                aria-label={t("hero.android")}
                className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"
              >
                <MaskIcon name="phone" size={24} color="#e5e5e5" />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Büyük footer ikonu — authored: sarmalayıcı 120/190/210, ikon 240/380/420.
          Ölçülen: parıltı wrapper'a üstten hizalı, BLUR'SUZ, 732×330/872×400/912×420.
          Wrapper'da y250→0 görünürlük reveal'i var — MOBİLDE DE aktif.
          Tetik TRANSFORMSUZ dış kutuda (layout konumu): y250 ötelenmiş kutu
          viewport'a girmediği için IO iç kutuda hiç ateşlemezdi; variant
          kalıtımıyla iç motion.div oynar. */}
      <motion.div
        initial="gizli"
        whileInView="acik"
        viewport={{ amount: 0.05 }}
        className="relative flex h-[120px] w-[240px] flex-col items-center tb:h-[190px] tb:w-[380px] dt:h-[210px] dt:w-[420px]"
      >
        <motion.div
          variants={{ gizli: { y: 250 }, acik: { y: 0 } }}
          transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1 }}
          className="relative flex h-full w-full flex-col items-center"
        >
          <div
            aria-hidden
            className="absolute left-1/2 top-0 h-[330px] w-[732px] max-w-none -translate-x-1/2 rounded-[100%] opacity-40 tb:h-[400px] tb:w-[872px] dt:h-[420px] dt:w-[912px]"
            style={{
              background:
                "radial-gradient(50% 50%, rgba(34, 197, 94, 0.24) 0%, rgba(34, 197, 94, 0) 100%)",
            }}
          />
          <Image
            src="/images/demli-mark.png"
            alt=""
            width={420}
            height={420}
            className="h-[240px] w-[240px] object-contain tb:h-[380px] tb:w-[380px] dt:h-[420px] dt:w-[420px]"
          />
        </motion.div>
      </motion.div>

      {/* Footer Card — authored: wrapper pad 0 40 40 (mobil 0 24 24) */}
      <div className="relative z-[1] flex w-full items-center justify-center px-6 pb-6 tb:px-10 tb:pb-10">
        <div className="relative flex w-full max-w-[1440px] flex-col items-center overflow-hidden rounded-[32px] bg-[#0d0d0db8] dt:rounded-[40px]">
          {/* Ölçülen (tam mount, katman söküm): kart BG'si KOMPLE 180° dönük;
              içinde (1) Video Wrapper > 0.64 opacity'li footer-bg (dönük BG
              yüzünden ters görünür — ref böyle), (2) kendi içinde tekrar 180°
              dönen Light Rays Wrapper (net dik ışık süzmesi), (3) z-1 screen
              noise. 0.08'lik radyal mask dönük BG'nin üstünde. Mobilde BG
              +54'te 300px, tb+ 0'da 600px. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-[54px] z-0 h-[300px] rotate-180 tb:top-0 tb:h-[600px]"
            style={{
              WebkitMaskImage: "radial-gradient(50% 34% at 50% 64.3%, rgba(0,0,0,0.08) 37.7182%, rgba(0,0,0,0) 100%)",
              maskImage: "radial-gradient(50% 34% at 50% 64.3%, rgba(0,0,0,0.08) 37.7182%, rgba(0,0,0,0) 100%)",
            }}
          >
            <div className="absolute inset-0">
              <div className="absolute left-1/2 top-0 h-[300px] w-[720px] max-w-none -translate-x-1/2 opacity-[0.64] tb:h-[600px] tb:w-[1440px]">
                <VideoBg src="/videos/footer-bg.webm" className="h-full w-full object-cover" />
              </div>
            </div>
            <div className="absolute left-1/2 top-0 h-[300px] w-[720px] max-w-none -translate-x-1/2 rotate-180 tb:h-[600px] tb:w-[1440px]" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
              <VideoBg src="/videos/light-rays.webm" className="h-full w-full object-cover" />
            </div>
            <div className="absolute inset-0 z-[1] mix-blend-screen" style={{ WebkitMaskImage: "radial-gradient(64% 50% at 51.2% 0, rgba(0,0,0,0.88) 23.3143%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(64% 50% at 51.2% 0, rgba(0,0,0,0.88) 23.3143%, rgba(0,0,0,0) 100%)" }}><div className="h-full w-full" style={{ backgroundImage: "url(/images/noise.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} /></div>
          </div>
          {/* authored card padding 80 80 40 (mobil 64 24 24); iç ofsetler
              referans render'ından: logo →50→ mail →36→ sosyal →68→ telif */}
          <div className="relative z-[1] flex w-full flex-col items-center px-6 pb-6 pt-16 tb:px-20 tb:pb-10 tb:pt-20">
            <div className="flex flex-col items-center">
              <a href="#hero" className="flex h-11 items-center gap-[10px]">
                <Image
                  src="/images/demli-mark.png"
                  alt=""
                  width={44}
                  height={44}
                  className="h-11 w-11 rounded-[12px] object-contain"
                />
                <span className="font-display text-[28px] font-bold leading-[33.6px] text-text-primary">
                  Demli
                </span>
              </a>
            </div>
            <div className="mt-[50px] flex flex-col items-center">
              {/* Ölçülen (390): pad 16/32/16/24, gap 8, metin 16/24.
                  Mail yerine GitHub — Demli'nin iletişim adresi repo. */}
              <motion.a href={GITHUB_URL} target="_blank" rel="noreferrer" initial="rest" animate="rest" whileHover="hover" className="group flex items-center gap-2 rounded-[18px] bg-surface-2 py-4 pl-6 pr-8">
                <MaskIcon name="star" size={24} color="#a3a3a3" />
                <div className="relative flex h-6 flex-col items-start overflow-hidden tb:h-[25px]">
                  <motion.strong variants={slideVariants(29)} transition={SLIDE_SPRING} className="whitespace-pre text-[16px] font-medium leading-6 text-text-primary tb:text-[18px] tb:leading-[25.2px]">{t("footer.githubPill")}</motion.strong>
                  <motion.strong aria-hidden variants={slideVariants(29)} transition={SLIDE_SPRING} className="absolute top-[29px] whitespace-pre text-[16px] font-medium leading-6 text-text-primary tb:text-[18px] tb:leading-[25.2px]">{t("footer.githubPill")}</motion.strong>
                </div>
              </motion.a>
              {/* authored Social CTA Wrapper: radius 16, gap 16 (mobil 4).
                  Ölçülen (390): p-1, mail→sosyal 32 (tb 36) */}
              <ul className="mt-8 flex items-center gap-1 rounded-[16px] p-1 tb:mt-9 tb:gap-4">
                <li>
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[16px] font-medium leading-[22.4px] text-text-secondary tb:text-[18px] tb:leading-[25.2px]"
                  >
                    {t("footer.linkGithub")}
                  </a>
                </li>
                <li className="flex items-center px-3">
                  <MaskIcon name="dot" size={24} color="#404040" />
                </li>
                <li>
                  <a
                    href={APP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[16px] font-medium leading-[22.4px] text-text-secondary tb:text-[18px] tb:leading-[25.2px]"
                  >
                    {t("footer.linkApp")}
                  </a>
                </li>
              </ul>
            </div>
            {/* Ölçülen (390): telif lh 19.6 (iki satır 39), sosyal→telif 64 (tb 68) */}
            <p className="mt-16 text-center text-[14px] leading-[19.6px] tracking-[-0.28px] text-[#404040] tb:mt-[68px] tb:text-[16px] tb:leading-[19.2px] tb:tracking-[-0.32px]">
              {t("footer.copyright", { year: new Date().getFullYear() })}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
