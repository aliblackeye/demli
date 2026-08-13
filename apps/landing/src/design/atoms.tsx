"use client";

/**
 * Koyu Masa — ATOMLAR: tek başına anlamlı en küçük ürün parçaları.
 * Kayan metin hover'ı YOK (landing'e özgü); ürün hover'ı ton geçişi (200ms).
 */

import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { MaskIcon } from "@/components/atoms/MaskIcon";
import { SPRING, T } from "./tokens";

/* ── Buton ────────────────────────────────────────────────────── */

export type ButonTur = "birincil" | "ikincil" | "mercan" | "tehlike" | "hayalet";
export type ButonBoy = "lg" | "md" | "sm";

export function UrunButonu({ etiket, tur = "ikincil", boy = "md", devre, tikla }: { etiket: string; tur?: ButonTur; boy?: ButonBoy; devre?: boolean; tikla?: () => void }) {
  const [durum, setDurum] = useState<"rest" | "hover" | "basili">("rest");
  const boyCls = boy === "lg" ? "rounded-[14px] px-5 py-3 text-[15px] leading-[20px]" : boy === "sm" ? "rounded-[10px] px-3 py-1.5 text-[13px] leading-[17px]" : "rounded-[12px] px-4 py-2.5 text-[14px] leading-[18px]";
  const stil: Record<ButonTur, [string, string, string, string]> = {
    birincil: ["#ffffff", "#171717", "#e5e5e5", "#d4d4d4"],
    ikincil: ["#262626", "#e5e5e5", "#303030", "#1f1f1f"],
    mercan: [T.accent, "#171717", T.accentStrong, T.accentDeep],
    tehlike: [T.dangerSoft, T.danger, "rgba(255,111,181,0.2)", "rgba(255,111,181,0.28)"],
    hayalet: ["transparent", "#a3a3a3", "#171717", "#0d0d0d"],
  };
  const [rest, metin, hover, basili] = stil[tur];
  const zemin = devre ? rest : durum === "basili" ? basili : durum === "hover" ? hover : rest;
  return (
    <button
      disabled={devre}
      onClick={tikla}
      onMouseEnter={() => setDurum("hover")}
      onMouseLeave={() => setDurum("rest")}
      onMouseDown={() => setDurum("basili")}
      onMouseUp={() => setDurum("hover")}
      className={"flex items-center gap-2 font-medium transition-colors duration-200 " + boyCls + (devre ? " cursor-not-allowed opacity-40" : "")}
      style={{ background: zemin, color: metin }}
    >
      {etiket}
    </button>
  );
}

export function IkonButonu({ ikon, aktif, boyut = 40, tikla, baslik }: { ikon: string; aktif?: boolean; boyut?: number; tikla?: () => void; baslik?: string }) {
  return (
    <button
      title={baslik}
      onClick={tikla}
      className="flex items-center justify-center rounded-[12px] transition-colors duration-200"
      style={{ width: boyut, height: boyut, background: aktif ? T.accentSoft : "#171717" }}
      onMouseEnter={(e) => { if (!aktif) e.currentTarget.style.background = "#262626"; }}
      onMouseLeave={(e) => { if (!aktif) e.currentTarget.style.background = "#171717"; }}
    >
      <MaskIcon name={ikon} size={Math.round(boyut * 0.5)} color={aktif ? T.accentStrong : "#e5e5e5"} />
    </button>
  );
}

/* ── Kimlik ───────────────────────────────────────────────────── */

export function Avatar({ ad, boyut = 32, cevrimici, konusuyor }: { ad: string; boyut?: number; cevrimici?: boolean; konusuyor?: boolean }) {
  const nokta = Math.max(10, Math.round(boyut * 0.3));
  return (
    <span className="relative flex shrink-0 items-center justify-center rounded-[1000px] bg-surface-2 font-medium text-text-primary" style={{ width: boyut, height: boyut, fontSize: Math.round(boyut * 0.38), boxShadow: konusuyor ? `rgb(13,13,13) 0 0 0 2px, ${T.accent} 0 0 0 4px` : "rgb(13,13,13) 0 0 0 2px" }}>
      {ad[0]}
      {cevrimici ? <span className="absolute rounded-full border-2 border-base" style={{ width: nokta, height: nokta, right: -2, bottom: -2, background: T.success }} /> : null}
    </span>
  );
}

export function AvatarKume({ adlar, boyut = 24 }: { adlar: string[]; boyut?: number }) {
  return (
    <span className="flex items-center">
      {adlar.map((a, i) => (
        <span key={a} className="flex items-center justify-center rounded-[1000px] bg-surface-2 font-medium text-text-primary" style={{ width: boyut, height: boyut, fontSize: boyut * 0.42, marginLeft: i > 0 ? -(boyut * 0.3) : 0, boxShadow: "rgb(13, 13, 13) 0px 0px 0px 2px" }}>
          {a[0]}
        </span>
      ))}
    </span>
  );
}

/* ── Form kontrolleri ─────────────────────────────────────────── */

export function Anahtar({ acikMi, degistir }: { acikMi: boolean; degistir: () => void }) {
  return (
    <button onClick={degistir} className="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200" style={{ background: acikMi ? T.accent : "#262626" }}>
      <motion.span animate={{ x: acikMi ? 22 : 2 }} transition={SPRING} className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white" style={{ left: 0 }} />
    </button>
  );
}

