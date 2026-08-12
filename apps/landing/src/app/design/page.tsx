"use client";

/**
 * Demli Design System v1 "Koyu Masa" — CANLI SHOWCASE (onay turu, v2).
 * Bu sayfa landing'in KENDİ dilinde kurulur: ışık huzmesi şeritleri, mercan
 * parıltılar, noise, gerçek ölçekli display tipografi, kayan hover'lar,
 * reveal'ler. Tek fark: yeşil → mercan ve display font önerisi Onest.
 * Landing'in kendisi henüz değişmedi — onaydan sonra entegre edilir.
 */

import { Onest } from "next/font/google";
import { motion } from "framer-motion";
import { useState } from "react";
import { LenisProvider } from "@/components/atoms/LenisProvider";
import { ProgressiveBlur } from "@/components/atoms/ProgressiveBlur";
import { VideoBg } from "@/components/atoms/VideoBg";
import { FadeIn } from "@/components/atoms/FadeIn";
import { CardReveal } from "@/components/atoms/CardReveal";
import { RevealText } from "@/components/atoms/RevealText";
import { ShimmerText } from "@/components/atoms/ShimmerText";
import { SlideHoverText } from "@/components/atoms/SlideHoverText";
import { MaskIcon } from "@/components/atoms/MaskIcon";
import { ReviewCard } from "@/components/molecules/ReviewCard";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

/* ── Önerilen tokenlar — entegrasyonda token dosyasına iner ── */
const T = {
  accent: "#ff8464",
  accentStrong: "#ffa48c",
  accentDeep: "#e8624a",
  accentSoft: "rgba(255,132,100,0.12)",
  glow: "rgba(255,132,100,0.24)",
  gold: "#eab30a",
  success: "#22c55e",
  danger: "#ff6fb5",
};

const SPRING_HOVER = { type: "spring", bounce: 0.2, duration: 0.4 } as const;

/* Landing'in ışık şeridi reçetesi — mercan parıltıyla */
function IsikSeridi() {
  return (
    <div className="hero-bg-mask absolute inset-x-0 top-0 flex h-[300px] items-center justify-center overflow-clip tb:h-[467px]">
      <div
        aria-hidden
        className="absolute inset-y-0 left-[-165px] right-[-165px] rounded-[100%] tb:left-[-155px] tb:right-[-155px] dt:left-[-398px] dt:right-[-398px]"
        style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }}
      />
      <div className="rotate-180" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 82.2354%, rgba(0,0,0,0) 100%)" }}>
        <VideoBg src="/videos/light-rays.webm" className="h-[300px] w-[720px] max-w-none object-cover tb:h-[467px] tb:w-[1120px]" />
      </div>
      <div
        aria-hidden
        className="absolute inset-0 z-[1] opacity-70 mix-blend-screen backdrop-blur-[2px]"
        style={{ WebkitMaskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)" }}
      >
        <div className="h-full w-full" style={{ backgroundImage: "url(/images/noise.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} />
      </div>
    </div>
  );
}

/* Landing'in bölüm başı dili: hap + iki tonlu büyük H2 */
function BolumBasi({ hap, beyaz, dim }: { hap: string; beyaz: string; dim: string }) {
  return (
    <div className="relative flex flex-col items-center gap-6 tb:gap-8">
      <FadeIn>
        <div className="flex items-center justify-center rounded-[50px] bg-base px-3 py-2 backdrop-blur-[8px] tb:px-[18px] tb:py-3" style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}>
          <ShimmerText text={hap} color={T.gold} className="text-[14px] font-medium leading-[16.8px] text-text-dim tb:text-[16px] tb:leading-[19.2px]" />
        </div>
      </FadeIn>
      <FadeIn y={0} amount={0.5} transition={{ type: "spring", bounce: 0.3, duration: 3 }}>
        <h2 className={onest.className + " whitespace-pre-wrap text-center text-[36px] font-medium leading-[39.6px] tracking-[-0.2px] tb:text-[48px] tb:leading-[52.8px] dt:text-[56px] dt:leading-[61.6px]"}>
          <span className="text-white">{beyaz} </span>
          <span className="text-text-dim">{dim}</span>
        </h2>
      </FadeIn>
    </div>
  );
}

