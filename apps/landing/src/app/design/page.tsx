"use client";

/**
 * Demli Design System v1 "Koyu Masa" — CANLI SHOWCASE (onay turu).
 * Bu sayfa ÖNERİLEN sistemi basar: nötr siyah zeminler + mercan vurgu
 * (yeşilin yerini alır) + Onest display (Stack Sans'ın OFL karşılığı).
 * Landing'in kendisi henüz DEĞİŞMEDİ — onaydan sonra entegre edilir.
 * Değerlerin kaynağı: docs/design-system/demli-design-system.md
 */

import { Onest } from "next/font/google";
import { motion } from "framer-motion";
import { useState } from "react";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

/* ── Önerilen tokenlar (showcase içinde sabit; entegrasyonda token dosyasına iner) ── */
const T = {
  page: "#000000",
  base: "#0d0d0d",
  surface: "#171717",
  surface2: "#262626",
  raised: "rgba(23,23,23,0.72)",
  veil: "rgba(0,0,0,0.24)",
  display: "#ffffff",
  primary: "#e5e5e5",
  secondary: "#a3a3a3",
  dim: "#737373",
  faint: "#404040",
  accent: "#ff8464",
  accentStrong: "#ffa48c",
  accentDeep: "#e8624a",
  accentSoft: "rgba(255,132,100,0.12)",
  accentGlow: "rgba(255,132,100,0.24)",
  gold: "#eab30a",
  success: "#22c55e",
  danger: "#ff6fb5",
};

const SPRING_HOVER = { type: "spring", bounce: 0.2, duration: 0.4 } as const;
const SPRING_REVEAL = { type: "spring", damping: 60, stiffness: 500, mass: 1 } as const;