export function OnayKutusu({ etiket, isaretli, degistir }: { etiket: string; isaretli: boolean; degistir: () => void }) {
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

export function Radyo({ etiket, aciklama, secili, sec }: { etiket: string; aciklama?: string; secili: boolean; sec: () => void }) {
  return (
    <button onClick={sec} className="flex w-full items-start gap-2.5 rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200 hover:bg-surface" style={{ background: secili ? T.accentSoft : "transparent" }}>
      <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors duration-200" style={{ background: secili ? T.accent : "#262626" }}>
        {secili ? <span className="h-[7px] w-[7px] rounded-full bg-[#171717]" /> : null}
      </span>
      <span>
        <span className="block text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: secili ? T.accentStrong : "#e5e5e5" }}>{etiket}</span>
        {aciklama ? <span className="block text-[13px] leading-[18px] text-text-dim">{aciklama}</span> : null}
      </span>
    </button>
  );
}

export function GirisAlani({ etiket, ilkDeger = "", yardim, dogrula, yerTutucu = "yaz…" }: { etiket: string; ilkDeger?: string; yardim?: string; dogrula?: (v: string) => string | null; yerTutucu?: string }) {
  const [deger, setDeger] = useState(ilkDeger);
  const [odak, setOdak] = useState(false);
  const hata = dogrula ? dogrula(deger) : null;
  const zemin = hata ? T.dangerSoft : odak ? "#262626" : "#171717";
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">{etiket}</label>
      <div className="flex items-center rounded-[12px] px-3.5 py-2.5 transition-colors duration-200" style={{ background: zemin }}>
        <input
          value={deger}
          onChange={(e) => setDeger(e.target.value)}
          onFocus={() => setOdak(true)}
          onBlur={() => setOdak(false)}
          placeholder={yerTutucu}
          className="w-full bg-transparent text-[14px] leading-[19.6px] text-text-primary outline-none placeholder:text-text-dim"
          style={{ caretColor: T.accent }}
        />
      </div>
      {hata ? (
        <p className="text-[13px] leading-[18px]" style={{ color: T.danger }}>{hata}</p>
      ) : yardim ? (
        <p className="text-[13px] leading-[18px] text-text-dim">{yardim}</p>
      ) : null}
    </div>
  );
}

export function AramaAlani() {
  const [deger, setDeger] = useState("");
  const [odak, setOdak] = useState(false);
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] px-3.5 py-2.5 transition-colors duration-200" style={{ background: odak ? "#262626" : "#171717" }}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
        <circle cx="6.5" cy="6.5" r="4.5" stroke="#737373" strokeWidth="1.5" />
        <path d="m10 10 3 3" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input value={deger} onChange={(e) => setDeger(e.target.value)} onFocus={() => setOdak(true)} onBlur={() => setOdak(false)} placeholder="Mesajlarda ara…" className="w-full bg-transparent text-[14px] leading-[19.6px] text-text-primary outline-none placeholder:text-text-dim" style={{ caretColor: T.accent }} />
    </div>
  );
}

export function SesSurgusu({ ad, baslangic }: { ad: string; baslangic: number }) {
  const [oran, setOran] = useState(baslangic);
  const ray = useRef<HTMLDivElement | null>(null);
  const hesapla = (clientX: number) => {
    const r = ray.current!.getBoundingClientRect();
    setOran(Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100));
  };
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
      <div
        ref={ray}
        className="relative h-5 flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); hesapla(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons === 1) hesapla(e.clientX); }}
      >
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-2" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ width: oran + "%", background: T.accent }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${oran}% - 7px)`, boxShadow: "rgb(13,13,13) 0 0 0 2px" }} />
      </div>
      <span className="w-12 shrink-0 rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-center text-[12px] font-medium leading-[16px] text-[#e5e5e5]">%{oran}</span>
    </div>
  );
}

/* ── Sohbet atomları ──────────────────────────────────────────── */

/** Bahsetme çipi — mesaj metninin içinde yaşar */
export function BahsetmeCipi({ ad }: { ad: string }) {
  return (
    <span className="rounded-[6px] px-1 py-0.5 text-[14px] font-medium leading-[19.6px]" style={{ background: T.accentSoft, color: T.accentStrong }}>@{ad}</span>
  );
}

/** Tepki çipi — tıklayınca sayar/çıkarır */
export function TepkiCipi({ emoji, ilkSayi, benimki }: { emoji: string; ilkSayi: number; benimki?: boolean }) {
  const [benim, setBenim] = useState(!!benimki);
  const sayi = ilkSayi + (benim ? 1 : 0);
  return (
    <button
      onClick={() => setBenim(!benim)}
      className="flex items-center gap-1.5 rounded-[50px] px-2.5 py-1 transition-colors duration-200"
      style={{ background: benim ? T.accentSoft : "#171717" }}
      onMouseEnter={(e) => { if (!benim) e.currentTarget.style.background = "#262626"; }}
      onMouseLeave={(e) => { if (!benim) e.currentTarget.style.background = "#171717"; }}
    >
      <span className="text-[13px] leading-[17px]">{emoji}</span>
      <span className="text-[12px] font-medium leading-[16px]" style={{ color: benim ? T.accentStrong : "#a3a3a3" }}>{sayi}</span>
    </button>
  );
}

/** Yazıyor noktaları — sırayla nefes alan üç nokta */
export function YaziyorNoktalari() {
  return (
    <span className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: "easeInOut" }}
          className="h-1.5 w-1.5 rounded-full bg-text-dim"
        />
      ))}
    </span>
  );
}

/* ── Yükleme ──────────────────────────────────────────────────── */

/** İskelet — yüklenen içeriğin yerini tutan nabızlı blok */
export function Iskelet({ w = "100%", h = 14, r = 8 }: { w?: number | string; h?: number; r?: number }) {
  return <span className="block animate-pulse bg-surface" style={{ width: w, height: h, borderRadius: r }} />;
}
