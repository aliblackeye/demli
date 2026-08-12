"use client";

/**
 * Demli Design System v1 "Koyu Masa" — SPEC SAYFASI (onay turu, v5).
 * Ürün bileşen kütüphanesi: profil kartına kadar her bileşen, landing'in
 * dilinden doğan ÖZGÜN reçetelerle. Kayan metin hover'ı YALNIZ landing'de
 * kalır — ürün bileşenlerinde kullanılmaz (founder kararı).
 * Kaynak doküman: docs/design-system/demli-design-system.md
 */

import { Onest } from "next/font/google";
import { motion } from "framer-motion";
import { useState } from "react";
import { MaskIcon } from "@/components/atoms/MaskIcon";

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
  dangerSoft: "rgba(255,111,181,0.12)",
};

const BOLUMLER = [
  ["renk", "Renk"],
  ["tipografi", "Tipografi"],
  ["bosluk", "Boşluk"],
  ["butonlar", "Butonlar"],
  ["hap", "Hap & rozet"],
  ["kart", "Kartlar"],
  ["form", "Form"],
  ["validasyon", "Validasyon"],
  ["satirlar", "Satırlar"],
  ["kiplikler", "Kiplikler"],
  ["kaplamalar", "Kaplamalar"],
  ["ayarlar", "Ayarlar"],
  ["profil", "Profil"],
  ["durum", "Durumlar"],
  ["hareket", "Hareket"],
  ["esleme", "Uygulama"],
] as const;

/* ── Sayfa yapı taşları ───────────────────────────────────────── */

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

/* ── ÜRÜN BİLEŞENLERİ — kayan metin YOK; hover = ton geçişi 200ms ── */

type ButonTur = "birincil" | "ikincil" | "mercan" | "tehlike" | "hayalet";
type ButonBoy = "lg" | "md" | "sm";

function UrunButonu({ etiket, tur = "ikincil", boy = "md", devre, ikon }: { etiket: string; tur?: ButonTur; boy?: ButonBoy; devre?: boolean; ikon?: React.ReactNode }) {
  const boyCls = boy === "lg" ? "rounded-[14px] px-5 py-3 text-[15px] leading-[20px]" : boy === "sm" ? "rounded-[10px] px-3 py-1.5 text-[13px] leading-[17px]" : "rounded-[12px] px-4 py-2.5 text-[14px] leading-[18px]";
  const stil: Record<ButonTur, [string, string, string]> = {
    birincil: ["#ffffff", "#171717", "#e5e5e5"],
    ikincil: ["#262626", "#e5e5e5", "#303030"],
    mercan: [T.accent, "#171717", T.accentStrong],
    tehlike: [T.dangerSoft, T.danger, "rgba(255,111,181,0.2)"],
    hayalet: ["transparent", "#a3a3a3", "#171717"],
  };
  const [zemin, metin, hoverZemin] = stil[tur];
  return (
    <button
      disabled={devre}
      className={"flex items-center gap-2 font-medium transition-colors duration-200 " + boyCls + (devre ? " cursor-not-allowed opacity-40" : "")}
      style={{ background: zemin, color: metin }}
      onMouseEnter={(e) => { if (!devre) e.currentTarget.style.background = hoverZemin; }}
      onMouseLeave={(e) => { if (!devre) e.currentTarget.style.background = zemin; }}
    >
      {ikon}
      {etiket}
    </button>
  );
}

function IkonButonu({ ikon, aktif, boyut = 40 }: { ikon: string; aktif?: boolean; boyut?: number }) {
  return (
    <span
      className="flex cursor-pointer items-center justify-center rounded-[12px] transition-colors duration-200"
      style={{ width: boyut, height: boyut, background: aktif ? T.accentSoft : "#171717" }}
      onMouseEnter={(e) => { if (!aktif) e.currentTarget.style.background = "#262626"; }}
      onMouseLeave={(e) => { if (!aktif) e.currentTarget.style.background = "#171717"; }}
    >
      <MaskIcon name={ikon} size={Math.round(boyut * 0.5)} color={aktif ? T.accentStrong : "#e5e5e5"} />
    </span>
  );
}

function Anahtar({ acikMi, degistir }: { acikMi: boolean; degistir: () => void }) {
  return (
    <button
      onClick={degistir}
      className="relative h-6 w-11 rounded-full transition-colors duration-200"
      style={{ background: acikMi ? T.accent : "#262626" }}
    >
      <motion.span
        animate={{ x: acikMi ? 22 : 2 }}
        transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1 }}
        className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white"
        style={{ left: 0 }}
      />
    </button>
  );
}

function SesSurgusu({ ad, oran }: { ad: string; oran: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
      <div className="relative h-1 flex-1 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: oran + "%", background: T.accent }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${oran}% - 7px)`, boxShadow: "rgb(13,13,13) 0 0 0 2px" }} />
      </div>
      <span className="w-12 shrink-0 rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-center text-[12px] font-medium leading-[16px] text-[#e5e5e5]">%{oran}</span>
    </div>
  );
}

function AramaAlani() {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] bg-surface px-3.5 py-2.5 transition-colors duration-200 focus-within:bg-surface-2">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
        <circle cx="6.5" cy="6.5" r="4.5" stroke="#737373" strokeWidth="1.5" />
        <path d="m10 10 3 3" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="text-[14px] leading-[19.6px] text-text-dim">Mesajlarda ara…</span>
    </div>
  );
}

function SecimKutusu() {
  return (
    <div className="flex w-fit flex-col gap-2">
      <div className="flex w-[220px] cursor-pointer items-center justify-between rounded-[12px] bg-surface px-3.5 py-2.5 transition-colors duration-200 hover:bg-surface-2">
        <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">1080p · 60 kare</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div className="w-[220px] rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px]">
        {["720p · 30 kare", "1080p · 30 kare"].map((s) => (
          <div key={s} className="rounded-[8px] px-3 py-2 text-[14px] font-medium leading-[19.6px] text-text-secondary transition-colors duration-200 hover:bg-surface-2 hover:text-[#e5e5e5]">{s}</div>
        ))}
        <div className="flex items-center justify-between rounded-[8px] px-3 py-2 text-[14px] font-medium leading-[19.6px] text-[#e5e5e5]">
          1080p · 60 kare
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="m3 7.5 2.5 2.5L11 4.5" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
      </div>
    </div>
  );
}