function Bolum({ no, ad, aciklama, children }: { no: string; ad: string; aciklama?: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 py-16">
      <p className="text-[12px] font-medium tracking-[0.08em]" style={{ color: T.accent }}>{no}</p>
      <h2 className={onest.className + " mt-2 text-[32px] font-medium leading-[1.1]"} style={{ color: T.display }}>{ad}</h2>
      {aciklama ? <p className="mt-2 max-w-[640px] text-[14px] leading-[19.6px]" style={{ color: T.secondary }}>{aciklama}</p> : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}

function Renk({ ad, deger, metinKoyu }: { ad: string; deger: string; metinKoyu?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-20 items-end rounded-[16px] p-3"
        style={{ background: deger, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
      >
        <span className="text-[11px] font-medium" style={{ color: metinKoyu ? "#1a1a1a" : "rgba(255,255,255,0.85)" }}>{deger}</span>
      </div>
      <p className="text-[13px] font-medium" style={{ color: T.primary }}>{ad}</p>
    </div>
  );
}

function KayanMetin({ etiket, koyu }: { etiket: string; koyu?: boolean }) {
  const cls = "whitespace-nowrap text-[16px] font-medium leading-6";
  const renk = koyu ? "#171717" : T.primary;
  return (
    <div className="relative flex h-6 flex-col items-start overflow-hidden">
      <motion.span variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls} style={{ color: renk }}>{etiket}</motion.span>
      <motion.span aria-hidden variants={{ rest: { y: 0 }, hover: { y: -29 } }} transition={SPRING_HOVER} className={cls + " absolute top-[29px]"} style={{ color: renk }}>{etiket}</motion.span>
    </div>
  );
}

function Buton({ etiket, tur }: { etiket: string; tur: "birincil" | "ikincil" | "vurgulu" }) {
  const zemin = tur === "birincil" ? "#ffffff" : tur === "ikincil" ? T.surface2 : T.accent;
  return (
    <motion.button initial="rest" animate="rest" whileHover="hover" className="rounded-[18px] px-8 py-4" style={{ background: zemin }}>
      <KayanMetin etiket={etiket} koyu={tur !== "ikincil"} />
    </motion.button>
  );
}

function RevealDemo() {
  const [tur, setTur] = useState(0);
  return (
    <div className="flex flex-col items-start gap-4">
      <button
        onClick={() => setTur((x) => x + 1)}
        className="rounded-[12px] px-3 py-2 text-[14px] font-medium"
        style={{ background: T.surface2, color: T.primary }}
      >
        Yeniden oynat
      </button>
      <div className="flex gap-4">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={tur + "-" + i}
            initial={{ opacity: 0, y: 64 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING_REVEAL, delay: 0.45 + i * 0.12 }}
            className="h-24 w-36 rounded-[24px]"
            style={{ background: T.base, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.05)" }}
          >
            <div className="m-4 h-2 w-16 rounded-full" style={{ background: T.surface2 }} />
            <div className="mx-4 h-2 w-24 rounded-full" style={{ background: T.surface }} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export default function DesignShowcase() {
  return (
    <div style={{ background: T.page, minHeight: "100vh" }}>
      {/* Başlık */}
      <header className="mx-auto w-full max-w-[1120px] px-6 pb-4 pt-20">
        <div
          className="inline-flex items-center gap-2 rounded-[50px] px-4 py-2 backdrop-blur-[8px]"
          style={{ background: T.veil, boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: T.accent }} />
          <span className="text-[14px] font-medium" style={{ color: T.primary }}>Demli Design System v1 — Koyu Masa · ONAY TURU</span>
        </div>
        <h1 className={onest.className + " mt-6 text-[56px] font-semibold leading-[1.1] tb:text-[92px]"} style={{ color: T.display }}>
          Koyu Masa<span style={{ color: T.accent }}>.</span>
        </h1>
        <p className="mt-4 max-w-[640px] text-[16px] leading-6" style={{ color: T.secondary }}>
          Nötr siyah zeminler landing&apos;den birebir; yeşilin yerini Demli mercanı aldı.
          Display font önerisi: Onest (OFL) — bu sayfadaki tüm başlıklar onunla basıldı.
        </p>
      </header>

      <Bolum no="01" ad="Zeminler" aciklama="Kenar çizgisi yok — derinlik yüzey tonuyla kurulur. Ürün eşlemesi: rail→page, app→base, panel→surface, popover→surface-2.">
        <div className="grid grid-cols-2 gap-4 tb:grid-cols-6">
          <Renk ad="bg-page" deger={T.page} />
          <Renk ad="bg-base" deger={T.base} />
          <Renk ad="bg-surface" deger={T.surface} />
          <Renk ad="bg-surface-2" deger={T.surface2} />
          <Renk ad="bg-raised (+blur)" deger={T.raised} />
          <Renk ad="bg-veil" deger={T.veil} />
        </div>
      </Bolum>

      <Bolum no="02" ad="Metin rampası">
        <div className="flex flex-col gap-3 rounded-[32px] p-8" style={{ background: T.base }}>
          <p className="text-[18px]" style={{ color: T.display }}>text-display — Büyük başlıklar (#ffffff)</p>
          <p className="text-[16px]" style={{ color: T.primary }}>text-primary — UI birincil metin (#e5e5e5)</p>
          <p className="text-[16px]" style={{ color: T.secondary }}>text-secondary — İkincil metin, gövde (#a3a3a3)</p>
          <p className="text-[16px]" style={{ color: T.dim }}>text-dim — Sönük metin, ikonlar (#737373)</p>
          <p className="text-[16px]" style={{ color: T.faint }}>text-faint — Telif, en silik (#404040)</p>
        </div>
      </Bolum>

      <Bolum no="03" ad="Vurgu — Demli mercanı" aciklama="Yeşil marka vurgusu olmaktan çıktı; yalnız çevrimiçi/başarı durumu olarak yaşıyor. Hata rengi mercandan ≥30° ayrı (pembe) — kırmızı disiplini.">
        <div className="grid grid-cols-2 gap-4 tb:grid-cols-6">
          <Renk ad="accent" deger={T.accent} metinKoyu />
          <Renk ad="accent-strong" deger={T.accentStrong} metinKoyu />
          <Renk ad="accent-deep" deger={T.accentDeep} metinKoyu />
          <Renk ad="gold (yıldız)" deger={T.gold} metinKoyu />
          <Renk ad="success / online" deger={T.success} metinKoyu />
          <Renk ad="danger" deger={T.danger} metinKoyu />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <div className="relative flex h-40 w-72 items-center justify-center overflow-hidden rounded-[32px]" style={{ background: T.base }}>
            <div className="absolute inset-x-[-60px] inset-y-0 rounded-[100%] opacity-70" style={{ background: `radial-gradient(50% 50%, ${T.accentGlow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
            <p className="relative text-[14px] font-medium" style={{ color: T.primary }}>accent-glow — parıltı (eski yeşilin yerine)</p>
          </div>
          <div className="flex items-center gap-3 rounded-[16px] px-4 py-3" style={{ background: T.accentSoft }}>
            <span className="h-2 w-2 rounded-full" style={{ background: T.accent }} />
            <span className="text-[14px] font-medium" style={{ color: T.accentStrong }}>accent-soft — seçili satır zemini</span>
          </div>
        </div>
      </Bolum>

      <Bolum no="04" ad="Tipografi" aciklama="Display: Onest (OFL, Türkçe karakter tam). Gövde/UI: Inter. Beğenmezsen alternatif: Schibsted Grotesk, General Sans.">
        <div className="flex flex-col gap-8 rounded-[32px] p-8" style={{ background: T.base }}>
          <div>
            <p className="mb-2 text-[12px]" style={{ color: T.dim }}>Display-1 · 56/92/112 · %110 · −0.2px · 600</p>
            <p className={onest.className + " text-[56px] font-semibold leading-[1.1] tracking-[-0.2px]"} style={{ color: T.display }}>Çayını al, gel.</p>
          </div>
          <div>
            <p className="mb-2 text-[12px]" style={{ color: T.dim }}>Display-2 · 36/48/56 · iki tonlu</p>
            <p className={onest.className + " text-[36px] font-medium leading-[1.1] tracking-[-0.2px]"}>
              <span style={{ color: T.display }}>Bir akşamın hepsi </span>
              <span style={{ color: T.dim }}>tek masada</span>
            </p>
          </div>
          <div>
            <p className="mb-2 text-[12px]" style={{ color: T.dim }}>Büyük açıklama · 32/40/44 · %120 · −0.02em</p>
            <p className={onest.className + " text-[32px] leading-[1.2] tracking-[-0.02em]"}>
              <span style={{ color: T.primary }}>Arkadaş grubunun sesli evi. </span>
              <span style={{ color: T.dim }}>Reklam yok, algoritma yok.</span>
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="mb-1 text-[12px]" style={{ color: T.dim }}>Gövde-L 16/24 · UI 14/19.6 · Küçük 12/14.4 (Inter)</p>
            <p className="text-[16px] leading-6" style={{ color: T.secondary }}>Gövde: Kanal 128 kbps&apos;e kadar açık; kimse bunun için sunucu yükseltmez.</p>
            <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.primary }}>UI metni: Odaya gir · Ekranı paylaş · Sesini ayarla</p>
            <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px]" style={{ color: T.dim }}>Küçük: 13 Nis 2026 · çevrimiçi 4 kişi</p>
          </div>
        </div>
      </Bolum>

      <Bolum no="05" ad="Radius ölçeği" aciklama="8 · 12 · 16 · 18 · 24 · 32 · 44 · 50(hap) · tam yuvarlak.">
        <div className="flex flex-wrap items-end gap-4">
          {[8, 12, 16, 18, 24, 32, 44].map((r) => (
            <div key={r} className="flex flex-col items-center gap-2">
              <div className="h-20 w-20" style={{ background: T.surface2, borderRadius: r }} />
              <span className="text-[12px]" style={{ color: T.dim }}>{r}</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2">
            <div className="h-12 w-28 rounded-[50px]" style={{ background: T.surface2 }} />
            <span className="text-[12px]" style={{ color: T.dim }}>hap 50</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="h-20 w-20 rounded-full" style={{ background: T.surface2 }} />
            <span className="text-[12px]" style={{ color: T.dim }}>tam</span>
          </div>
        </div>
      </Bolum>

      <Bolum no="06" ad="Butonlar" aciklama="Radius 18, pad 16×32, hover'da kayan metin (spring bounce .2 / .4s). Yeni: mercan zeminli vurgulu buton. Üstlerine gel — kayma canlı.">
        <div className="flex flex-wrap items-center gap-4">
          <Buton etiket="Uygulamayı indir" tur="birincil" />
          <Buton etiket="Demli'yi aç" tur="ikincil" />
          <Buton etiket="Odaya gir" tur="vurgulu" />
        </div>
      </Bolum>

      <Bolum no="07" ad="Kartlar ve yüzey dili" aciklama="Kenar yok; hover'da zemin yarım ton açılır (yorum kartı deseni).">
        <div className="grid gap-4 tb:grid-cols-2">
          <div className="rounded-[32px] p-8 transition-colors duration-[400ms]" style={{ background: T.base }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(23,23,23,0.72)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = T.base)}>
            <p className="text-[14px] font-medium" style={{ color: T.accent }}>Sesli odalar</p>
            <p className={onest.className + " mt-3 text-[28px] leading-[1.1]"} style={{ color: T.display }}>Ses bir ayar, ödül değil.</p>
            <p className="mt-3 text-[14px] leading-[19.6px]" style={{ color: T.dim }}>Kart: bg-base · radius 32 · hover rgba(23,23,23,0.72) · kenarsız</p>
          </div>
          <div className="rounded-[24px] p-6" style={{ background: T.base }}>
            <div className="flex items-center gap-[10px]">
              <div className="flex h-12 w-12 items-center justify-center rounded-[13px]" style={{ background: "#1a1a1a" }}>
                <span className="text-[16px]" style={{ color: T.primary }}>D</span>
              </div>
              <div>
                <p className="text-[14px] font-medium leading-[19.6px]" style={{ color: T.primary }}>Ece</p>
                <p className="text-[12px] font-medium leading-[14.4px] opacity-70" style={{ color: T.secondary }}>13 Şub 2026</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-1">
              {[...Array(5)].map((_, i) => (
                <span key={i} className="text-[13px]" style={{ color: T.gold }}>★</span>
              ))}
            </div>
            <p className="mt-2 text-[16px] font-medium leading-6" style={{ color: T.display }}>Gitar gecesi kurtuldu</p>
            <p className="mt-1 text-[16px] leading-6 opacity-70" style={{ color: T.secondary }}>Müzik moduna aldım, teller cızırtı olmaktan çıktı.</p>
          </div>
        </div>
      </Bolum>

      <Bolum no="08" ad="Ürün öğeleri (web + masaüstü önizleme)" aciklama="Yeni tokenlarla ürün UI'ının çekirdek desenleri: seçili satır, giriş alanı, çevrimiçi durum.">
        <div className="overflow-hidden rounded-[32px]" style={{ background: T.base }}>
          <div className="flex">
            <div className="flex w-16 flex-col items-center gap-3 py-4" style={{ background: T.page }}>
              {[T.accent, T.surface2, T.surface2].map((c, i) => (
                <div key={i} className="h-10 w-10 rounded-[14px]" style={{ background: c }} />
              ))}
            </div>
            <div className="w-56 p-3" style={{ background: T.base }}>
              <p className="px-3 pb-2 text-[12px] font-medium tracking-[0.06em]" style={{ color: T.dim }}>SES KANALLARI</p>
              <div className="flex items-center gap-2 rounded-[12px] px-3 py-2" style={{ background: T.accentSoft }}>
                <span className="text-[14px] font-medium" style={{ color: T.accentStrong }}>🔊 akşam odası</span>
              </div>
              <div className="mt-1 flex items-center gap-2 rounded-[12px] px-3 py-2">
                <span className="text-[14px] font-medium" style={{ color: T.secondary }}># sohbet</span>
              </div>
              <div className="mt-4 flex items-center gap-2 px-3">
                <span className="relative flex h-8 w-8 items-center justify-center rounded-full" style={{ background: T.surface2 }}>
                  <span className="text-[12px]" style={{ color: T.primary }}>B</span>
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2" style={{ background: T.success, borderColor: T.base }} />
                </span>
                <span className="text-[14px]" style={{ color: T.primary }}>Baran</span>
                <span className="ml-auto text-[12px]" style={{ color: T.dim }}>%80</span>
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-end gap-3 p-4" style={{ background: T.surface }}>
              <div className="max-w-[280px] rounded-[16px] px-4 py-3" style={{ background: T.surface2 }}>
                <p className="text-[14px] leading-[19.6px]" style={{ color: T.primary }}>Çay hazır, oda açık.</p>
              </div>
              <div className="flex items-center gap-2 rounded-[16px] px-4 py-3" style={{ background: T.base, boxShadow: `inset 0 0 0 1px ${T.accentSoft}` }}>
                <span className="text-[14px]" style={{ color: T.dim }}>Mesaj yaz… (giriş alanı — focus izi accent-soft)</span>
              </div>
            </div>
          </div>
        </div>
      </Bolum>

      <Bolum no="09" ad="Hareket" aciklama="Authored spring'ler landing'den: reveal {damping 60, stiffness 500}, kademe 120ms. Pazarlama reveal'leri ürüne taşınmaz; üründe mikro hareket.">
        <RevealDemo />
      </Bolum>

      <footer className="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-8">
        <p className="text-[14px] leading-[19.6px]" style={{ color: T.faint }}>
          Doküman: docs/design-system/demli-design-system.md · Onay gelmeden landing/ürün entegrasyonu yapılmaz.
        </p>
      </footer>
    </div>
  );
}
