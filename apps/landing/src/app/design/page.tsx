"use client";

/**
 * Demli Design System v1 "Koyu Masa" — SPEC SAYFASI (onay turu, v3).
 * Süs yok: her bölüm, landing'den çıkarılmış GERÇEK reçetenin örneği +
 * yanında ölçülü değerleri. Kaynak: docs/design-system/demli-design-system.md
 * Landing henüz değişmedi; onaydan sonra entegre edilir.
 */

import { Onest } from "next/font/google";
import { motion } from "framer-motion";
import { useState } from "react";
import { MaskIcon } from "@/components/atoms/MaskIcon";
import { ReviewCard } from "@/components/molecules/ReviewCard";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

/* ── Önerilen tokenlar — entegrasyonda packages/app-ui'ye iner ── */
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

const BOLUMLER = [
  ["renk", "01 · Renk"],
  ["tipografi", "02 · Tipografi"],
  ["bosluk", "03 · Boşluk & radius"],
  ["butonlar", "04 · Butonlar"],
  ["hap", "05 · Hap & rozet"],
  ["kart", "06 · Kartlar"],
  ["form", "07 · Form & satırlar"],
  ["durum", "08 · Durumlar"],
  ["hareket", "09 · Hareket"],
  ["esleme", "10 · Ürün eşlemesi"],
] as const;

/* ── Yapı taşları ─────────────────────────────────────────────── */

function Bolum({ id, baslik, aciklama, children }: { id: string; baslik: string; aciklama: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/[0.06] py-14">
      <h2 className={onest.className + " text-[24px] font-semibold leading-[1.15] text-white"}>{baslik}</h2>
      <p className="mt-2 max-w-[720px] text-[14px] leading-[19.6px] text-text-secondary">{aciklama}</p>
      <div className="mt-8 flex flex-col gap-10">{children}</div>
    </section>
  );
}

function Spec({ etiket, deger, children }: { etiket: string; deger: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4 tb:grid-cols-[minmax(0,1fr)_300px] tb:items-start">
      <div className="min-w-0">{children}</div>
      <div className="rounded-[12px] bg-base p-4">
        <p className="text-[13px] font-medium leading-[18px] text-text-primary">{etiket}</p>
        <p className="mt-1 whitespace-pre-line font-mono text-[12px] leading-[18px] text-text-dim">{deger}</p>
      </div>
    </div>
  );
}

function Swatch({ ad, deger, koyu, not }: { ad: string; deger: string; koyu?: boolean; not?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-16 items-end rounded-[12px] p-2.5" style={{ background: deger, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }}>
        <span className="font-mono text-[10px]" style={{ color: koyu ? "#1a1a1a" : "rgba(255,255,255,0.8)" }}>{deger}</span>
      </div>
      <p className="text-[13px] font-medium leading-[17px] text-text-primary">{ad}</p>
      {not ? <p className="text-[11px] leading-[15px] text-text-dim">{not}</p> : null}
    </div>
  );
}

/* Gerçek CTA reçetesi: radius 18, pad 16×32, metin 16/24→18/25.2, kayan hover */
function Cta({ etiket, zemin, metin, devre }: { etiket: string; zemin: string; metin: string; devre?: boolean }) {
  const cls = "whitespace-nowrap text-[16px] font-medium leading-6 tb:text-[18px] tb:leading-[25.2px]";
  return (
    <motion.a
      href="#"
      onClick={(e) => e.preventDefault()}
      initial="rest"
      animate="rest"
      whileHover={devre ? undefined : "hover"}
      className={"flex items-center justify-center rounded-[18px] px-8 py-4 " + (devre ? "opacity-40" : "")}
      style={{ background: zemin }}
    >
      <div className="relative flex h-6 flex-col items-start overflow-hidden tb:h-[25px]">
        <motion.strong variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls} style={{ color: metin }}>{etiket}</motion.strong>
        <motion.strong aria-hidden variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls + " absolute top-[29px]"} style={{ color: metin }}>{etiket}</motion.strong>
      </div>
    </motion.a>
  );
}