/* Landing kart reçetesi: bg-base + noise(screen) + dots figürü + kenarsız */
function SistemKarti({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"relative overflow-hidden rounded-[32px] bg-base " + className}>
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ WebkitMaskImage: "radial-gradient(50% 100% at 63.4% 50%, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 100% at 63.4% 50%, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0) 100%)" }}>
        <div className="absolute inset-0 opacity-[0.32] mix-blend-screen" style={{ WebkitMaskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(65% 50%, rgba(0,0,0,0.88) 25.044%, rgba(0,0,0,0) 100%)" }}>
          <div className="h-full w-full" style={{ backgroundImage: "url(/images/noise.png)", backgroundRepeat: "repeat", backgroundSize: "128px" }} />
        </div>
      </div>
      <div className="relative z-[1]">{children}</div>
    </div>
  );
}

function Renk({ ad, deger, koyuMetin }: { ad: string; deger: string; koyuMetin?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-24 items-end rounded-[16px] p-3" style={{ background: deger, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)" }}>
        <span className="text-[11px] font-medium" style={{ color: koyuMetin ? "#1a1a1a" : "rgba(255,255,255,0.85)" }}>{deger}</span>
      </div>
      <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</p>
    </div>
  );
}

/* Gerçek CTA geometrisi + kayan hover — mercan varyantıyla */
function CtaOrnek({ etiket, tur }: { etiket: string; tur: "birincil" | "ikincil" | "mercan" }) {
  const zemin = tur === "birincil" ? "#ffffff" : tur === "ikincil" ? "#262626" : T.accent;
  const renk = tur === "ikincil" ? "#e5e5e5" : "#171717";
  const cls = "whitespace-nowrap text-[16px] font-medium leading-6 tb:text-[18px] tb:leading-[25.2px]";
  return (
    <motion.a href="#" onClick={(e) => e.preventDefault()} initial="rest" animate="rest" whileHover="hover" className="flex items-center justify-center rounded-[18px] px-8 py-4" style={{ background: zemin }}>
      <div className="relative flex h-6 flex-col items-start overflow-hidden tb:h-[25px]">
        <motion.strong variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls} style={{ color: renk }}>{etiket}</motion.strong>
        <motion.strong aria-hidden variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls + " absolute top-[29px]"} style={{ color: renk }}>{etiket}</motion.strong>
      </div>
    </motion.a>
  );
}

function HareketDemo() {
  const [tur, setTur] = useState(0);
  return (
    <div className="flex w-full flex-col items-center gap-8">
      <button onClick={() => setTur((x) => x + 1)} className="rounded-[12px] bg-surface-2 px-4 py-2 text-[14px] font-medium leading-[19.6px] text-text-primary transition-colors hover:bg-[#303030]">
        Yeniden oynat
      </button>
      <div className="grid w-full gap-4 tb:grid-cols-3">
        {["Kart reveal — y64, spring {60/500}", "Kademe 120ms", "Çift yönlü (yukarıda geri sarar)"].map((yazi, i) => (
          <motion.div key={tur + "-" + i} initial={{ opacity: 0, y: 64 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1, delay: 0.45 + i * 0.12 }}>
            <SistemKarti className="p-8">
              <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>0{i + 1}</p>
              <p className="mt-2 text-[16px] leading-6 text-text-secondary">{yazi}</p>
            </SistemKarti>
          </motion.div>
        ))}
      </div>
      <div key={"rt-" + tur} className="text-center">
        <RevealText
          text="Kelimeler blur(10px) ile teker teker gelir, yukarı çıkınca geri sarar."
          mode="word"
          blurlu
          as="p"
          className={onest.className + " text-[28px] font-normal leading-[1.2] tracking-[-0.02em] text-text-primary tb:text-[36px]"}
        />
      </div>
    </div>
  );
}