function Composer({ odak }: { odak?: boolean }) {
  return (
    <div
      className="flex items-center gap-3 rounded-[18px] py-4 pl-6 pr-3"
      style={{
        background: odak ? "#303030" : "#262626",
        boxShadow: odak ? "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" : undefined,
      }}
    >
      <span className={"flex-1 text-[16px] leading-6 " + (odak ? "text-text-primary" : "text-text-dim")}>
        {odak ? "Çay hazır, oda a" : "Mesaj yaz…"}
        {odak ? <span className="ml-[1px] inline-block h-[18px] w-[2px] translate-y-[3px] rounded-full" style={{ background: T.accent }} /> : null}
      </span>
      <IkonButonu ikon="arrow-circle-down" aktif={odak} />
    </div>
  );
}

function UrunSatiri({ etiket, secili }: { etiket: string; secili?: boolean }) {
  return (
    <div
      className="flex cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2.5 transition-colors duration-200"
      style={{ background: secili ? T.accentSoft : "transparent" }}
      onMouseEnter={(e) => { if (!secili) e.currentTarget.style.background = "#171717"; }}
      onMouseLeave={(e) => { if (!secili) e.currentTarget.style.background = "transparent"; }}
    >
      <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: secili ? T.accentStrong : "#a3a3a3" }}>{etiket}</span>
    </div>
  );
}

function AvatarKume({ adlar, boyut = 24 }: { adlar: string[]; boyut?: number }) {
  return (
    <span className="flex items-center">
      {adlar.map((a, i) => (
        <span
          key={a}
          className="flex items-center justify-center rounded-[1000px] bg-surface-2 font-medium text-text-primary"
          style={{ width: boyut, height: boyut, fontSize: boyut * 0.42, marginLeft: i > 0 ? -(boyut * 0.3) : 0, boxShadow: "rgb(13, 13, 13) 0px 0px 0px 2px" }}
        >
          {a[0]}
        </span>
      ))}
    </span>
  );
}

function Avatar({ ad, boyut = 32, cevrimici, konusuyor }: { ad: string; boyut?: number; cevrimici?: boolean; konusuyor?: boolean }) {
  const nokta = Math.max(10, Math.round(boyut * 0.3));
  return (
    <span
      className="relative flex shrink-0 items-center justify-center rounded-[1000px] bg-surface-2 font-medium text-text-primary"
      style={{ width: boyut, height: boyut, fontSize: Math.round(boyut * 0.38), boxShadow: konusuyor ? `rgb(13,13,13) 0 0 0 2px, ${T.accent} 0 0 0 4px` : "rgb(13,13,13) 0 0 0 2px" }}
    >
      {ad[0]}
      {cevrimici ? <span className="absolute rounded-full border-2 border-base" style={{ width: nokta, height: nokta, right: -2, bottom: -2, background: T.success }} /> : null}
    </span>
  );
}

function UyeSatiri({ ad, oran }: { ad: string; oran: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] px-3 py-2 transition-colors duration-200 hover:bg-surface">
      <Avatar ad={ad} cevrimici />
      <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
      <span className="ml-auto rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{oran}</span>
    </div>
  );
}

function AyarSatiri({ baslik, aciklama, acikMi, degistir }: { baslik: string; aciklama: string; acikMi: boolean; degistir: () => void }) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-[16px] px-4 py-3.5 transition-colors duration-200 hover:bg-surface">
      <div className="min-w-0">
        <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{baslik}</p>
        <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">{aciklama}</p>
      </div>
      <Anahtar acikMi={acikMi} degistir={degistir} />
    </div>
  );
}

/* Metin girişi — kenarsız dolgulu dil: durumlar ton + alt mesajla anlatılır */
function MetinGirisi({ etiket, deger, durum = "rest", mesaj }: { etiket: string; deger?: string; durum?: "rest" | "odak" | "hata"; mesaj?: string }) {
  const zemin = durum === "odak" ? "#262626" : durum === "hata" ? T.dangerSoft : "#171717";
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">{etiket}</label>
      <div className="flex items-center rounded-[12px] px-3.5 py-2.5 transition-colors duration-200" style={{ background: zemin }}>
        <span className={"text-[14px] leading-[19.6px] " + (deger ? "text-text-primary" : "text-text-dim")}>
          {deger ?? "yaz…"}
          {durum === "odak" ? <span className="ml-[1px] inline-block h-[14px] w-[2px] translate-y-[2px] rounded-full" style={{ background: T.accent }} /> : null}
        </span>
      </div>
      {mesaj ? <p className="text-[13px] leading-[18px]" style={{ color: durum === "hata" ? T.danger : "#737373" }}>{mesaj}</p> : null}
    </div>
  );
}