/* Nav sekmesi reçetesi: 14/16px, kayan kopya 23px altta */
function NavSekme({ etiket }: { etiket: string }) {
  const cls = "text-[14px] font-medium leading-[1.2] tracking-[-0.02em] text-[#e5e5e5] tb:text-[16px]";
  return (
    <motion.span initial="rest" animate="rest" whileHover="hover" className="cursor-pointer rounded-[12px] px-3 py-2">
      <span className="relative flex h-[17px] flex-col items-start overflow-hidden tb:h-[19px]">
        <motion.span variants={{ rest: { y: 0 }, hover: { y: -23 } }} transition={SPRING_HOVER} className={cls + " whitespace-pre"}>{etiket}</motion.span>
        <motion.span aria-hidden variants={{ rest: { y: 0 }, hover: { y: -23 } }} transition={SPRING_HOVER} className={cls + " absolute top-[23px] whitespace-pre"}>{etiket}</motion.span>
      </span>
    </motion.span>
  );
}

function HareketSatiri({ ad, deger, children }: { ad: string; deger: string; children: (tur: number) => React.ReactNode }) {
  const [tur, setTur] = useState(0);
  return (
    <div className="flex flex-col gap-3 rounded-[16px] bg-base p-5 tb:flex-row tb:items-center tb:gap-6">
      <button onClick={() => setTur((x) => x + 1)} className="w-fit shrink-0 rounded-[10px] bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-text-primary transition-colors hover:bg-[#303030]">
        Oynat
      </button>
      <div className="flex h-16 min-w-0 flex-1 items-center overflow-hidden">{children(tur)}</div>
      <div className="shrink-0 tb:w-[280px]">
        <p className="text-[13px] font-medium leading-[17px] text-text-primary">{ad}</p>
        <p className="mt-0.5 whitespace-pre-line font-mono text-[11px] leading-[16px] text-text-dim">{deger}</p>
      </div>
    </div>
  );
}

/* ── Sayfa ────────────────────────────────────────────────────── */