export default function DesignShowcase() {
  return (
    <LenisProvider>
      <div className="relative">
        {/* ── HERO — landing hero dili: şerit + mercan parıltı + gerçek ölçek ── */}
        <header className="relative flex flex-col items-center overflow-clip px-6 pb-20 pt-[120px] tb:px-0 tb:pb-[120px] tb:pt-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full flex-col items-center gap-10 tb:gap-[52px]">
            <div className="flex w-full max-w-[604px] flex-col items-center gap-6 tb:gap-8 dt:max-w-[880px]">
              <FadeIn>
                <div className="flex items-center gap-2 rounded-[50px] bg-[rgba(0,0,0,0.24)] py-[6px] pl-[6px] pr-[18px] backdrop-blur-[8px]" style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}>
                  <div className="flex items-center gap-[10px] rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: T.accent }} />
                    <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5]">v1</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ShimmerText text="Koyu Masa" color={T.gold} className="text-[14px] font-medium leading-[16.8px] text-[#e5e5e5] tb:text-[16px]" />
                    <p className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-dim tb:text-[16px]">Design system · onay turu</p>
                  </div>
                </div>
              </FadeIn>
              <div className="w-full" style={{ WebkitMaskImage: "linear-gradient(rgb(0,0,0) 50%, rgba(0,0,0,0.64) 100%)", maskImage: "linear-gradient(rgb(0,0,0) 50%, rgba(0,0,0,0.64) 100%)" }}>
                <h1 className={onest.className + " hero-title w-full text-center font-semibold text-white"}>
                  Koyu Masa<span style={{ color: T.accent }}>.</span>
                </h1>
              </div>
              <FadeIn y={0} amount={0.2}>
                <p className={onest.className + " whitespace-pre-wrap text-center text-[32px] font-normal leading-[38.4px] tracking-[-0.02em] text-text-primary tb:text-[40px] tb:leading-[48px] dt:text-[44px] dt:leading-[52.8px]"}>
                  <span>Landing&apos;in dili, ürünün sistemi. </span>
                  <span className="text-text-dim">Yeşil gitti, mercan geldi.</span>
                </p>
              </FadeIn>
              <div className="flex flex-col items-center gap-3 tb:flex-row tb:gap-4">
                <CtaOrnek etiket="Birincil" tur="birincil" />
                <CtaOrnek etiket="İkincil" tur="ikincil" />
                <CtaOrnek etiket="Mercan (yeni)" tur="mercan" />
              </div>
            </div>
          </div>
        </header>

        {/* ── 01 RENK ── */}
        <section className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:py-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full max-w-[1120px] flex-col items-center gap-10 tb:gap-20">
            <BolumBasi hap="Renk" beyaz="Siyah masa," dim="mercan ışık" />
            <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.45, duration: 0.6 }} className="w-full">
              <SistemKarti className="w-full p-8 tb:p-16">
                <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Zeminler — landing&apos;den birebir, kenarsız</p>
                <div className="mt-6 grid grid-cols-2 gap-4 tb:grid-cols-4">
                  <Renk ad="bg-page" deger="#000000" />
                  <Renk ad="bg-base" deger="#0d0d0d" />
                  <Renk ad="bg-surface" deger="#171717" />
                  <Renk ad="bg-surface-2" deger="#262626" />
                </div>
                <p className="mt-10 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Vurgu — yeşilin yerine Demli mercanı</p>
                <div className="mt-6 grid grid-cols-2 gap-4 tb:grid-cols-4">
                  <Renk ad="accent" deger={T.accent} koyuMetin />
                  <Renk ad="accent-strong" deger={T.accentStrong} koyuMetin />
                  <Renk ad="accent-deep" deger={T.accentDeep} koyuMetin />
                  <Renk ad="gold — yıldız" deger={T.gold} koyuMetin />
                </div>
                <p className="mt-10 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Durum renkleri — yeşil artık yalnız &quot;çevrimiçi&quot;</p>
                <div className="mt-6 grid grid-cols-2 gap-4 tb:grid-cols-4">
                  <Renk ad="success / online" deger={T.success} koyuMetin />
                  <Renk ad="danger (≥30° ayrı)" deger={T.danger} koyuMetin />
                  <Renk ad="metin — primary" deger="#e5e5e5" koyuMetin />
                  <Renk ad="metin — dim" deger="#737373" />
                </div>
              </SistemKarti>
            </CardReveal>
            <div className="grid w-full gap-4 tb:grid-cols-2">
              <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.45, duration: 0.6 }}>
                <div className="relative flex h-56 items-center justify-center overflow-hidden rounded-[32px] bg-base">
                  <div className="absolute inset-x-[-120px] inset-y-0 rounded-[100%]" style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
                  <p className="relative text-[16px] font-medium leading-6 text-text-primary">accent-glow — parıltılar bu tona döner</p>
                </div>
              </CardReveal>
              <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.57, duration: 0.6 }}>
                <div className="flex h-56 flex-col items-start justify-center gap-4 rounded-[32px] bg-base p-8">
                  <div className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2" style={{ background: T.accentSoft }}>
                    <MaskIcon name="star" size={14} color={T.accentStrong} />
                    <span className="text-[14px] font-medium leading-[19.6px]" style={{ color: T.accentStrong }}>Seçili satır — accent-soft zemin</span>
                  </div>
                  <div className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2">
                    <span className="text-[14px] font-medium leading-[19.6px] text-text-secondary"># sıradan satır</span>
                  </div>
                </div>
              </CardReveal>
            </div>
          </div>
        </section>

        {/* ── 02 TİPOGRAFİ ── */}
        <section className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:py-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full max-w-[1120px] flex-col items-center gap-10 tb:gap-20">
            <BolumBasi hap="Tipografi" beyaz="Onest konuşur," dim="Inter yazar" />
            <div className="flex w-full flex-col items-center gap-16">
              <div className="w-full text-center">
                <p className="mb-3 text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-dim">Display-1 — hero ölçeği (56/92/112, %110, −0.2px)</p>
                <p className={onest.className + " hero-title font-semibold text-white"}>Çayını al, gel.</p>
              </div>
              <div className="w-full text-center">
                <p className="mb-3 text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-dim">Display-3 — kart başlığı (40/52) + blur kademe canlı</p>
                <RevealText text="Ses bir ayar, ödül değil." mode="word" blurlu as="p" className={onest.className + " text-[40px] font-normal leading-[44px] text-white tb:text-[52px] tb:leading-[57.2px]"} />
              </div>
              <SistemKarti className="w-full p-8 tb:p-16">
                <div className="flex flex-col gap-4">
                  <p className="text-[16px] leading-6 text-text-secondary">Gövde-L 16/24 — Kanal 128 kbps&apos;e kadar açık; kimse bunun için sunucu yükseltmez.</p>
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">UI 14/19.6 — Odaya gir · Ekranı paylaş · Sesini ayarla</p>
                  <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-dim">Küçük 12/14.4 — 13 Nis 2026 · çevrimiçi 4 kişi</p>
                  <p className="mt-4 text-[14px] leading-[19.6px] text-text-dim">Display: <span className="text-text-primary">Onest (OFL, Türkçe tam)</span> — Stack Sans&apos;ın lisans-temiz karşılığı. Alternatif: Schibsted Grotesk, General Sans. Gövde/UI: Inter (mevcut, kalır).</p>
                </div>
              </SistemKarti>
            </div>
          </div>
        </section>

        {/* ── 03 BİLEŞENLER ── */}
        <section className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:py-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full max-w-[1120px] flex-col items-center gap-10 tb:gap-20">
            <BolumBasi hap="Bileşenler" beyaz="Aynı geometri," dim="yeni ışık" />
            <div className="grid w-full gap-4 tb:grid-cols-2">
              <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.45, duration: 0.6 }}>
                <SistemKarti className="p-8">
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Nav hapı — kayan hover&apos;lar (üstlerine gel)</p>
                  <div className="mt-6 flex items-center justify-between rounded-[16px] bg-[rgba(23,23,23,0.72)] py-3 pl-6 pr-3 backdrop-blur-[10px]">
                    <div className="flex items-center gap-6">
                      <span className={onest.className + " text-[18px] font-semibold text-white"}>Demli</span>
                      {["Özellikler", "Yorumlar"].map((l) => (
                        <motion.span key={l} initial="rest" animate="rest" whileHover="hover" className="cursor-pointer">
                          <SlideHoverText label={l} />
                        </motion.span>
                      ))}
                    </div>
                    <span className="rounded-[12px] bg-surface-2 px-3 py-2 text-[14px] font-medium leading-[16.8px] text-[#e5e5e5]">Demli&apos;yi aç</span>
                  </div>
                  <p className="mt-6 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Hap / rozet</p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-4 py-2 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
                      <MaskIcon name="star" size={12} color={T.gold} />
                      <span className="text-[14px] font-medium leading-[16.8px] text-[#e5e5e5]">Açık kaynak</span>
                      <span className="text-[14px] leading-[16.8px] text-text-dim">Ücretli kademe yok</span>
                    </div>
                    <div className="flex items-center gap-2 rounded-[16px] bg-base p-1">
                      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"><MaskIcon name="monitor" size={22} color="#e5e5e5" /></span>
                      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface"><MaskIcon name="phone" size={22} color="#e5e5e5" /></span>
                    </div>
                  </div>
                </SistemKarti>
              </CardReveal>
              <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.57, duration: 0.6 }}>
                <div>
                  <ReviewCard
                    data={{
                      store: "monitor",
                      href: "#",
                      name: "Ece",
                      date: "13 Şub 2026",
                      title: "Gitar gecesi kurtuldu",
                      body: "Müzik moduna aldım, teller cızırtı olmaktan çıktı. Grup ilk kez susup dinledi. (Gerçek yorum kartı — hover'da zemin açılır.)",
                    }}
                  />
                  <SistemKarti className="mt-4 p-8">
                    <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accent }}>Giriş alanı (ürün) — kenarsız, focus&apos;ta mercan izi</p>
                    <div className="mt-4 flex items-center gap-2 rounded-[16px] bg-[#0d0d0d] px-4 py-3" style={{ boxShadow: `inset 0 0 0 1px ${T.accentSoft}` }}>
                      <span className="text-[14px] leading-[19.6px] text-text-dim">Mesaj yaz…</span>
                    </div>
                  </SistemKarti>
                </div>
              </CardReveal>
            </div>
          </div>
        </section>

        {/* ── 04 ÜRÜN ÖNİZLEME ── */}
        <section className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:py-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full max-w-[1120px] flex-col items-center gap-10 tb:gap-20">
            <BolumBasi hap="Ürün" beyaz="Masaüstü ve web," dim="bu sistemde" />
            <CardReveal y={64} transition={{ type: "spring", bounce: 0, delay: 0.45, duration: 0.6 }} className="w-full">
              <div className="relative w-full overflow-hidden rounded-[44px] bg-base">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-[240px]" style={{ WebkitMaskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 60%, rgba(0,0,0,0) 100%)", maskImage: "radial-gradient(50% 150% at 50% 0, rgb(0,0,0) 60%, rgba(0,0,0,0) 100%)" }}>
                  <div className="absolute inset-x-[-100px] top-[-160px] h-[320px] rounded-[100%]" style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
                </div>
                <div className="relative flex">
                  <div className="flex w-16 flex-col items-center gap-3 bg-black py-4">
                    <div className="h-10 w-10 rounded-[14px]" style={{ background: T.accent }} />
                    <div className="h-10 w-10 rounded-[14px] bg-surface-2" />
                    <div className="h-10 w-10 rounded-[14px] bg-surface-2" />
                  </div>
                  <div className="w-60 p-3">
                    <p className="px-3 pb-2 text-[12px] font-medium leading-[14.4px] tracking-[0.06em] text-text-dim">SES KANALLARI</p>
                    <div className="flex items-center gap-2 rounded-[12px] px-3 py-2" style={{ background: T.accentSoft }}>
                      <span className="text-[14px] font-medium leading-[19.6px]" style={{ color: T.accentStrong }}>🔊 akşam odası</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 rounded-[12px] px-3 py-2 transition-colors hover:bg-surface">
                      <span className="text-[14px] font-medium leading-[19.6px] text-text-secondary"># sohbet</span>
                    </div>
                    <div className="mt-4 flex items-center gap-2 px-3">
                      <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-surface-2">
                        <span className="text-[12px] text-text-primary">B</span>
                        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-base" style={{ background: T.success }} />
                      </span>
                      <span className="text-[14px] leading-[19.6px] text-text-primary">Baran</span>
                      <span className="ml-auto text-[12px] text-text-dim">%80</span>
                    </div>
                  </div>
                  <div className="flex min-h-[280px] flex-1 flex-col justify-end gap-3 bg-surface p-4">
                    <div className="max-w-[300px] rounded-[16px] bg-surface-2 px-4 py-3">
                      <p className="text-[14px] leading-[19.6px] text-text-primary">Çay hazır, oda açık.</p>
                    </div>
                    <div className="flex items-center gap-2 rounded-[16px] bg-base px-4 py-3" style={{ boxShadow: `inset 0 0 0 1px ${T.accentSoft}` }}>
                      <span className="text-[14px] leading-[19.6px] text-text-dim">Mesaj yaz…</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardReveal>
          </div>
        </section>

        {/* ── 05 HAREKET ── */}
        <section className="relative flex flex-col items-center overflow-clip px-6 py-20 tb:px-10 tb:py-[120px] dt:py-[160px]">
          <IsikSeridi />
          <div className="relative flex w-full max-w-[1120px] flex-col items-center gap-10 tb:gap-20">
            <BolumBasi hap="Hareket" beyaz="Her şey spring," dim="hiçbir şey lineer" />
            <HareketDemo />
            <p className="max-w-[640px] text-center text-[14px] leading-[19.6px] text-text-dim">
              Doküman: docs/design-system/demli-design-system.md · Onay gelmeden landing/ürün entegrasyonu yapılmaz.
            </p>
          </div>
        </section>

        <ProgressiveBlur position="top" height={120} />
        <ProgressiveBlur position="bottom" height={180} />
      </div>
    </LenisProvider>
  );
}