function OnayKutusu({ etiket, isaretli, degistir }: { etiket: string; isaretli: boolean; degistir: () => void }) {
  return (
    <button onClick={degistir} className="flex items-center gap-2.5">
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[6px] transition-colors duration-200" style={{ background: isaretli ? T.accent : "#262626" }}>
        {isaretli ? (
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="m3 7.5 2.5 2.5L11 4.5" stroke="#171717" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : null}
      </span>
      <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{etiket}</span>
    </button>
  );
}

function Radyo({ etiket, aciklama, secili, sec }: { etiket: string; aciklama?: string; secili: boolean; sec: () => void }) {
  return (
    <button onClick={sec} className="flex w-full items-start gap-2.5 rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200 hover:bg-surface" style={{ background: secili ? T.accentSoft : "transparent" }}>
      <span className="mt-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors duration-200" style={{ background: secili ? T.accent : "#262626" }}>
        {secili ? <span className="h-[7px] w-[7px] rounded-full bg-[#171717]" /> : null}
      </span>
      <span>
        <span className="block text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: secili ? T.accentStrong : "#e5e5e5" }}>{etiket}</span>
        {aciklama ? <span className="block text-[13px] leading-[18px] text-text-dim">{aciklama}</span> : null}
      </span>
    </button>
  );
}

/* Form kipliği — kanal oluşturma, validasyon hatası gösterimiyle */
function FormKipligi() {
  const [tur, setTur] = useState<"yazi" | "sesli">("sesli");
  return (
    <div className="relative flex items-center justify-center overflow-hidden rounded-[24px] bg-black/60 p-6">
      <div className="absolute inset-0 backdrop-blur-[4px]" style={{ background: "rgba(0,0,0,0.24)" }} />
      <div className="relative w-full max-w-[400px] rounded-[24px] bg-base p-6">
        <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanal oluştur</p>
        <div className="mt-5 flex flex-col gap-4">
          <MetinGirisi etiket="Kanal adı" deger="akşam odası 2" durum="hata" mesaj="Bu ad zaten var. Başka bir ad seç." />
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Tür</p>
            <Radyo etiket="Sesli kanal" aciklama="Konuşma, ekran ve kamera" secili={tur === "sesli"} sec={() => setTur("sesli")} />
            <Radyo etiket="Yazı kanalı" aciklama="Mesajlar ve dosyalar" secili={tur === "yazi"} sec={() => setTur("yazi")} />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <UrunButonu etiket="Vazgeç" tur="hayalet" />
          <UrunButonu etiket="Oluştur" tur="mercan" />
        </div>
      </div>
    </div>
  );
}

/* Davet kipliği — bağlantı alanı + kopyala */
function DavetKipligi() {
  return (
    <div className="relative flex items-center justify-center overflow-hidden rounded-[24px] bg-black/60 p-6">
      <div className="absolute inset-0 backdrop-blur-[4px]" style={{ background: "rgba(0,0,0,0.24)" }} />
      <div className="relative w-full max-w-[400px] rounded-[24px] bg-base p-6">
        <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Masaya davet et</p>
        <p className="mt-1.5 text-[13px] leading-[18px] text-text-dim">Bağlantı 7 gün geçerli; istediğinde iptal edersin.</p>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-[12px] bg-surface px-3.5 py-2.5">
            <span className="truncate font-mono text-[13px] leading-[18px] text-text-secondary">getdemli.com/davet/k7x2m9</span>
          </div>
          <UrunButonu etiket="Kopyala" tur="mercan" />
        </div>
        <div className="mt-4 flex items-center justify-between rounded-[12px] bg-surface px-3.5 py-2.5">
          <span className="text-[13px] font-medium leading-[18px] text-text-primary">Masadakiler</span>
          <AvatarKume adlar={["Baran", "Ece", "Kaan"]} boyut={20} />
        </div>
      </div>
    </div>
  );
}

/* Ayarlar kabuğu — sol bölüm listesi + içerik paneli + tehlike alanı */
function AyarlarKabugu({ gurultu, setGurultu }: { gurultu: boolean; setGurultu: (v: boolean) => void }) {
  return (
    <div className="flex gap-2 rounded-[32px] bg-black p-2">
      <div className="flex w-52 shrink-0 flex-col gap-0.5 rounded-[24px] bg-base p-3">
        <p className={onest.className + " px-3 pb-2 pt-1 text-[18px] font-semibold leading-[1.15] text-white"}>Ayarlar</p>
        <UrunSatiri etiket="Hesap" />
        <div className="flex cursor-pointer items-center rounded-[12px] px-3 py-2.5" style={{ background: T.accentSoft }}>
          <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accentStrong }}>Ses ve görüntü</span>
        </div>
        <UrunSatiri etiket="Bildirimler" />
        <UrunSatiri etiket="Görünüm" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-5">
        <p className={onest.className + " px-1 pb-2 text-[20px] font-medium leading-[1.15]"}>
          <span className="text-white">Ses ve görüntü</span>
        </p>
        <div className="rounded-[16px] bg-surface p-4">
          <p className="pb-2 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Mikrofon</p>
          <div className="flex w-full max-w-[280px] cursor-pointer items-center justify-between rounded-[12px] bg-surface-2 px-3.5 py-2.5 transition-colors duration-200 hover:bg-[#303030]">
            <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">Varsayılan — Yeti X</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </div>
        <AyarSatiri baslik="Gürültü engelleyici" aciklama="Müzik modunda kendiliğinden kapanır" acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />
        <div className="rounded-[16px] bg-surface p-4">
          <p className="pb-3 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Çıkış sesi</p>
          <SesSurgusu ad="Genel" oran={80} />
        </div>
        <div className="mt-2 rounded-[16px] p-4" style={{ background: T.dangerSoft }}>
          <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.danger }}>Hesabı sil</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Mesajların ve üyeliklerin kalıcı olarak silinir. Bu geri alınamaz.</p>
          <div className="mt-3"><UrunButonu etiket="Hesabı sil" tur="tehlike" boy="sm" /></div>
        </div>
      </div>
    </div>
  );
}

function BaglamMenusu() {
  return (
    <div className="w-[200px] rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px]">
      {["Yanıtla", "Kopyala", "Sabitle"].map((s) => (
        <div key={s} className="rounded-[8px] px-3 py-2 text-[14px] font-medium leading-[19.6px] text-text-secondary transition-colors duration-200 hover:bg-surface-2 hover:text-[#e5e5e5]">{s}</div>
      ))}
      <div className="mx-2 my-1 h-px bg-white/[0.06]" />
      <div className="rounded-[8px] px-3 py-2 text-[14px] font-medium leading-[19.6px] transition-colors duration-200 hover:bg-[rgba(255,111,181,0.12)]" style={{ color: T.danger }}>Sil</div>
    </div>
  );
}

function Kiplik() {
  return (
    <div className="relative flex h-[320px] items-center justify-center overflow-hidden rounded-[24px] bg-black/60 p-6">
      <div className="absolute inset-0 backdrop-blur-[4px]" style={{ background: "rgba(0,0,0,0.24)" }} />
      <div className="relative w-full max-w-[380px] rounded-[24px] bg-base p-6">
        <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanalı sil</p>
        <p className="mt-2 text-[14px] leading-[19.6px] text-text-secondary">&quot;oyun&quot; kanalı ve mesajları kalıcı olarak silinir. Bu geri alınamaz.</p>
        <div className="mt-6 flex justify-end gap-2">
          <UrunButonu etiket="Vazgeç" tur="hayalet" />
          <UrunButonu etiket="Kanalı sil" tur="tehlike" />
        </div>
      </div>
    </div>
  );
}

function Ipucu() {
  return (
    <div className="flex items-center gap-6">
      <IkonButonu ikon="monitor" />
      <span className="rounded-[8px] bg-[rgba(23,23,23,0.92)] px-2.5 py-1.5 text-[12px] font-medium leading-[16px] text-[#e5e5e5] backdrop-blur-[10px]">Ekranı paylaş</span>
    </div>
  );
}

function Bildirim() {
  return (
    <div className="flex w-fit items-center gap-3 rounded-[16px] bg-[rgba(23,23,23,0.92)] py-3 pl-4 pr-3 backdrop-blur-[10px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
      <Avatar ad="Ece" boyut={28} />
      <div>
        <p className="text-[13px] font-medium leading-[17px] text-text-primary">Ece seni aradı</p>
        <p className="text-[12px] leading-[16px] text-text-dim">akşam odası · az önce</p>
      </div>
      <UrunButonu etiket="Katıl" tur="mercan" boy="sm" />
    </div>
  );
}