export default function DesignShowcase() {
  return (
    <div className="min-h-screen bg-black">
      {/* Üst çubuk + içindekiler */}
      <header className="sticky top-0 z-10 border-b border-white/[0.06] bg-black/85 backdrop-blur-[10px]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-5 gap-y-1 px-6 py-3">
          <span className={onest.className + " mr-2 text-[15px] font-semibold text-white"}>
            Koyu Masa<span style={{ color: T.accent }}>.</span>
            <span className="ml-2 text-[12px] font-medium text-text-dim">design system v1 · onay turu</span>
          </span>
          <nav className="flex flex-wrap gap-x-4 gap-y-1">
            {BOLUMLER.map(([id, ad]) => (
              <a key={id} href={"#" + id} className="text-[12px] font-medium text-text-dim transition-colors hover:text-text-primary">{ad.slice(5)}</a>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-6 pb-32">
        <div className="pb-4 pt-12">
          <h1 className={onest.className + " text-[40px] font-semibold leading-[1.1] tracking-[-0.2px] text-white"}>
            Demli Design System <span style={{ color: T.accent }}>v1</span>
          </h1>
          <p className="mt-3 max-w-[720px] text-[15px] leading-[22px] text-text-secondary">
            Landing&apos;den çıkarılmış tek sistem; web + masaüstü buna çekilecek. Founder kararları:
            zeminler nötr siyah · yeşil vurgu Demli mercanına döner · display font OFL (Onest önerisi) ·
            token mimarisi koyu + açık-hazır. Her örnek gerçek reçeteyle basılmıştır; değerler yanındadır.
          </p>
        </div>

        {/* 01 RENK */}
        <Bolum id="renk" baslik="01 · Renk" aciklama="İki katman: ham palet + anlamsal tokenlar. Kenar çizgisi yok — derinlik yüzey tonuyla kurulur. Açık tema geldiğinde yalnız anlamsal değerler değişir.">
          <Spec etiket="Zeminler" deger={"bg-page      #000000\nbg-base      #0d0d0d\nbg-surface   #171717\nbg-surface-2 #262626\nbg-raised    rgba(23,23,23,.72)+blur10\nbg-veil      rgba(0,0,0,.24)+blur8"}>
            <div className="grid grid-cols-3 gap-3 tb:grid-cols-6">
              <Swatch ad="bg-page" deger="#000000" not="pencere/sayfa" />
              <Swatch ad="bg-base" deger="#0d0d0d" not="kart, koyu blok" />
              <Swatch ad="bg-surface" deger="#171717" not="ikincil yüzey" />
              <Swatch ad="bg-surface-2" deger="#262626" not="buton, hover" />
              <Swatch ad="bg-raised" deger="rgba(23,23,23,0.72)" not="nav hapı (+blur)" />
              <Swatch ad="bg-veil" deger="rgba(0,0,0,0.24)" not="saydam rozet" />
            </div>
          </Spec>
          <Spec etiket="Metin rampası" deger={"display   #ffffff\nprimary   #e5e5e5\nsecondary #a3a3a3\ndim       #737373\nfaint     #404040"}>
            <div className="flex flex-col gap-1.5 rounded-[16px] bg-base p-6">
              <p className="text-[16px] text-white">text-display — büyük başlıklar</p>
              <p className="text-[16px] text-text-primary">text-primary — UI birincil</p>
              <p className="text-[16px] text-text-secondary">text-secondary — gövde</p>
              <p className="text-[16px] text-text-dim">text-dim — sönük, ikonlar</p>
              <p className="text-[16px] text-[#404040]">text-faint — telif</p>
            </div>
          </Spec>
          <Spec etiket="Vurgu — Demli mercanı" deger={"accent        #ff8464\naccent-strong #ffa48c\naccent-deep   #e8624a (basılı)\naccent-soft   12% zemin\naccent-glow   24% radyal\nKontrast: 7.4:1 (#0d0d0d)"}>
            <div className="grid grid-cols-3 gap-3 tb:grid-cols-6">
              <Swatch ad="accent" deger={T.accent} koyu not="link, aktif, parıltı" />
              <Swatch ad="accent-strong" deger={T.accentStrong} koyu not="hover" />
              <Swatch ad="accent-deep" deger={T.accentDeep} koyu not="basılı" />
              <Swatch ad="accent-soft" deger="rgba(255,132,100,0.12)" not="seçili zemin" />
              <Swatch ad="accent-glow" deger="rgba(255,132,100,0.24)" not="radyal parıltı" />
              <Swatch ad="gold" deger={T.gold} koyu not="yıldız, shimmer" />
            </div>
          </Spec>
          <Spec etiket="Durum renkleri" deger={"success/online #22c55e\ndanger         #ff6fb5\nwarn           #eab30a\ninfo           nötr gri\nKural: hata mercandan ≥30° hue\nayrı — daha kuvvetli kırmızı yasak"}>
            <div className="grid grid-cols-2 gap-3 tb:grid-cols-4">
              <Swatch ad="success / online" deger={T.success} koyu not="yeşil artık YALNIZ durum" />
              <Swatch ad="danger" deger={T.danger} koyu not="pembe — kırmızı disiplini" />
              <Swatch ad="warn" deger={T.gold} koyu not="altınla paylaşır" />
              <Swatch ad="info" deger="#a3a3a3" koyu not="nötr — mavi markaya giremez" />
            </div>
          </Spec>
        </Bolum>

        {/* 02 TİPOGRAFİ */}
        <Bolum id="tipografi" baslik="02 · Tipografi" aciklama="Display: Onest (OFL, Türkçe tam) — Stack Sans'ın lisans-temiz karşılığı; alternatifler Schibsted Grotesk, General Sans. Gövde/UI: Inter. Display'de OpenType özellikleri normal; cv setleri yalnız Inter'de.">
          <Spec etiket="Display-1 · hero" deger={"56 / 92 / 112px (m/t/d)\nlh %110 · ls −0.2px · 600\nfont: Onest"}>
            <p className={onest.className + " truncate text-[56px] font-semibold leading-[1.1] tracking-[-0.2px] text-white tb:text-[72px]"}>Çayını al, gel.</p>
          </Spec>
          <Spec etiket="Display-2 · bölüm başlığı" deger={"36 / 48 / 56px\nlh %110 · ls −0.2px · 500\niki tonlu: beyaz + dim kuyruk"}>
            <p className={onest.className + " text-[36px] font-medium leading-[1.1] tracking-[-0.2px] tb:text-[48px]"}>
              <span className="text-white">Bir akşamın hepsi </span>
              <span className="text-text-dim">tek masada</span>
            </p>
          </Spec>
          <Spec etiket="Display-3 · kart başlığı" deger={"40 / 52px · lh %110 · 400"}>
            <p className={onest.className + " text-[40px] font-normal leading-[1.1] text-white tb:text-[52px]"}>Ses bir ayar, ödül değil.</p>
          </Spec>
          <Spec etiket="Büyük açıklama" deger={"32 / 40 / 44px\nlh %120 · ls −0.02em · 400"}>
            <p className={onest.className + " text-[32px] font-normal leading-[1.2] tracking-[-0.02em] tb:text-[40px]"}>
              <span className="text-text-primary">Arkadaş grubunun sesli evi. </span>
              <span className="text-text-dim">Reklam yok, algoritma yok.</span>
            </p>
          </Spec>
          <Spec etiket="Gövde ve UI (Inter)" deger={"Gövde-L 16/24 · 18/25.2\nUI 14/19.6 · 16/19.2 (500)\nls −0.28 / −0.32px\nKüçük 12/14.4 · 14/16.8 (500)"}>
            <div className="flex flex-col gap-2 rounded-[16px] bg-base p-6">
              <p className="text-[16px] leading-6 text-text-secondary">Gövde-L — Kanal 128 kbps&apos;e kadar açık; kimse bunun için sunucu yükseltmez.</p>
              <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">UI — Odaya gir · Ekranı paylaş · Sesini ayarla</p>
              <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-text-dim">Küçük — 13 Nis 2026 · çevrimiçi 4 kişi</p>
            </div>
          </Spec>
        </Bolum>

        {/* 03 BOŞLUK & RADIUS */}
        <Bolum id="bosluk" baslik="03 · Boşluk & radius" aciklama="4'lük taban. Bölüm ritmi 80/120/160; kart içi 24/32; satır içi 8–16. Radius ölçeği landing'den ölçülü; dış gölge yok, tek istisna hap iç gölgesi.">
          <Spec etiket="Boşluk ölçeği" deger={"4 · 8 · 12 · 16 · 24 · 32\n40 · 64 · 80 · 120 · 160\nBölüm py: 80/120/160 (m/t/d)"}>
            <div className="flex flex-wrap items-end gap-3 rounded-[16px] bg-base p-6">
              {[4, 8, 12, 16, 24, 32, 40, 64, 80].map((s) => (
                <div key={s} className="flex flex-col items-center gap-1.5">
                  <div className="w-6 rounded-[3px]" style={{ height: s, background: T.accentSoft, boxShadow: `inset 0 0 0 1px ${T.accent}33` }} />
                  <span className="font-mono text-[10px] text-text-dim">{s}</span>
                </div>
              ))}
            </div>
          </Spec>
          <Spec etiket="Radius ölçeği" deger={"8 · 10 · 12 (sekme, ikon kutusu)\n16 (nav hapı) · 18 (CTA)\n24 (yorum kartı) · 32 (kart)\n44 (büyük kart) · 50 (hap)\ntam yuvarlak (avatar)"}>
            <div className="flex flex-wrap items-end gap-4 rounded-[16px] bg-base p-6">
              {[8, 12, 16, 18, 24, 32, 44].map((r) => (
                <div key={r} className="flex flex-col items-center gap-1.5">
                  <div className="h-16 w-16 bg-surface-2" style={{ borderRadius: r }} />
                  <span className="font-mono text-[10px] text-text-dim">{r}</span>
                </div>
              ))}
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-10 w-24 rounded-[50px] bg-surface-2" />
                <span className="font-mono text-[10px] text-text-dim">hap 50</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-16 w-16 rounded-full bg-surface-2" />
                <span className="font-mono text-[10px] text-text-dim">tam</span>
              </div>
            </div>
          </Spec>
          <Spec etiket="Derinlik" deger={"Dış gölge YOK.\nHap iç gölgesi:\ninset 0 -1px 0\nrgba(38,49,64,0.32)\nYüzen panel: blur(10px)"}>
            <div className="flex flex-wrap items-center gap-4 rounded-[16px] bg-base p-6">
              <div className="rounded-[50px] bg-[rgba(0,0,0,0.24)] px-5 py-2.5 text-[14px] font-medium text-text-primary backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>iç gölge imzası</div>
              <div className="rounded-[16px] bg-[rgba(23,23,23,0.72)] px-5 py-2.5 text-[14px] font-medium text-text-primary backdrop-blur-[10px]">yüzen panel (blur 10)</div>
            </div>
          </Spec>
        </Bolum>

        {/* 04 BUTONLAR */}
        <Bolum id="butonlar" baslik="04 · Butonlar" aciklama="CTA: radius 18, pad 16×32, metin 16/24 → 18/25.2 (500). Hover'da metin kayar (kopya 29px altta, spring bounce .2 / .4s). Üstlerine gel — kayma canlı.">
          <Spec etiket="CTA varyantları" deger={"birincil: #fff zemin, koyu metin\nikincil: #262626, açık metin\nmercan (YENİ): #ff8464, koyu metin\nbasılı: #e8624a · devre dışı: %40"}>
            <div className="flex flex-wrap items-center gap-4">
              <Cta etiket="Uygulamayı indir" zemin="#ffffff" metin="#171717" />
              <Cta etiket="Demli'yi aç" zemin="#262626" metin="#e5e5e5" />
              <Cta etiket="Odaya gir" zemin={T.accent} metin="#171717" />
              <Cta etiket="Devre dışı" zemin="#262626" metin="#e5e5e5" devre />
            </div>
          </Spec>
          <Spec etiket="Nav sekmesi" deger={"14/16px (m/t) · 500 · ls −0.02em\npad 8×12 · radius 12\nkayan kopya 23px altta"}>
            <div className="flex w-fit items-center gap-2 rounded-[16px] bg-[rgba(23,23,23,0.72)] p-2 backdrop-blur-[10px]">
              <NavSekme etiket="Özellikler" />
              <NavSekme etiket="Yorumlar" />
              <NavSekme etiket="GitHub" />
            </div>
          </Spec>
          <Spec etiket="İkon butonu" deger={"40×40 · radius 12 · #171717\ngrupta: kap radius 16, pad 4\nikon 22–24px #e5e5e5"}>
            <div className="flex w-fit items-center gap-1 rounded-[16px] bg-base p-1">
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface transition-colors hover:bg-surface-2"><MaskIcon name="monitor" size={22} color="#e5e5e5" /></span>
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface transition-colors hover:bg-surface-2"><MaskIcon name="phone" size={22} color="#e5e5e5" /></span>
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface transition-colors hover:bg-surface-2"><MaskIcon name="star" size={20} color="#e5e5e5" /></span>
            </div>
          </Spec>
        </Bolum>

        {/* 05 HAP & ROZET */}
        <Bolum id="hap" baslik="05 · Hap & rozet" aciklama="Saydam zemin + blur + iç gölge imzası. Shimmer yalnız altın vurgu kelimesinde.">
          <Spec etiket="Bilgi hapı" deger={"radius 50 · pad 6/6/6/18\nbg-veil + blur(8)\niç çip: beyaz %12 zemin"}>
            <div className="flex w-fit items-center gap-2 rounded-[50px] bg-[rgba(0,0,0,0.24)] py-[6px] pl-[6px] pr-[18px] backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
              <div className="flex items-center gap-1.5 rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-1">
                <MaskIcon name="star" size={12} color={T.gold} />
                <span className="text-[14px] leading-[16.8px] text-[#e5e5e5]">2</span>
              </div>
              <span className="text-[14px] font-medium leading-[16.8px] text-[#e5e5e5]">Açık kaynak</span>
              <span className="text-[14px] leading-[16.8px] tracking-[-0.28px] text-text-dim">Ücretli kademe yok</span>
            </div>
          </Spec>
          <Spec etiket="Etiket hapı (bölüm başı)" deger={"radius 50 · pad 8×12 / 12×18\nbg-base · metin 14/16 dim\nvurgu kelimesi: altın shimmer"}>
            <div className="flex w-fit items-center rounded-[50px] bg-base px-[18px] py-3" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
              <span className="text-[16px] font-medium leading-[19.2px] text-text-dim">Özellikler</span>
            </div>
          </Spec>
          <Spec etiket="Durum çipi" deger={"seçili: accent-soft zemin +\naccent-strong metin\nnötr: metin secondary"}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13px] font-medium" style={{ background: T.accentSoft, color: T.accentStrong }}>Seçili</span>
              <span className="flex items-center gap-2 rounded-[10px] bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary">Nötr</span>
              <span className="flex items-center gap-1.5 rounded-[10px] bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: T.success }} /> Çevrimiçi
              </span>
            </div>
          </Spec>
        </Bolum>

        {/* 06 KARTLAR */}
        <Bolum id="kart" baslik="06 · Kartlar" aciklama="bg-base, radius 32 (büyük 44, yorum 24), KENARSIZ. Hover'da zemin rgba(23,23,23,0.72)'ye açılır (400ms). Doku (noise, screen blend) kart reçetesinin parçasıdır.">
          <Spec etiket="Yorum kartı (gerçek bileşen)" deger={"radius 24 · pad 24 · bg #0d0d0d\nhover: rgba(23,23,23,.72) 400ms\nisim 14/19.6 · tarih 12/14.4 op.7\ngövde 16/24 op .7"}>
            <div className="max-w-[420px]">
              <ReviewCard data={{ store: "monitor", href: "#", name: "Ece", date: "13 Şub 2026", title: "Gitar gecesi kurtuldu", body: "Müzik moduna aldım, teller cızırtı olmaktan çıktı. Grup ilk kez susup dinledi." }} />
            </div>
          </Spec>
          <Spec etiket="İçerik kartı" deger={"radius 32/44 · bg #0d0d0d\ntag: 14/16 (500) accent\nbaşlık: Display-3\nmadde: check 24px dim +\n14/19.6 secondary"}>
            <div className="max-w-[560px] rounded-[32px] bg-base p-8 transition-colors duration-[400ms] hover:bg-[rgba(23,23,23,0.72)]">
              <p className="text-[14px] font-medium leading-[16.8px]" style={{ color: T.accent }}>Sesli odalar</p>
              <p className={onest.className + " mt-3 text-[28px] font-normal leading-[1.1] text-white"}>Ses bir ayar, ödül değil.</p>
              <p className="mt-3 text-[16px] leading-6 text-text-dim">Kanal 128 kbps&apos;e kadar açık; kimse bunun için sunucu yükseltmez.</p>
              <ul className="mt-5 flex flex-col gap-2">
                {["128 kbps — kanal ayarı", "Müzik modu: 256 kbps stereo"].map((b) => (
                  <li key={b} className="flex h-6 items-center gap-3">
                    <MaskIcon name="check-circle" size={24} color="#737373" />
                    <p className="text-[14px] leading-[19.6px] tracking-[-0.28px] text-text-secondary">{b}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Spec>
        </Bolum>

        {/* 07 FORM */}
        <Bolum id="form" baslik="07 · Form & satırlar" aciklama="Kenarsız dil: giriş alanı yüzeyle ayrılır, focus'ta accent-soft iç iz. Seçili satır accent-soft zemin; hover satırı surface.">
          <Spec etiket="Giriş alanı" deger={"radius 16 · pad 12×16\nrest: bg #0d0d0d\nfocus: inset 0 0 0 1px accent-soft\nplaceholder: dim"}>
            <div className="flex max-w-[420px] flex-col gap-3">
              <div className="rounded-[16px] bg-base px-4 py-3 text-[14px] leading-[19.6px] text-text-dim">Mesaj yaz… (rest)</div>
              <div className="rounded-[16px] bg-base px-4 py-3 text-[14px] leading-[19.6px] text-text-primary" style={{ boxShadow: `inset 0 0 0 1px ${T.accentSoft}` }}>Mesaj yaz… (focus)</div>
            </div>
          </Spec>
          <Spec etiket="Liste satırı" deger={"radius 12 · pad 8×12\nseçili: accent-soft +\naccent-strong metin\nhover: bg-surface"}>
            <div className="flex max-w-[300px] flex-col gap-1 rounded-[16px] bg-base p-2">
              <div className="flex items-center gap-2 rounded-[12px] px-3 py-2" style={{ background: T.accentSoft }}>
                <span className="text-[14px] font-medium leading-[19.6px]" style={{ color: T.accentStrong }}>🔊 akşam odası</span>
              </div>
              <div className="flex items-center gap-2 rounded-[12px] px-3 py-2 transition-colors hover:bg-surface">
                <span className="text-[14px] font-medium leading-[19.6px] text-text-secondary"># sohbet</span>
              </div>
              <div className="flex items-center gap-2 rounded-[12px] px-3 py-2 transition-colors hover:bg-surface">
                <span className="text-[14px] font-medium leading-[19.6px] text-text-secondary"># oyun</span>
              </div>
            </div>
          </Spec>
          <Spec etiket="Açılır menü" deger={"radius 12 · pad 4\nbg rgba(23,23,23,.92)+blur(10)\nöğe: radius 8, pad 8×12\naktif: check accent"}>
            <div className="w-fit rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px]">
              <div className="flex w-[150px] items-center justify-between rounded-[8px] px-3 py-2 text-[14px] font-medium text-[#e5e5e5]">
                Türkçe
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="m3 7.5 2.5 2.5L11 4.5" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
              <div className="flex w-[150px] items-center rounded-[8px] px-3 py-2 text-[14px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-[#e5e5e5]">English</div>
            </div>
          </Spec>
        </Bolum>

        {/* 08 DURUMLAR */}
        <Bolum id="durum" baslik="08 · Durumlar" aciklama="Yeşil yalnız çevrimiçi/başarı. Hata pembe (#ff6fb5) — mercandan ≥30° hue ayrımı zorunlu; hata durumunda espri ve ünlem yok (copy-voice).">
          <Spec etiket="Durum örnekleri" deger={"online nokta: 12px + 2px kenar\nhata metni: danger, düz ton\nuyarı: gold\nbaşarı: success"}>
            <div className="flex max-w-[560px] flex-col gap-3 rounded-[16px] bg-base p-6">
              <div className="flex items-center gap-2">
                <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-[12px] text-text-primary">B<span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-base" style={{ background: T.success }} /></span>
                <span className="text-[14px] leading-[19.6px] text-text-primary">Baran çevrimiçi</span>
              </div>
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.danger }}>Bağlantı koptu. Oda yeniden bağlanıyor; bağlanamazsa mikrofonun kapalı kalır.</p>
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.gold }}>Mikrofon izni bekleniyor.</p>
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.success }}>Ekran paylaşımı başladı.</p>
            </div>
          </Spec>
        </Bolum>

        {/* 09 HAREKET */}
        <Bolum id="hareket" baslik="09 · Hareket" aciklama="Her şey spring, hiçbir şey lineer kaymaz. Pazarlama reveal'leri ürüne taşınmaz; üründe mikro hareket (hover kayması, panel geçişi 150–250ms). Landing'de reveal'ler çift yönlü (founder kararı).">
          <HareketSatiri ad="Kart reveal" deger={"y64→0 + opacity\nspring damping 60, stiffness 500\nkademe ~120ms"}>
            {(tur) => (
              <div className="flex gap-3">
                {[0, 1, 2].map((i) => (
                  <motion.div key={tur + "-" + i} initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1, delay: 0.1 + i * 0.12 }} className="h-12 w-20 rounded-[12px] bg-surface-2" />
                ))}
              </div>
            )}
          </HareketSatiri>
          <HareketSatiri ad="Kelime blur kademesi" deger={"blur(10px)+y10 → 0\n0.5s · ~70ms/adım · power2.out"}>
            {(tur) => (
              <div className="flex gap-[6px]">
                {["Çayını", "al,", "gel."].map((k, i) => (
                  <motion.span key={tur + "-" + i} initial={{ opacity: 0, y: 10, filter: "blur(10px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.5, ease: "easeOut", delay: 0.15 + i * 0.07 }} className={onest.className + " text-[28px] font-medium text-white"}>{k}</motion.span>
                ))}
              </div>
            )}
          </HareketSatiri>
          <HareketSatiri ad="Hover kayan metin" deger={"kopya 23/29px altta\nspring bounce .2 · 0.4s\n(butonlar bölümünde canlı)"}>
            {() => (
              <motion.span initial="rest" animate="rest" whileHover="hover" className="cursor-pointer rounded-[12px] bg-surface-2 px-4 py-2">
                <span className="relative flex h-6 flex-col items-start overflow-hidden">
                  <motion.span variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className="text-[16px] font-medium leading-6 text-text-primary">Üstüme gel</motion.span>
                  <motion.span aria-hidden variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className="absolute top-[29px] text-[16px] font-medium leading-6 text-text-primary">Üstüme gel</motion.span>
                </span>
              </motion.span>
            )}
          </HareketSatiri>
          <div className="rounded-[12px] bg-base p-4">
            <p className="font-mono text-[12px] leading-[18px] text-text-dim">
              Diğer ölçülü değerler: başlık blok reveal spring bounce .3 / 3s (threshold .5) · yüzen CTA y120↔0 bounce .2 / 2s · parıltı salınımı 0→380→0 (7017ms hero, 4017ms footer, ease [.44,0,.56,1]) · telefon parallax scroll-bağlı çift yönlü — bunlar LANDING&apos;e özgüdür, ürüne taşınmaz.
            </p>
          </div>
        </Bolum>

        {/* 10 ÜRÜN EŞLEMESİ */}
        <Bolum id="esleme" baslik="10 · Ürün eşlemesi" aciklama="Entegrasyonda --tc-* adları korunur, değerler bu sisteme çekilir — web (Tailwind v3) + desktop (v4) aynı dosyadan beslenmeye devam eder. Sıcak 'Demli Voice v2' rampası emekli olur.">
          <Spec etiket="Token eşleme tablosu" deger={"tek kaynak:\npackages/app-ui/tokens.css"}>
            <div className="overflow-x-auto rounded-[16px] bg-base p-6">
              <table className="w-full text-left text-[13px] leading-[18px]">
                <thead>
                  <tr className="text-text-dim">
                    <th className="pb-2 pr-6 font-medium">Ürün (--tc-*)</th>
                    <th className="pb-2 pr-6 font-medium">Yeni değer</th>
                    <th className="pb-2 font-medium">Eski (emekli)</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[12px]">
                  {[
                    ["--tc-rail", "#000000", "#0c0403"],
                    ["--tc-app", "#0d0d0d", "#1a0806"],
                    ["--tc-surface", "#171717", "#241009"],
                    ["--tc-raised", "#262626", "#2e130b"],
                    ["--tc-selected", "rgba(255,132,100,.12)", "#3a241b"],
                    ["--tc-accent", "#ff8464", "(yeni)"],
                  ].map(([a, b, c]) => (
                    <tr key={a} className="border-t border-white/[0.05]">
                      <td className="py-2 pr-6 text-text-primary">{a}</td>
                      <td className="py-2 pr-6" style={{ color: T.accentStrong }}>{b}</td>
                      <td className="py-2 text-text-dim">{c}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Spec>
          <Spec etiket="Uygulama önizlemesi" deger={"rail: bg-page\npanel: bg-base\nsohbet: bg-surface\nseçili: accent-soft\nçevrimiçi: success"}>
            <div className="overflow-hidden rounded-[24px] bg-base" style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)" }}>
              <div className="flex">
                <div className="flex w-14 flex-col items-center gap-2.5 bg-black py-3">
                  <div className="h-9 w-9 rounded-[13px]" style={{ background: T.accent }} />
                  <div className="h-9 w-9 rounded-[13px] bg-surface-2" />
                </div>
                <div className="w-52 p-2.5">
                  <p className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.06em] text-text-dim">SES KANALLARI</p>
                  <div className="rounded-[12px] px-2.5 py-1.5" style={{ background: T.accentSoft }}>
                    <span className="text-[13px] font-medium" style={{ color: T.accentStrong }}>🔊 akşam odası</span>
                  </div>
                  <div className="mt-0.5 rounded-[12px] px-2.5 py-1.5"><span className="text-[13px] font-medium text-text-secondary"># sohbet</span></div>
                </div>
                <div className="flex min-h-[150px] flex-1 flex-col justify-end gap-2 bg-surface p-3">
                  <div className="max-w-[220px] rounded-[14px] bg-surface-2 px-3 py-2"><p className="text-[13px] text-text-primary">Çay hazır, oda açık.</p></div>
                  <div className="rounded-[14px] bg-base px-3 py-2" style={{ boxShadow: `inset 0 0 0 1px ${T.accentSoft}` }}><span className="text-[13px] text-text-dim">Mesaj yaz…</span></div>
                </div>
              </div>
            </div>
          </Spec>
        </Bolum>

        <p className="border-t border-white/[0.06] pt-6 text-[13px] leading-[18px] text-[#404040]">
          Doküman: docs/design-system/demli-design-system.md · Onay gelmeden landing/ürün entegrasyonu yapılmaz.
        </p>
      </main>
    </div>
  );
}