function UyariBandi() {
  return (
    <div className="flex items-center gap-3 rounded-[12px] px-4 py-3" style={{ background: T.dangerSoft }}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: T.danger }} />
      <p className="text-[14px] leading-[19.6px]" style={{ color: T.danger }}>Bağlantı koptu. Oda yeniden bağlanıyor; bağlanamazsa mikrofonun kapalı kalır.</p>
    </div>
  );
}

/* Profil kartı — landing kart dili: kenarsız, üstte mercan parıltı bandı */
function ProfilKarti() {
  return (
    <div className="relative w-[300px] overflow-hidden rounded-[24px] bg-base">
      <div className="relative h-20">
        <div className="absolute inset-x-[-60px] top-[-70px] h-[160px] rounded-[100%]" style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
      </div>
      <div className="relative -mt-8 px-5 pb-5">
        <Avatar ad="Baran" boyut={64} cevrimici />
        <p className={onest.className + " mt-3 text-[20px] font-medium leading-[1.15] text-white"}>Baran</p>
        <p className="text-[13px] font-medium leading-[18px] text-text-dim">@baran · masada 2 yıl</p>
        <p className="mt-3 rounded-[12px] bg-surface px-3 py-2 text-[13px] leading-[18px] text-text-secondary">🎸 gitar gecesi hazırlığı</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {["kurucu", "çaycı"].map((rol) => (
            <span key={rol} className="rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{rol}</span>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <div className="flex-1 [&>button]:w-full [&>button]:justify-center"><UrunButonu etiket="Mesaj yaz" tur="mercan" /></div>
          <IkonButonu ikon="phone" />
        </div>
      </div>
    </div>
  );
}

/* Kullanıcı çubuğu (kendi durumun) — panel altı hap */
function KullaniciCubugu() {
  return (
    <div className="flex w-[260px] items-center gap-2.5 rounded-[16px] bg-surface p-2 pl-2.5">
      <Avatar ad="Sen" boyut={32} cevrimici />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-[17px] text-text-primary">Sen</p>
        <p className="text-[11px] leading-[15px]" style={{ color: T.accentStrong }}>akşam odası</p>
      </div>
      <IkonButonu ikon="star" boyut={32} />
      <IkonButonu ikon="monitor" boyut={32} aktif />
    </div>
  );
}

function KatilimciTile({ ad, konusuyor }: { ad: string; konusuyor?: boolean }) {
  return (
    <div className="relative flex h-40 flex-1 flex-col items-center justify-center overflow-hidden rounded-[24px] bg-base">
      {konusuyor ? (
        <div className="absolute inset-x-[-40px] inset-y-[-20px] rounded-[100%]" style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
      ) : null}
      <span className="relative"><Avatar ad={ad} boyut={56} konusuyor={konusuyor} /></span>
      <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-2.5 py-1 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
        {konusuyor ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.accent }} /> : null}
        <span className="text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{ad}</span>
      </span>
    </div>
  );
}

function MesajSatiri({ ad, saat, metin }: { ad: string; saat: string; metin: string }) {
  return (
    <div className="flex gap-3 rounded-[16px] px-3 py-2.5 transition-colors duration-200 hover:bg-[#141414]">
      <span className="mt-0.5"><Avatar ad={ad} /></span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
          <span className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-[#404040]">{saat}</span>
        </p>
        <p className="text-[15px] leading-[22px] text-text-secondary">{metin}</p>
      </div>
    </div>
  );
}

/* Uygulama dili — YAPI üründen, STİL landing'den doğma */
function UygulamaOnizleme() {
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <div className="flex items-center justify-between rounded-[16px] bg-[rgba(23,23,23,0.72)] py-2.5 pl-5 pr-2.5 backdrop-blur-[10px]">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-[12px]" style={{ background: T.accentSoft }}>
            <span className="text-[13px] font-semibold" style={{ color: T.accentStrong }}>D</span>
          </span>
          <span className={onest.className + " text-[17px] font-semibold text-white"}>bizim masa</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="translate-y-[1px]"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <div className="flex items-center gap-2">
          <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
          <UrunButonu etiket="Davet et" boy="sm" />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex w-64 shrink-0 flex-col rounded-[24px] bg-base p-3">
          <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Sesli</p>
          <div className="flex cursor-pointer items-center justify-between rounded-[12px] px-3 py-2.5" style={{ background: T.accentSoft }}>
            <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accentStrong }}>akşam odası</span>
            <AvatarKume adlar={["Baran", "Ece"]} boyut={20} />
          </div>
          <UrunSatiri etiket="film gecesi" />
          <p className="px-3 pb-1.5 pt-4 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Yazı</p>
          <UrunSatiri etiket="sohbet" />
          <UrunSatiri etiket="oyun" />
          <div className="mt-auto pt-4"><KullaniciCubugu /></div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-4">
          <p className={onest.className + " px-1 pb-1 text-[20px] font-medium leading-[1.15]"}>
            <span className="text-white">akşam odası </span>
            <span className="text-text-dim">· 3 kişi</span>
          </p>
          <div className="flex gap-2">
            <KatilimciTile ad="Baran" konusuyor />
            <KatilimciTile ad="Ece" />
            <KatilimciTile ad="Kaan" />
          </div>
          <div className="mt-1 flex flex-col">
            <MesajSatiri ad="Ece" saat="21:04" metin="Çay hazır, oda açık." />
            <MesajSatiri ad="Baran" saat="21:05" metin="Geliyorum, iki dakika." />
          </div>
          <Composer />
        </div>
      </div>
    </div>
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
  const [bildirimAcik, setBildirimAcik] = useState(true);
  const [gurultu, setGurultu] = useState(false);
  const [kabul, setKabul] = useState(true);
  const [kalite, setKalite] = useState<"hd" | "fhd">("fhd");
  return (
    <div className="min-h-screen bg-black">
      <header className="sticky top-0 z-10 border-b border-white/[0.06] bg-black/85 backdrop-blur-[10px]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-5 gap-y-1 px-6 py-3">
          <span className={onest.className + " mr-2 text-[15px] font-semibold text-white"}>
            Koyu Masa<span style={{ color: T.accent }}>.</span>
            <span className="ml-2 text-[12px] font-medium text-text-dim">design system v1 · onay turu</span>
          </span>
          <nav className="flex flex-wrap gap-x-4 gap-y-1">
            {BOLUMLER.map(([id, ad]) => (
              <a key={id} href={"#" + id} className="text-[12px] font-medium text-text-dim transition-colors hover:text-text-primary">{ad}</a>
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
            Ürün bileşen kütüphanesi — yapı mevcut üründen, stil landing&apos;den doğma. Kayan metin
            hover&apos;ı yalnız landing&apos;de kalır; ürün hover&apos;ı ton geçişidir (200ms). Zeminler nötr
            siyah, vurgu Demli mercanı, display font Onest (OFL).
          </p>
        </div>

        {/* RENK */}
        <Bolum id="renk" baslik="01 · Renk" aciklama="İki katman: ham palet + anlamsal tokenlar. Kenar çizgisi yok — derinlik yüzey tonuyla. Açık tema geldiğinde yalnız anlamsal değerler değişir.">
          <Spec etiket="Zeminler" deger={"bg-page      #000000\nbg-base      #0d0d0d\nbg-surface   #171717\nbg-surface-2 #262626\nbg-raised    rgba(23,23,23,.72)+blur10\nbg-veil      rgba(0,0,0,.24)+blur8"}>
            <div className="grid grid-cols-3 gap-3 tb:grid-cols-6">
              <Swatch ad="bg-page" deger="#000000" not="pencere/sayfa" />
              <Swatch ad="bg-base" deger="#0d0d0d" not="panel, kart" />
              <Swatch ad="bg-surface" deger="#171717" not="ikincil yüzey" />
              <Swatch ad="bg-surface-2" deger="#262626" not="buton, hover" />
              <Swatch ad="bg-raised" deger="rgba(23,23,23,0.72)" not="yüzen panel (+blur)" />
              <Swatch ad="bg-veil" deger="rgba(0,0,0,0.24)" not="saydam hap" />
            </div>
          </Spec>
          <Spec etiket="Metin + vurgu" deger={"display #fff · primary #e5e5e5\nsecondary #a3a3a3 · dim #737373\nfaint #404040\naccent #ff8464 · strong #ffa48c\ndeep #e8624a (basılı)\nsoft %12 zemin · glow %24 radyal\nKontrast: 7.4:1 (#0d0d0d)"}>
            <div className="grid grid-cols-3 gap-3 tb:grid-cols-6">
              <Swatch ad="accent" deger={T.accent} koyu not="vurgu, aktif" />
              <Swatch ad="accent-strong" deger={T.accentStrong} koyu not="hover" />
              <Swatch ad="accent-deep" deger={T.accentDeep} koyu not="basılı" />
              <Swatch ad="gold" deger={T.gold} koyu not="yıldız" />
              <Swatch ad="success" deger={T.success} koyu not="YALNIZ çevrimiçi/başarı" />
              <Swatch ad="danger" deger={T.danger} koyu not="pembe — ≥30° hue ayrımı" />
            </div>
          </Spec>
        </Bolum>

        {/* TİPOGRAFİ */}
        <Bolum id="tipografi" baslik="02 · Tipografi" aciklama="Display: Onest (OFL, Türkçe tam). Gövde/UI: Inter. Üründe display yalnız başlık rollerinde (panel/kiplik/profil başlığı, kanal başlığı); metin işi Inter'de.">
          <Spec etiket="Display rolleri" deger={"D-hero 56/92/112 (yalnız landing)\nD-panel 20–24 · %115 · 500–600\nD-kart 20 · %115 · 500\nİki tonlu: beyaz + dim kuyruk"}>
            <div className="flex flex-col gap-5 rounded-[16px] bg-base p-6">
              <p className={onest.className + " text-[24px] font-semibold leading-[1.15] text-white"}>Ayarlar</p>
              <p className={onest.className + " text-[20px] font-medium leading-[1.15]"}>
                <span className="text-white">akşam odası </span>
                <span className="text-text-dim">· 3 kişi</span>
              </p>
            </div>
          </Spec>
          <Spec etiket="Gövde ve UI (Inter)" deger={"mesaj 15/22\ngövde 14/19.6 · ls −0.28 (500)\nikincil 13/18\nküçük 12/14.4 · ls −0.24 (500)\ncomposer 16/24"}>
            <div className="flex flex-col gap-2 rounded-[16px] bg-base p-6">
              <p className="text-[15px] leading-[22px] text-text-secondary">Mesaj — Çay hazır, oda açık. Gelenler ekrandan film seçiyor.</p>
              <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">UI — Odaya gir · Ekranı paylaş · Sesini ayarla</p>
              <p className="text-[13px] leading-[18px] text-text-dim">İkincil — açıklamalar, ayar alt metinleri</p>
              <p className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-[#404040]">Küçük — 21:04 · az önce</p>
            </div>
          </Spec>
        </Bolum>

        {/* BOŞLUK */}
        <Bolum id="bosluk" baslik="03 · Boşluk & radius" aciklama="4'lük taban. Panel içi pad 12–16; öğe içi 10×12; kart içi 20–24. Radius: 8 (menü öğesi) · 10 · 12 (satır, ikon kutusu, arama) · 14 · 16 (panel içi kart, bildirim) · 18 (composer) · 24 (panel, kiplik, profil) · 32 (dış kabuk) · 50 (hap) · tam (avatar). Dış gölge yok; tek istisna hap iç gölgesi.">
          <Spec etiket="Radius ölçeği" deger={"8 · 10 · 12 · 14 · 16 · 18\n24 · 32 · 50 (hap) · tam"}>
            <div className="flex flex-wrap items-end gap-4 rounded-[16px] bg-base p-6">
              {[8, 10, 12, 14, 16, 18, 24, 32].map((r) => (
                <div key={r} className="flex flex-col items-center gap-1.5">
                  <div className="h-14 w-14 bg-surface-2" style={{ borderRadius: r }} />
                  <span className="font-mono text-[10px] text-text-dim">{r}</span>
                </div>
              ))}
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-9 w-20 rounded-[50px] bg-surface-2" />
                <span className="font-mono text-[10px] text-text-dim">50</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="h-14 w-14 rounded-full bg-surface-2" />
                <span className="font-mono text-[10px] text-text-dim">tam</span>
              </div>
            </div>
          </Spec>
        </Bolum>

        {/* BUTONLAR */}
        <Bolum id="butonlar" baslik="04 · Butonlar" aciklama="Ürün butonlarında kayan metin YOK — hover ton geçişidir (200ms). Beş varyant, üç boy. Basılı durumda mercan bir ton koyulaşır (accent-deep).">
          <Spec etiket="Varyantlar (md)" deger={"birincil: #fff → hover #e5e5e5\nikincil: #262626 → #303030\nmercan: #ff8464 → #ffa48c\ntehlike: danger-soft + danger metin\nhayalet: saydam → #171717\ndevre dışı: %40 opaklık"}>
            <div className="flex flex-wrap items-center gap-3">
              <UrunButonu etiket="Kaydet" tur="birincil" />
              <UrunButonu etiket="Demli'yi aç" tur="ikincil" />
              <UrunButonu etiket="Odaya gir" tur="mercan" />
              <UrunButonu etiket="Kanalı sil" tur="tehlike" />
              <UrunButonu etiket="Vazgeç" tur="hayalet" />
              <UrunButonu etiket="Devre dışı" devre />
            </div>
          </Spec>
          <Spec etiket="Boylar" deger={"lg: radius 14 · pad 12×20 · 15px\nmd: radius 12 · pad 10×16 · 14px\nsm: radius 10 · pad 6×12 · 13px"}>
            <div className="flex flex-wrap items-center gap-3">
              <UrunButonu etiket="Büyük" tur="mercan" boy="lg" />
              <UrunButonu etiket="Orta" tur="mercan" boy="md" />
              <UrunButonu etiket="Küçük" tur="mercan" boy="sm" />
            </div>
          </Spec>
          <Spec etiket="İkon butonu" deger={"40×40 (küçük 32) · radius 12\nrest #171717 → hover #262626\naktif: accent-soft + accent-strong"}>
            <div className="flex items-center gap-2">
              <IkonButonu ikon="monitor" aktif />
              <IkonButonu ikon="phone" />
              <IkonButonu ikon="star" />
              <IkonButonu ikon="mail" boyut={32} />
            </div>
          </Spec>
        </Bolum>

        {/* HAP & ROZET */}
        <Bolum id="hap" baslik="05 · Hap & rozet" aciklama="Saydam zemin + blur + iç gölge imzası landing'den; üründe isim etiketi, sayaç ve rol çipi olarak yaşar.">
          <Spec etiket="Veil hapı" deger={"radius 50 · bg-veil + blur(8)\niç gölge imzası\niçerik: 12px (500) #e5e5e5"}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-1.5 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-2.5 py-1 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.accent }} />
                <span className="text-[12px] font-medium leading-[16px] text-[#e5e5e5]">Baran</span>
              </span>
              <span className="rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">%80</span>
              <span className="rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">çaycı</span>
              <span className="flex items-center gap-1.5 rounded-[50px] px-2.5 py-1 text-[12px] font-medium leading-[16px]" style={{ background: T.accentSoft, color: T.accentStrong }}>3 yeni</span>
            </div>
          </Spec>
        </Bolum>

        {/* KARTLAR */}
        <Bolum id="kart" baslik="06 · Kartlar & paneller" aciklama="Panel: radius 24, bg-base, kenarsız, siyah boşlukla ayrılır. Panel içi kart: radius 16–18, bg-surface. Hover gereken kartlarda zemin yarım ton açılır (200ms).">
          <Spec etiket="Panel + iç kart" deger={"panel: radius 24 · bg #0d0d0d · p 12–16\niç kart: radius 16/18 · bg #171717\nayraç çizgisi YOK"}>
            <div className="w-full max-w-[420px] rounded-[24px] bg-base p-4">
              <p className={onest.className + " px-1 pb-3 text-[20px] font-medium leading-[1.15] text-white"}>Ses ve görüntü</p>
              <div className="flex flex-col gap-2">
                <div className="rounded-[16px] bg-surface p-4">
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">Mikrofon</p>
                  <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Varsayılan — Yeti X</p>
                </div>
                <div className="rounded-[16px] bg-surface p-4 transition-colors duration-200 hover:bg-surface-2">
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">Hoparlör</p>
                  <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Kulaklık (hover&apos;lı kart)</p>
                </div>
              </div>
            </div>
          </Spec>
        </Bolum>

        {/* FORM */}
        <Bolum id="form" baslik="07 · Form" aciklama="Kenarsız, dolgulu dil: alanlar yüzeyle ayrılır, çizgi/ring yok. Focus'ta yüzey yarım ton açılır (+ composer'da iç gölge imzası ve mercan imleç).">
          <Spec etiket="Composer" deger={"radius 18 · pad 16×24 · metin 16/24\nrest: #262626 · focus: #303030\n+ iç gölge imzası + mercan imleç\nsağda 40px ikon kutusu"}>
            <div className="flex max-w-[520px] flex-col gap-3">
              <Composer />
              <Composer odak />
            </div>
          </Spec>
          <Spec etiket="Arama" deger={"radius 12 · pad 10×14 · bg #171717\nfocus: #262626 · ikon dim 15px"}>
            <div className="max-w-[320px]"><AramaAlani /></div>
          </Spec>
          <Spec etiket="Seçim kutusu + menü" deger={"tetik: radius 12 · pad 10×14\nmenü: radius 12 · p-1\nraised(.92)+blur10 · öğe radius 8\naktif: mercan check"}>
            <SecimKutusu />
          </Spec>
          <Spec etiket="Anahtar" deger={"44×24 · tam yuvarlak\naçık: accent · kapalı: #262626\ntop: 18px beyaz, authored spring"}>
            <div className="flex items-center gap-4 rounded-[16px] bg-base p-4">
              <Anahtar acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />
              <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">Gürültü engelleyici</span>
            </div>
          </Spec>
          <Spec etiket="Ses sürgüsü (kişi başı)" deger={"ray 4px tam yuvarlak #262626\ndolu: accent · top 14px beyaz\n+ 2px koyu halka · değer: beyaz\n%12 hap çipi"}>
            <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
              <SesSurgusu ad="Baran" oran={80} />
              <SesSurgusu ad="Ece" oran={100} />
            </div>
          </Spec>
          <Spec etiket="Ayar satırı" deger={"radius 16 · pad 14×16\nbaşlık 14 (500) + açıklama 13 dim\nhover: bg #171717 (200ms)"}>
            <div className="max-w-[480px] rounded-[24px] bg-base p-2">
              <AyarSatiri baslik="Gürültü engelleyici" aciklama="Müzik modunda kendiliğinden kapanır" acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />
              <AyarSatiri baslik="Kapanışta güncelle" aciklama="Yeni sürüm çıkışta sessizce kurulur" acikMi={bildirimAcik} degistir={() => setBildirimAcik(!bildirimAcik)} />
            </div>
          </Spec>
          <Spec etiket="Metin girişi" deger={"etiket 13 (500) secondary üstte\nalan: radius 12 · pad 10×14 · 14px\nrest #171717 · focus #262626\n+ mercan imleç · yardım 13 dim"}>
            <div className="grid max-w-[560px] gap-4 tb:grid-cols-2">
              <MetinGirisi etiket="Görünen ad" mesaj="Masada herkese böyle görünürsün." />
              <MetinGirisi etiket="Görünen ad" deger="Baran" durum="odak" />
            </div>
          </Spec>
          <Spec etiket="Onay kutusu & radyo" deger={"onay: 18px · radius 6\nişaretli: accent + koyu check\nradyo: 18px daire · seçili satır\naccent-soft zemin + iç nokta"}>
            <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
              <OnayKutusu etiket="Beni davet edilince haberdar et" isaretli={kabul} degistir={() => setKabul(!kabul)} />
              <div className="flex flex-col gap-1">
                <Radyo etiket="1080p · 60 kare" aciklama="Önerilen" secili={kalite === "fhd"} sec={() => setKalite("fhd")} />
                <Radyo etiket="720p · 30 kare" secili={kalite === "hd"} sec={() => setKalite("hd")} />
              </div>
            </div>
          </Spec>
        </Bolum>

        {/* VALİDASYON */}
        <Bolum id="validasyon" baslik="08 · Validasyon" aciklama="Kenarsız dilde hata: alanın zemini danger-soft'a döner, altına düz tonlu tek mesaj gelir — çerçeve/ünlem/ikon kalabalığı yok. Sıra copy-voice'tan: ne oldu → ne yapmalısın.">
          <Spec etiket="Alan hatası" deger={"zemin: danger-soft (%12)\nmesaj: 13px danger, altta\nring/çerçeve YOK\nespri ve ünlem yok"}>
            <div className="grid max-w-[560px] gap-4 tb:grid-cols-2">
              <MetinGirisi etiket="Kanal adı" deger="akşam odası 2" durum="hata" mesaj="Bu ad zaten var. Başka bir ad seç." />
              <MetinGirisi etiket="Davet bağlantısı" deger="getdemli/davet/x" durum="hata" mesaj="Bağlantı süresi dolmuş. Yeni bağlantı iste." />
            </div>
          </Spec>
          <Spec etiket="Form düzeyi hata" deger={"uyarı bandı: radius 12\ndanger-soft zemin + danger metin\nbutonlar değişmez; alan odaklanır"}>
            <div className="flex max-w-[420px] flex-col gap-3">
              <UyariBandi />
              <MetinGirisi etiket="Grup adı" durum="rest" />
            </div>
          </Spec>
        </Bolum>

        {/* SATIRLAR */}
        <Bolum id="satirlar" baslik="09 · Satırlar & listeler" aciklama="Satır hover'ı sade: yalnız yüzey açılır (200ms). Bölüm etiketleri cümle düzeninde (BÜYÜK HARF ve ikon önek yok). Sesli kanal dolu odayı avatar kümesiyle gösterir.">
          <Spec etiket="Kanal listesi" deger={"satır: radius 12 · pad 10×12\nmetin 15 (500) ls −0.28\nseçili: accent-soft + accent-strong\nbölüm etiketi: 13 (500) dim"}>
            <div className="flex max-w-[300px] flex-col gap-0.5 rounded-[24px] bg-base p-3">
              <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Sesli</p>
              <div className="flex cursor-pointer items-center justify-between rounded-[12px] px-3 py-2.5" style={{ background: T.accentSoft }}>
                <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accentStrong }}>akşam odası</span>
                <AvatarKume adlar={["Baran", "Ece"]} boyut={20} />
              </div>
              <UrunSatiri etiket="film gecesi" />
              <p className="px-3 pb-1.5 pt-3 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Yazı</p>
              <UrunSatiri etiket="sohbet" />
              <UrunSatiri etiket="oyun" />
            </div>
          </Spec>
          <Spec etiket="Üye satırı" deger={"avatar 32 + 2px koyu halka\nonline nokta success\nses oranı: beyaz %12 hap"}>
            <div className="flex max-w-[300px] flex-col gap-1 rounded-[24px] bg-base p-3">
              <UyeSatiri ad="Baran" oran="%80" />
              <UyeSatiri ad="Ece" oran="%100" />
            </div>
          </Spec>
          <Spec etiket="Mesaj satırı" deger={"BALONCUK YOK — sakin satır\nradius 16 · pad 10×12\nisim 14 (500) + saat 12 faint\nmetin 15/22 · hover #141414"}>
            <div className="max-w-[480px] rounded-[24px] bg-base p-2">
              <MesajSatiri ad="Ece" saat="21:04" metin="Çay hazır, oda açık." />
              <MesajSatiri ad="Baran" saat="21:05" metin="Geliyorum, iki dakika." />
            </div>
          </Spec>
          <Spec etiket="Bağlam menüsü" deger={"radius 12 · p-1 · raised+blur\nöğe: radius 8 · pad 8×12\ntehlike öğesi: danger + soft hover\nayraç: beyaz %6 (tek istisna)"}>
            <BaglamMenusu />
          </Spec>
        </Bolum>

        {/* KİPLİKLER */}
        <Bolum id="kiplikler" baslik="10 · Kiplikler" aciklama="Örtü: veil + blur(4). Kart: radius 24, bg-base, pad 24, başlık display 20 (500). Butonlar sağ altta: hayalet + eylem. Yıkıcı eylem tehlike butonuyla; form kiplikleri validasyon reçetesini taşır.">
          <Spec etiket="Onay kipliği (yıkıcı)" deger={"başlık + tek paragraf açıklama\neylem: tehlike butonu\nvazgeç: hayalet"}>
            <Kiplik />
          </Spec>
          <Spec etiket="Form kipliği" deger={"alanlar form reçetesinden\nhata: alan zemini danger-soft +\naltta düz mesaj\nradyo: seçili accent-soft satır"}>
            <FormKipligi />
          </Spec>
          <Spec etiket="Davet kipliği" deger={"bağlantı: mono 13, surface alanda\nkopyala: mercan buton\nüye özeti: avatar kümesi"}>
            <DavetKipligi />
          </Spec>
        </Bolum>

        {/* KAPLAMALAR */}
        <Bolum id="kaplamalar" baslik="11 · Kaplamalar" aciklama="İpucu, bildirim, uyarı bandı. Hepsi kenarsız; yüzen olanlar raised+blur, kritik olanlar durum renginin soft zemininde.">
          <Spec etiket="İpucu" deger={"radius 8 · pad 6×10\nraised(.92)+blur · 12px (500)"}>
            <Ipucu />
          </Spec>
          <Spec etiket="Bildirim (toast)" deger={"radius 16 · raised(.92)+blur\niç gölge imzası · avatar 28\neylem: mercan sm buton"}>
            <Bildirim />
          </Spec>
          <Spec etiket="Uyarı bandı" deger={"radius 12 · danger-soft zemin\nmetin danger · nokta 8px\nespri/ünlem yok (copy-voice)"}>
            <div className="max-w-[560px]"><UyariBandi /></div>
          </Spec>
        </Bolum>

        {/* AYARLAR */}
        <Bolum id="ayarlar" baslik="12 · Ayarlar" aciklama="Ayarlar da ada dilinde: sol bölüm listesi (kanal listesi reçetesi) + içerik paneli. Cihaz seçimleri seçim kutusuyla, anahtarlar ayar satırında, yıkıcı işlemler tehlike alanında toplanır.">
          <Spec etiket="Ayarlar kabuğu" deger={"sol: radius 24 panel, satırlar\nkanal listesi reçetesi\niçerik: radius 24 panel, başlık\ndisplay 20 · gruplar surface kartı\ntehlike alanı: danger-soft kart\n+ tehlike sm buton"}>
            <AyarlarKabugu gurultu={gurultu} setGurultu={setGurultu} />
          </Spec>
        </Bolum>

        {/* PROFİL */}
        <Bolum id="profil" baslik="13 · Profil & kimlik" aciklama="Avatarlar her boyda 2px koyu halka taşır (rozet reçetesi); konuşan +2px mercan halka. Profil kartında landing'in parıltısı kimlik bandı olur.">
          <Spec etiket="Avatar boyları" deger={"20 (küme) · 24 · 28 (toast)\n32 (satır) · 56 (tile) · 64 (profil)\nhalka: 2px #0d0d0d\nkonusan: +2px accent\nonline nokta: %30 boy, success"}>
            <div className="flex items-end gap-4 rounded-[16px] bg-base p-5">
              <Avatar ad="A" boyut={20} />
              <Avatar ad="B" boyut={24} />
              <Avatar ad="C" boyut={28} cevrimici />
              <Avatar ad="D" boyut={32} cevrimici />
              <Avatar ad="E" boyut={56} konusuyor />
              <Avatar ad="F" boyut={64} cevrimici />
              <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
            </div>
          </Spec>
          <Spec etiket="Profil kartı" deger={"radius 24 · bg-base · kenarsız\nüst: mercan parıltı bandı (glow)\navatar 64 · ad display 20 (500)\n@kullanıcı 13 dim · durum: surface\nkutusu · roller: beyaz %12 hap\neylem: mercan md + ikon butonu"}>
            <ProfilKarti />
          </Spec>
          <Spec etiket="Kullanıcı çubuğu" deger={"radius 16 · bg-surface · p 8\navatar 32 + ad 13 (500)\nbağlı oda: 11 accent-strong\nkontroller: 32px ikon kutuları"}>
            <KullaniciCubugu />
          </Spec>
        </Bolum>

        {/* DURUMLAR */}
        <Bolum id="durum" baslik="14 · Durumlar" aciklama="Yeşil yalnız çevrimiçi/başarı. Hata pembe, düz tonda; ne oldu → ne yapılıyor → ne yapabilirsin sırasıyla (copy-voice).">
          <Spec etiket="Durum örnekleri" deger={"online: nokta + success\nhata: danger, şakasız\nuyarı: gold · başarı: success"}>
            <div className="flex max-w-[560px] flex-col gap-3 rounded-[16px] bg-base p-6">
              <div className="flex items-center gap-2.5">
                <Avatar ad="Baran" cevrimici />
                <span className="text-[14px] leading-[19.6px] text-text-primary">Baran çevrimiçi</span>
              </div>
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.gold }}>Mikrofon izni bekleniyor.</p>
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.success }}>Ekran paylaşımı başladı.</p>
              <UyariBandi />
            </div>
          </Spec>
        </Bolum>

        {/* HAREKET */}
        <Bolum id="hareket" baslik="15 · Hareket" aciklama="Üründe mikro hareket: ton geçişleri 200ms; panel/anahtar gibi konum değiştirenler authored spring (damping 60, stiffness 500). Kayan metin hover'ı ve pazarlama reveal'leri ÜRÜNE GİRMEZ — landing'e özgüdür.">
          <HareketSatiri ad="Panel girişi" deger={"y 24→0 + opacity\nspring damping 60, stiffness 500"}>
            {(tur) => (
              <motion.div key={tur} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", damping: 60, stiffness: 500, mass: 1 }} className="h-12 w-40 rounded-[16px] bg-surface-2" />
            )}
          </HareketSatiri>
          <HareketSatiri ad="Ton geçişi" deger={"background 200ms ease\n(satır, buton, kart hover'ı)"}>
            {() => <UrunButonu etiket="Üstüme gel" tur="ikincil" />}
          </HareketSatiri>
          <HareketSatiri ad="Anahtar" deger={"top hareketi authored spring\n(damping 60, stiffness 500)"}>
            {() => <Anahtar acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />}
          </HareketSatiri>
        </Bolum>

        {/* UYGULAMA */}
        <Bolum id="esleme" baslik="16 · Uygulama önizlemesi & eşleme" aciklama="Yapı mevcut üründen (gruplar, kanallar, sesli oda, sohbet); stil bu sistemin reçeteleri. Entegrasyonda --tc-* adları korunur, değerler bu sisteme çekilir.">
          <Spec etiket="Uygulama dili" deger={"üst çubuk: raised+blur hap,\ngrup adı display font, avatar kümesi\nadalar: radius 24, 8px siyah boşluk\nkonuşan: mercan parıltı + halka\nmesaj: baloncuksuz satır\ncomposer: 18'lik hap\nkullanıcı çubuğu panel altında"}>
            <UygulamaOnizleme />
          </Spec>
          <Spec etiket="Token eşleme" deger={"tek kaynak:\npackages/app-ui/tokens.css"}>
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
        </Bolum>

        <p className="border-t border-white/[0.06] pt-6 text-[13px] leading-[18px] text-[#404040]">
          Doküman: docs/design-system/demli-design-system.md · Onay gelmeden landing/ürün entegrasyonu yapılmaz.
        </p>
      </main>
    </div>
  );
}
