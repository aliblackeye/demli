"use client";

/**
 * Demli Design System v1 "Koyu Masa" — SPEC SAYFASI (onay turu, v6 CANLI).
 * Her bileşen ÇALIŞIR: sürgüler sürüklenir, alanlar yazılır, kiplikler
 * açılır, bildirim tetiklenir, ayar sekmeleri gezilir, sohbete mesaj
 * gönderilir. Kayan metin hover'ı YALNIZ landing'de kalır.
 * Kaynak doküman: docs/design-system/demli-design-system.md
 */

import { Onest } from "next/font/google";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { MaskIcon } from "@/components/atoms/MaskIcon";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

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

const SPRING = { type: "spring", damping: 60, stiffness: 500, mass: 1 } as const;

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

/* ── ÜRÜN BİLEŞENLERİ — hepsi canlı; kayan metin YOK ─────────── */

type ButonTur = "birincil" | "ikincil" | "mercan" | "tehlike" | "hayalet";
type ButonBoy = "lg" | "md" | "sm";

function UrunButonu({ etiket, tur = "ikincil", boy = "md", devre, tikla }: { etiket: string; tur?: ButonTur; boy?: ButonBoy; devre?: boolean; tikla?: () => void }) {
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

function IkonButonu({ ikon, aktif, boyut = 40, tikla, baslik }: { ikon: string; aktif?: boolean; boyut?: number; tikla?: () => void; baslik?: string }) {
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

function Anahtar({ acikMi, degistir }: { acikMi: boolean; degistir: () => void }) {
  return (
    <button onClick={degistir} className="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200" style={{ background: acikMi ? T.accent : "#262626" }}>
      <motion.span animate={{ x: acikMi ? 22 : 2 }} transition={SPRING} className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white" style={{ left: 0 }} />
    </button>
  );
}

/* Sürüklenebilir ses sürgüsü — pointer tabanlı, gerçek değer */
function SesSurgusu({ ad, baslangic }: { ad: string; baslangic: number }) {
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
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          hesapla(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) hesapla(e.clientX);
        }}
      >
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-2" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ width: oran + "%", background: T.accent }} />
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${oran}% - 7px)`, boxShadow: "rgb(13,13,13) 0 0 0 2px" }} />
      </div>
      <span className="w-12 shrink-0 rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-center text-[12px] font-medium leading-[16px] text-[#e5e5e5]">%{oran}</span>
    </div>
  );
}

/* Gerçek metin girişi — yazılır; focus'ta yüzey açılır */
function GirisAlani({ etiket, ilkDeger = "", yardim, dogrula, yerTutucu = "yaz…" }: { etiket: string; ilkDeger?: string; yardim?: string; dogrula?: (v: string) => string | null; yerTutucu?: string }) {
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

/* Açılır-kapanır seçim kutusu — gerçek seçim */
function SecimKutusu({ secenekler, ilk }: { secenekler: string[]; ilk: string }) {
  const [secili, setSecili] = useState(ilk);
  const [acik, setAcik] = useState(false);
  const kok = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!acik) return;
    const kapa = (e: MouseEvent) => {
      if (kok.current && !kok.current.contains(e.target as Node)) setAcik(false);
    };
    document.addEventListener("mousedown", kapa);
    return () => document.removeEventListener("mousedown", kapa);
  }, [acik]);
  return (
    <div ref={kok} className="relative w-[220px]">
      <button onClick={() => setAcik(!acik)} className="flex w-full items-center justify-between rounded-[12px] bg-surface px-3.5 py-2.5 transition-colors duration-200 hover:bg-surface-2">
        <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">{secili}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={"transition-transform duration-200 " + (acik ? "rotate-180" : "")}><path d="M2.5 4.5 6 8l3.5-3.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <AnimatePresence>
        {acik ? (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="absolute left-0 top-[calc(100%+6px)] z-20 w-full rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px]">
            {secenekler.map((s) => (
              <button key={s} onClick={() => { setSecili(s); setAcik(false); }} className="flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-[14px] font-medium leading-[19.6px] transition-colors duration-200 hover:bg-surface-2" style={{ color: s === secili ? "#e5e5e5" : "#a3a3a3" }}>
                {s}
                {s === secili ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="m3 7.5 2.5 2.5L11 4.5" stroke={T.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* Gerçek composer — yazılır, Enter'la gönderir */
function Composer({ gonder, yerTutucu = "Mesaj yaz…" }: { gonder?: (m: string) => void; yerTutucu?: string }) {
  const [deger, setDeger] = useState("");
  const [odak, setOdak] = useState(false);
  const yolla = () => {
    if (!deger.trim()) return;
    gonder?.(deger.trim());
    setDeger("");
  };
  return (
    <div
      className="flex items-center gap-3 rounded-[18px] py-3.5 pl-6 pr-3 transition-colors duration-200"
      style={{ background: odak ? "#303030" : "#262626", boxShadow: odak ? "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" : undefined }}
    >
      <input
        value={deger}
        onChange={(e) => setDeger(e.target.value)}
        onFocus={() => setOdak(true)}
        onBlur={() => setOdak(false)}
        onKeyDown={(e) => { if (e.key === "Enter") yolla(); }}
        placeholder={yerTutucu}
        className="w-full bg-transparent text-[16px] leading-6 text-text-primary outline-none placeholder:text-text-dim"
        style={{ caretColor: T.accent }}
      />
      <IkonButonu ikon="arrow-circle-down" aktif={deger.trim().length > 0} tikla={yolla} baslik="Gönder (Enter)" />
    </div>
  );
}

function AramaAlani() {
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

function AvatarKume({ adlar, boyut = 24 }: { adlar: string[]; boyut?: number }) {
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

function Avatar({ ad, boyut = 32, cevrimici, konusuyor }: { ad: string; boyut?: number; cevrimici?: boolean; konusuyor?: boolean }) {
  const nokta = Math.max(10, Math.round(boyut * 0.3));
  return (
    <span className="relative flex shrink-0 items-center justify-center rounded-[1000px] bg-surface-2 font-medium text-text-primary" style={{ width: boyut, height: boyut, fontSize: Math.round(boyut * 0.38), boxShadow: konusuyor ? `rgb(13,13,13) 0 0 0 2px, ${T.accent} 0 0 0 4px` : "rgb(13,13,13) 0 0 0 2px" }}>
      {ad[0]}
      {cevrimici ? <span className="absolute rounded-full border-2 border-base" style={{ width: nokta, height: nokta, right: -2, bottom: -2, background: T.success }} /> : null}
    </span>
  );
}

function AyarSatiri({ baslik, aciklama, acikMi, degistir }: { baslik: string; aciklama: string; acikMi: boolean; degistir: () => void }) {
  // Dış sarmalayıcı div: içteki Anahtar zaten buton — buton içinde buton
  // geçersiz HTML (hydration hatası) olurdu.
  return (
    <div onClick={degistir} className="flex w-full cursor-pointer items-center justify-between gap-6 rounded-[16px] px-4 py-3.5 text-left transition-colors duration-200 hover:bg-surface">
      <span className="min-w-0">
        <span className="block text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{baslik}</span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-text-dim">{aciklama}</span>
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <Anahtar acikMi={acikMi} degistir={degistir} />
      </span>
    </div>
  );
}

/* Bağlam menüsü — mesaj satırına sağ tıklayınca açılır */
function BaglamMenuluMesaj() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [bilgi, setBilgi] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const kapa = () => setMenu(null);
    document.addEventListener("click", kapa);
    return () => document.removeEventListener("click", kapa);
  }, [menu]);
  const sec = (eylem: string) => {
    setMenu(null);
    setBilgi(eylem);
    setTimeout(() => setBilgi(null), 1600);
  };
  return (
    <div className="relative max-w-[480px] rounded-[24px] bg-base p-2" onContextMenu={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: e.clientX - r.left, y: e.clientY - r.top }); }}>
      <MesajSatiri ad="Ece" saat="21:04" metin="Çay hazır, oda açık. (sağ tıkla)" />
      {menu ? (
        <div className="absolute z-20 w-[180px] rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px]" style={{ left: Math.min(menu.x, 280), top: menu.y }}>
          {["Yanıtla", "Kopyala", "Sabitle"].map((s) => (
            <button key={s} onClick={() => sec(s)} className="block w-full rounded-[8px] px-3 py-2 text-left text-[14px] font-medium leading-[19.6px] text-text-secondary transition-colors duration-200 hover:bg-surface-2 hover:text-[#e5e5e5]">{s}</button>
          ))}
          <div className="mx-2 my-1 h-px bg-white/[0.06]" />
          <button onClick={() => sec("Sil")} className="block w-full rounded-[8px] px-3 py-2 text-left text-[14px] font-medium leading-[19.6px] transition-colors duration-200 hover:bg-[rgba(255,111,181,0.12)]" style={{ color: T.danger }}>Sil</button>
        </div>
      ) : null}
      {bilgi ? <p className="px-3 pb-1 text-[12px] leading-[16px]" style={{ color: T.accentStrong }}>{bilgi} seçildi</p> : null}
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
        <p className="break-words text-[15px] leading-[22px] text-text-secondary">{metin}</p>
      </div>
    </div>
  );
}

/* Hover'da görünen ipucu */
function Ipucu() {
  return (
    <div className="flex items-center gap-6">
      <span className="group relative inline-flex">
        <IkonButonu ikon="monitor" />
        <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] -translate-x-1/2 whitespace-nowrap rounded-[8px] bg-[rgba(23,23,23,0.92)] px-2.5 py-1.5 text-[12px] font-medium leading-[16px] text-[#e5e5e5] opacity-0 backdrop-blur-[10px] transition-opacity duration-200 group-hover:opacity-100">Ekranı paylaş</span>
      </span>
      <p className="text-[13px] leading-[18px] text-text-dim">← üstüne gel</p>
    </div>
  );
}

/* Profil kartı */
function ProfilKarti() {
  const [mesajYazildi, setMesajYazildi] = useState(false);
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
          <div className="flex-1 [&>button]:w-full [&>button]:justify-center">
            <UrunButonu etiket={mesajYazildi ? "Açılıyor…" : "Mesaj yaz"} tur="mercan" tikla={() => { setMesajYazildi(true); setTimeout(() => setMesajYazildi(false), 1200); }} />
          </div>
          <IkonButonu ikon="phone" baslik="Ara" />
        </div>
      </div>
    </div>
  );
}

function KullaniciCubugu() {
  const [mik, setMik] = useState(true);
  const [ekran, setEkran] = useState(false);
  return (
    <div className="flex w-[260px] items-center gap-2.5 rounded-[16px] bg-surface p-2 pl-2.5">
      <Avatar ad="Sen" boyut={32} cevrimici />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-[17px] text-text-primary">Sen</p>
        <p className="text-[11px] leading-[15px]" style={{ color: T.accentStrong }}>akşam odası</p>
      </div>
      <IkonButonu ikon="star" boyut={32} aktif={mik} tikla={() => setMik(!mik)} baslik="Mikrofon" />
      <IkonButonu ikon="monitor" boyut={32} aktif={ekran} tikla={() => setEkran(!ekran)} baslik="Ekran paylaş" />
    </div>
  );
}

function KatilimciTile({ ad, konusuyor, tikla }: { ad: string; konusuyor?: boolean; tikla?: () => void }) {
  return (
    <button onClick={tikla} className="relative flex h-40 flex-1 flex-col items-center justify-center overflow-hidden rounded-[24px] bg-base transition-colors duration-200 hover:bg-[#141414]">
      {konusuyor ? (
        <div className="absolute inset-x-[-40px] inset-y-[-20px] rounded-[100%]" style={{ background: `radial-gradient(50% 50%, ${T.glow} 0%, rgba(255,132,100,0) 100%)`, filter: "blur(8px)" }} />
      ) : null}
      <span className="relative"><Avatar ad={ad} boyut={56} konusuyor={konusuyor} /></span>
      <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-2.5 py-1 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
        {konusuyor ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.accent }} /> : null}
        <span className="text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{ad}</span>
      </span>
    </button>
  );
}

/* ── Kiplik sistemi — gerçekten açılır/kapanır ─────────────────── */

function KiplikOrtusu({ kapat, children }: { kapat: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const tus = (e: KeyboardEvent) => { if (e.key === "Escape") kapat(); };
    document.addEventListener("keydown", tus);
    return () => document.removeEventListener("keydown", tus);
  }, [kapat]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }} onClick={kapat}>
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24, transition: { duration: 0.15 } }} transition={SPRING} className="w-full max-w-[400px] rounded-[24px] bg-base p-6" onClick={(e) => e.stopPropagation()}>
        {children}
      </motion.div>
    </motion.div>
  );
}

function OnayKipligi({ kapat }: { kapat: () => void }) {
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanalı sil</p>
      <p className="mt-2 text-[14px] leading-[19.6px] text-text-secondary">&quot;oyun&quot; kanalı ve mesajları kalıcı olarak silinir. Bu geri alınamaz.</p>
      <div className="mt-6 flex justify-end gap-2">
        <UrunButonu etiket="Vazgeç" tur="hayalet" tikla={kapat} />
        <UrunButonu etiket="Kanalı sil" tur="tehlike" tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

function FormKipligi({ kapat }: { kapat: () => void }) {
  const [ad, setAd] = useState("");
  const [tur, setTur] = useState<"yazi" | "sesli">("sesli");
  const [odak, setOdak] = useState(false);
  const mevcut = ["akşam odası", "film gecesi", "sohbet", "oyun"];
  const hata = ad.trim() !== "" && mevcut.includes(ad.trim().toLowerCase()) ? "Bu ad zaten var. Başka bir ad seç." : null;
  const gecersiz = ad.trim() === "" || hata !== null;
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanal oluştur</p>
      <div className="mt-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Kanal adı</label>
          <div className="flex items-center rounded-[12px] px-3.5 py-2.5 transition-colors duration-200" style={{ background: hata ? T.dangerSoft : odak ? "#262626" : "#171717" }}>
            <input value={ad} onChange={(e) => setAd(e.target.value)} onFocus={() => setOdak(true)} onBlur={() => setOdak(false)} placeholder='"akşam odası" yazıp dene' className="w-full bg-transparent text-[14px] leading-[19.6px] text-text-primary outline-none placeholder:text-text-dim" style={{ caretColor: T.accent }} autoFocus />
          </div>
          {hata ? <p className="text-[13px] leading-[18px]" style={{ color: T.danger }}>{hata}</p> : null}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Tür</p>
          <Radyo etiket="Sesli kanal" aciklama="Konuşma, ekran ve kamera" secili={tur === "sesli"} sec={() => setTur("sesli")} />
          <Radyo etiket="Yazı kanalı" aciklama="Mesajlar ve dosyalar" secili={tur === "yazi"} sec={() => setTur("yazi")} />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <UrunButonu etiket="Vazgeç" tur="hayalet" tikla={kapat} />
        <UrunButonu etiket="Oluştur" tur="mercan" devre={gecersiz} tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

function DavetKipligi({ kapat }: { kapat: () => void }) {
  const [kopyalandi, setKopyalandi] = useState(false);
  const kopyala = () => {
    try {
      void navigator.clipboard.writeText("https://getdemli.com/davet/k7x2m9");
    } catch {
      // pano erişilemedi — etiket yine döner
    }
    setKopyalandi(true);
    setTimeout(() => setKopyalandi(false), 1500);
  };
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Masaya davet et</p>
      <p className="mt-1.5 text-[13px] leading-[18px] text-text-dim">Bağlantı 7 gün geçerli; istediğinde iptal edersin.</p>
      <div className="mt-4 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-[12px] bg-surface px-3.5 py-2.5">
          <span className="truncate font-mono text-[13px] leading-[18px] text-text-secondary">getdemli.com/davet/k7x2m9</span>
        </div>
        <UrunButonu etiket={kopyalandi ? "Kopyalandı" : "Kopyala"} tur="mercan" tikla={kopyala} />
      </div>
      <div className="mt-4 flex items-center justify-between rounded-[12px] bg-surface px-3.5 py-2.5">
        <span className="text-[13px] font-medium leading-[18px] text-text-primary">Masadakiler</span>
        <AvatarKume adlar={["Baran", "Ece", "Kaan"]} boyut={20} />
      </div>
      <div className="mt-6 flex justify-end">
        <UrunButonu etiket="Kapat" tur="hayalet" tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

/* ── Ayarlar kabuğu — sekmeler gezilir, içerik değişir ─────────── */

function AyarlarKabugu() {
  const [sekme, setSekme] = useState("Ses ve görüntü");
  const [gurultu, setGurultu] = useState(true);
  const [kapanista, setKapanista] = useState(true);
  const [davetBildirim, setDavetBildirim] = useState(true);
  const [sesBildirim, setSesBildirim] = useState(false);
  const sekmeler = ["Hesap", "Ses ve görüntü", "Bildirimler"];
  return (
    <div className="flex gap-2 rounded-[32px] bg-black p-2">
      <div className="flex w-52 shrink-0 flex-col gap-0.5 rounded-[24px] bg-base p-3">
        <p className={onest.className + " px-3 pb-2 pt-1 text-[18px] font-semibold leading-[1.15] text-white"}>Ayarlar</p>
        {sekmeler.map((s) => (
          <button key={s} onClick={() => setSekme(s)} className="flex items-center rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: sekme === s ? T.accentSoft : "transparent" }}
            onMouseEnter={(e) => { if (sekme !== s) e.currentTarget.style.background = "#171717"; }}
            onMouseLeave={(e) => { if (sekme !== s) e.currentTarget.style.background = "transparent"; }}>
            <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: sekme === s ? T.accentStrong : "#a3a3a3" }}>{s}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-5">
        <p className={onest.className + " px-1 pb-2 text-[20px] font-medium leading-[1.15] text-white"}>{sekme}</p>
        {sekme === "Hesap" ? (
          <>
            <div className="max-w-[320px]"><GirisAlani etiket="Görünen ad" ilkDeger="Baran" yardim="Masada herkese böyle görünürsün." dogrula={(v) => (v.trim() === "" ? "Ad boş olamaz." : v.length > 24 ? "En fazla 24 karakter." : null)} /></div>
            <div className="mt-2 rounded-[16px] p-4" style={{ background: T.dangerSoft }}>
              <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.danger }}>Hesabı sil</p>
              <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Mesajların ve üyeliklerin kalıcı olarak silinir. Bu geri alınamaz.</p>
              <div className="mt-3"><UrunButonu etiket="Hesabı sil" tur="tehlike" boy="sm" /></div>
            </div>
          </>
        ) : null}
        {sekme === "Ses ve görüntü" ? (
          <>
            <div className="rounded-[16px] bg-surface p-4">
              <p className="pb-2 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Mikrofon</p>
              <SecimKutusu secenekler={["Varsayılan — Yeti X", "Kulaklık mikrofonu", "Dahili mikrofon"]} ilk="Varsayılan — Yeti X" />
            </div>
            <AyarSatiri baslik="Gürültü engelleyici" aciklama="Müzik modunda kendiliğinden kapanır" acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />
            <AyarSatiri baslik="Kapanışta güncelle" aciklama="Yeni sürüm çıkışta sessizce kurulur" acikMi={kapanista} degistir={() => setKapanista(!kapanista)} />
            <div className="rounded-[16px] bg-surface p-4">
              <p className="pb-3 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Çıkış sesi</p>
              <SesSurgusu ad="Genel" baslangic={80} />
            </div>
          </>
        ) : null}
        {sekme === "Bildirimler" ? (
          <>
            <AyarSatiri baslik="Davet bildirimleri" aciklama="Masaya çağrılınca haber ver" acikMi={davetBildirim} degistir={() => setDavetBildirim(!davetBildirim)} />
            <AyarSatiri baslik="Bildirim sesi" aciklama="Yeni mesajda kısa ses çal" acikMi={sesBildirim} degistir={() => setSesBildirim(!sesBildirim)} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ── Uygulama önizlemesi — kanal seç, konuştur, mesaj gönder ───── */

function UygulamaOnizleme({ davetAc }: { davetAc: () => void }) {
  const [kanal, setKanal] = useState("akşam odası");
  const [konusan, setKonusan] = useState("Baran");
  const [mesajlar, setMesajlar] = useState([
    { ad: "Ece", saat: "21:04", metin: "Çay hazır, oda açık." },
    { ad: "Baran", saat: "21:05", metin: "Geliyorum, iki dakika." },
  ]);
  const kanallar = { sesli: ["akşam odası", "film gecesi"], yazi: ["sohbet", "oyun"] };
  const gonder = (m: string) => {
    const simdi = new Date();
    const saat = String(simdi.getHours()).padStart(2, "0") + ":" + String(simdi.getMinutes()).padStart(2, "0");
    setMesajlar((eski) => [...eski.slice(-5), { ad: "Sen", saat, metin: m }]);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <div className="flex items-center justify-between rounded-[16px] bg-[rgba(23,23,23,0.72)] py-2.5 pl-5 pr-2.5 backdrop-blur-[10px]">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-[12px]" style={{ background: T.accentSoft }}>
            <span className="text-[13px] font-semibold" style={{ color: T.accentStrong }}>D</span>
          </span>
          <span className={onest.className + " text-[17px] font-semibold text-white"}>bizim masa</span>
        </div>
        <div className="flex items-center gap-2">
          <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
          <UrunButonu etiket="Davet et" boy="sm" tikla={davetAc} />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex w-64 shrink-0 flex-col rounded-[24px] bg-base p-3">
          <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Sesli</p>
          {kanallar.sesli.map((k) => (
            <button key={k} onClick={() => setKanal(k)} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: kanal === k ? T.accentSoft : "transparent" }}
              onMouseEnter={(e) => { if (kanal !== k) e.currentTarget.style.background = "#171717"; }}
              onMouseLeave={(e) => { if (kanal !== k) e.currentTarget.style.background = "transparent"; }}>
              <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: kanal === k ? T.accentStrong : "#a3a3a3" }}>{k}</span>
              {k === "akşam odası" ? <AvatarKume adlar={["Baran", "Ece"]} boyut={20} /> : null}
            </button>
          ))}
          <p className="px-3 pb-1.5 pt-4 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Yazı</p>
          {kanallar.yazi.map((k) => (
            <button key={k} onClick={() => setKanal(k)} className="flex items-center rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: kanal === k ? T.accentSoft : "transparent" }}
              onMouseEnter={(e) => { if (kanal !== k) e.currentTarget.style.background = "#171717"; }}
              onMouseLeave={(e) => { if (kanal !== k) e.currentTarget.style.background = "transparent"; }}>
              <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: kanal === k ? T.accentStrong : "#a3a3a3" }}>{k}</span>
            </button>
          ))}
          <div className="mt-auto pt-4"><KullaniciCubugu /></div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-4">
          <p className={onest.className + " px-1 pb-1 text-[20px] font-medium leading-[1.15]"}>
            <span className="text-white">{kanal} </span>
            <span className="text-text-dim">{kanallar.sesli.includes(kanal) ? "· 3 kişi" : ""}</span>
          </p>
          {kanallar.sesli.includes(kanal) ? (
            <div className="flex gap-2">
              {["Baran", "Ece", "Kaan"].map((a) => (
                <KatilimciTile key={a} ad={a} konusuyor={konusan === a} tikla={() => setKonusan(a)} />
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex flex-col">
            {mesajlar.map((m, i) => (
              <MesajSatiri key={i} ad={m.ad} saat={m.saat} metin={m.metin} />
            ))}
          </div>
          <Composer gonder={gonder} yerTutucu="Mesaj yaz… (Enter'la gönder)" />
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
  const [kabul, setKabul] = useState(true);
  const [kalite, setKalite] = useState<"hd" | "fhd">("fhd");
  const [anahtarDemo, setAnahtarDemo] = useState(true);
  const [kiplik, setKiplik] = useState<null | "onay" | "form" | "davet">(null);
  const [toast, setToast] = useState(false);
  const toastZaman = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastGoster = () => {
    setToast(true);
    if (toastZaman.current) clearTimeout(toastZaman.current);
    toastZaman.current = setTimeout(() => setToast(false), 4000);
  };
  return (
    <div className="min-h-screen bg-black">
      <header className="sticky top-0 z-10 border-b border-white/[0.06] bg-black/85 backdrop-blur-[10px]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-5 gap-y-1 px-6 py-3">
          <span className={onest.className + " mr-2 text-[15px] font-semibold text-white"}>
            Koyu Masa<span style={{ color: T.accent }}>.</span>
            <span className="ml-2 text-[12px] font-medium text-text-dim">design system v1 · onay turu · her şey canlı</span>
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
            Ürün bileşen kütüphanesi — yapı mevcut üründen, stil landing&apos;den doğma ve her örnek
            ÇALIŞIR: sürükle, yaz, aç-kapa, gönder. Kayan metin hover&apos;ı yalnız landing&apos;de kalır;
            ürün hover&apos;ı ton geçişidir (200ms).
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
        <Bolum id="tipografi" baslik="02 · Tipografi" aciklama="Display: Onest (OFL, Türkçe tam). Gövde/UI: Inter. Üründe display yalnız başlık rollerinde; metin işi Inter'de.">
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
        <Bolum id="bosluk" baslik="03 · Boşluk & radius" aciklama="4'lük taban. Panel içi pad 12–16; öğe içi 10×12; kart içi 20–24. Dış gölge yok; tek istisna hap iç gölgesi.">
          <Spec etiket="Radius ölçeği" deger={"8 (menü öğesi) · 10 · 12 (satır,\nikon kutusu) · 14 · 16 (panel içi\nkart) · 18 (composer) · 24 (panel,\nkiplik) · 32 (dış kabuk) · 50 (hap)\ntam (avatar)"}>
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
        <Bolum id="butonlar" baslik="04 · Butonlar" aciklama="Kayan metin YOK — hover ton geçişi (200ms), basılı durumda bir ton koyu. Bas, tut, bırak — üç durumu da hisset.">
          <Spec etiket="Varyantlar (md)" deger={"birincil: #fff → hover #e5e5e5\nikincil: #262626 → #303030\nmercan: #ff8464 → #ffa48c\n  basılı: #e8624a\ntehlike: danger-soft + danger\nhayalet: saydam → #171717\ndevre dışı: %40"}>
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
          <Spec etiket="İkon butonu" deger={"40×40 (küçük 32) · radius 12\nrest #171717 → hover #262626\naktif: accent-soft + accent-strong\ntıkla — aç/kapa"}>
            <IkonDemo />
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
        <Bolum id="kart" baslik="06 · Kartlar & paneller" aciklama="Panel: radius 24, bg-base, kenarsız, siyah boşlukla ayrılır. Panel içi kart: radius 16–18, bg-surface. Hover gereken kartlarda zemin yarım ton açılır.">
          <Spec etiket="Panel + iç kart" deger={"panel: radius 24 · bg #0d0d0d\niç kart: radius 16 · bg #171717\nayraç çizgisi YOK"}>
            <div className="w-full max-w-[420px] rounded-[24px] bg-base p-4">
              <p className={onest.className + " px-1 pb-3 text-[20px] font-medium leading-[1.15] text-white"}>Ses ve görüntü</p>
              <div className="flex flex-col gap-2">
                <div className="rounded-[16px] bg-surface p-4">
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">Mikrofon</p>
                  <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Varsayılan — Yeti X</p>
                </div>
                <div className="cursor-pointer rounded-[16px] bg-surface p-4 transition-colors duration-200 hover:bg-surface-2">
                  <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">Hoparlör</p>
                  <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Kulaklık (hover&apos;lı kart)</p>
                </div>
              </div>
            </div>
          </Spec>
        </Bolum>

        {/* FORM */}
        <Bolum id="form" baslik="07 · Form" aciklama="Kenarsız, dolgulu dil: alanlar yüzeyle ayrılır, çizgi/ring yok. Focus'ta yüzey yarım ton açılır. Hepsi gerçek — yaz, sürükle, seç.">
          <Spec etiket="Composer" deger={"radius 18 · pad 14×24 · metin 16/24\nrest: #262626 · focus: #303030\n+ iç gölge imzası + mercan imleç\nEnter'la gönderir (uygulama\nönizlemesinde dene)"}>
            <div className="max-w-[520px]"><Composer /></div>
          </Spec>
          <Spec etiket="Metin girişi (canlı doğrulamalı)" deger={"etiket 13 (500) üstte\nalan: radius 12 · pad 10×14\nrest #171717 · focus #262626\nboş bırak ya da 24+ karakter yaz\n→ hata reçetesi devreye girer"}>
            <div className="grid max-w-[560px] gap-4 tb:grid-cols-2">
              <GirisAlani etiket="Görünen ad" ilkDeger="Baran" yardim="Masada herkese böyle görünürsün." dogrula={(v) => (v.trim() === "" ? "Ad boş olamaz." : v.length > 24 ? "En fazla 24 karakter." : null)} />
              <GirisAlani etiket="Durum" yerTutucu="🎸 gitar gecesi hazırlığı" />
            </div>
          </Spec>
          <Spec etiket="Arama" deger={"radius 12 · pad 10×14 · bg #171717\nfocus: #262626 · ikon dim 15px"}>
            <div className="max-w-[320px]"><AramaAlani /></div>
          </Spec>
          <Spec etiket="Seçim kutusu" deger={"tetik: radius 12 · pad 10×14\nmenü: radius 12 · p-1\nraised(.92)+blur10 · öğe radius 8\naktif: mercan check · tıkla, seç"}>
            <SecimKutusu secenekler={["720p · 30 kare", "1080p · 30 kare", "1080p · 60 kare"]} ilk="1080p · 60 kare" />
          </Spec>
          <Spec etiket="Anahtar / onay kutusu / radyo" deger={"anahtar 44×24, top authored spring\nonay: 18px radius 6\nradyo: seçili accent-soft satır"}>
            <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
              <div className="flex items-center gap-4">
                <Anahtar acikMi={anahtarDemo} degistir={() => setAnahtarDemo(!anahtarDemo)} />
                <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">Gürültü engelleyici</span>
              </div>
              <OnayKutusu etiket="Beni davet edilince haberdar et" isaretli={kabul} degistir={() => setKabul(!kabul)} />
              <div className="flex flex-col gap-1">
                <Radyo etiket="1080p · 60 kare" aciklama="Önerilen" secili={kalite === "fhd"} sec={() => setKalite("fhd")} />
                <Radyo etiket="720p · 30 kare" secili={kalite === "hd"} sec={() => setKalite("hd")} />
              </div>
            </div>
          </Spec>
          <Spec etiket="Ses sürgüsü — SÜRÜKLE" deger={"ray 4px tam yuvarlak #262626\ndolu: accent · top 14px beyaz\n+ 2px koyu halka · pointer tabanlı\ndeğer: beyaz %12 hap çipi"}>
            <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
              <SesSurgusu ad="Baran" baslangic={80} />
              <SesSurgusu ad="Ece" baslangic={100} />
            </div>
          </Spec>
        </Bolum>

        {/* VALİDASYON */}
        <Bolum id="validasyon" baslik="08 · Validasyon" aciklama="Kenarsız dilde hata: alanın zemini danger-soft'a döner, altına düz tonlu tek mesaj gelir. Canlı: alanları boşalt/boz, reçeteyi gör. Sıra copy-voice'tan: ne oldu → ne yapmalısın.">
          <Spec etiket="Alan hatası (canlı)" deger={"zemin: danger-soft (%12)\nmesaj: 13px danger, altta\nring/çerçeve YOK · espri yok\nkurallar: boş olamaz · mevcut\nadla çakışamaz"}>
            <div className="grid max-w-[560px] gap-4 tb:grid-cols-2">
              <GirisAlani etiket="Kanal adı" ilkDeger="akşam odası" dogrula={(v) => (v.trim() === "" ? "Kanal adı boş olamaz." : ["akşam odası", "film gecesi"].includes(v.trim().toLowerCase()) ? "Bu ad zaten var. Başka bir ad seç." : null)} />
              <GirisAlani etiket="Grup adı" yerTutucu="bizim masa" dogrula={(v) => (v.length > 0 && v.length < 3 ? "En az 3 karakter." : null)} />
            </div>
          </Spec>
          <Spec etiket="Form düzeyi hata" deger={"uyarı bandı: radius 12\ndanger-soft zemin + danger metin"}>
            <div className="flex max-w-[560px] items-center gap-3 rounded-[12px] px-4 py-3" style={{ background: T.dangerSoft }}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: T.danger }} />
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.danger }}>Bağlantı koptu. Oda yeniden bağlanıyor; bağlanamazsa mikrofonun kapalı kalır.</p>
            </div>
          </Spec>
        </Bolum>

        {/* SATIRLAR */}
        <Bolum id="satirlar" baslik="09 · Satırlar & listeler" aciklama="Satır hover'ı sade: yalnız yüzey açılır (200ms). Bölüm etiketleri cümle düzeninde. Kanal seçimi ve bağlam menüsü canlı.">
          <Spec etiket="Kanal listesi (tıklanır)" deger={"satır: radius 12 · pad 10×12\nmetin 15 (500) ls −0.28\nseçili: accent-soft + accent-strong\nbölüm etiketi: 13 (500) dim"}>
            <KanalListesiDemo />
          </Spec>
          <Spec etiket="Üye satırı" deger={"avatar 32 + 2px koyu halka\nonline nokta success\nses oranı hapı gerçek sürgüyle\nbirlikte (Form bölümünde)"}>
            <div className="flex max-w-[300px] flex-col gap-1 rounded-[24px] bg-base p-3">
              {[["Baran", "%80"], ["Ece", "%100"]].map(([ad, oran]) => (
                <div key={ad} className="flex items-center gap-2.5 rounded-[12px] px-3 py-2 transition-colors duration-200 hover:bg-surface">
                  <Avatar ad={ad} cevrimici />
                  <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
                  <span className="ml-auto rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{oran}</span>
                </div>
              ))}
            </div>
          </Spec>
          <Spec etiket="Mesaj satırı + bağlam menüsü" deger={"BALONCUK YOK — sakin satır\nradius 16 · pad 10×12\nmenü: SAĞ TIKLA — öğeler çalışır\ntehlike öğesi: danger + soft hover"}>
            <BaglamMenuluMesaj />
          </Spec>
        </Bolum>

        {/* KİPLİKLER */}
        <Bolum id="kiplikler" baslik="10 · Kiplikler" aciklama="Gerçekten açılır: butona bas. Örtü veil+blur(4), kart radius 24 spring'le gelir, Escape ve dışarı tıklama kapatır. Form kipliğinde canlı validasyon var.">
          <Spec etiket="Üç kiplik" deger={"onay (yıkıcı): tehlike butonu\nform: canlı validasyon —\n  \"akşam odası\" yazıp dene;\n  ad geçersizken Oluştur kapalı\ndavet: Kopyala gerçekten panoya\n  yazar, etiket 1.5s \"Kopyalandı\""}>
            <div className="flex flex-wrap gap-3">
              <UrunButonu etiket="Onay kipliğini aç" tikla={() => setKiplik("onay")} />
              <UrunButonu etiket="Form kipliğini aç" tikla={() => setKiplik("form")} />
              <UrunButonu etiket="Davet kipliğini aç" tikla={() => setKiplik("davet")} />
            </div>
          </Spec>
        </Bolum>

        {/* KAPLAMALAR */}
        <Bolum id="kaplamalar" baslik="11 · Kaplamalar" aciklama="İpucu hover'da çıkar; bildirim butonla tetiklenir, 4 saniyede kendiliğinden gider.">
          <Spec etiket="İpucu" deger={"radius 8 · pad 6×10\nraised(.92)+blur · 12px (500)\nhover'da 200ms'de belirir"}>
            <Ipucu />
          </Spec>
          <Spec etiket="Bildirim (toast)" deger={"radius 16 · raised(.92)+blur\niç gölge imzası · sağ altta belirir\n4s sonra kendiliğinden gider\nKatıl: mercan sm buton"}>
            <UrunButonu etiket="Bildirim göster" tikla={toastGoster} />
          </Spec>
        </Bolum>

        {/* AYARLAR */}
        <Bolum id="ayarlar" baslik="12 · Ayarlar" aciklama="Sekmeler gezilir, her kontrol çalışır: mikrofon seçimi, anahtarlar, sürgü, Hesap'ta canlı doğrulamalı ad alanı ve tehlike alanı.">
          <Spec etiket="Ayarlar kabuğu (canlı)" deger={"sol: bölüm listesi — tıkla\niçerik: seçim kutusu, ayar\nsatırları, sürgü, tehlike alanı\nHesap sekmesi: doğrulamalı alan"}>
            <AyarlarKabugu />
          </Spec>
        </Bolum>

        {/* PROFİL */}
        <Bolum id="profil" baslik="13 · Profil & kimlik" aciklama="Avatarlar her boyda 2px koyu halka; konuşan +2px mercan halka. Profil kartında landing'in parıltısı kimlik bandı olur.">
          <Spec etiket="Avatar boyları" deger={"20 (küme) · 24 · 28 · 32 (satır)\n56 (tile) · 64 (profil)\nhalka: 2px #0d0d0d\nkonusan: +2px accent\nonline nokta: %30 boy, success"}>
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
          <Spec etiket="Profil kartı" deger={"radius 24 · bg-base · kenarsız\nüst: mercan parıltı bandı\navatar 64 · ad display 20 (500)\nroller: beyaz %12 hap\neylemler tıklanır"}>
            <ProfilKarti />
          </Spec>
          <Spec etiket="Kullanıcı çubuğu" deger={"radius 16 · bg-surface · p 8\nkontroller 32px — tıkla, aç/kapa"}>
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
              <p className="text-[14px] leading-[19.6px]" style={{ color: T.danger }}>Bağlantı koptu. Oda yeniden bağlanıyor; bağlanamazsa mikrofonun kapalı kalır.</p>
            </div>
          </Spec>
        </Bolum>

        {/* HAREKET */}
        <Bolum id="hareket" baslik="15 · Hareket" aciklama="Üründe mikro hareket: ton geçişleri 200ms; konum değiştirenler authored spring (damping 60, stiffness 500). Kayan metin hover'ı ve pazarlama reveal'leri ÜRÜNE GİRMEZ.">
          <HareketSatiri ad="Panel girişi" deger={"y 24→0 + opacity\nspring damping 60, stiffness 500"}>
            {(tur) => (
              <motion.div key={tur} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="h-12 w-40 rounded-[16px] bg-surface-2" />
            )}
          </HareketSatiri>
          <HareketSatiri ad="Ton geçişi" deger={"background 200ms ease\n(satır, buton, kart hover'ı)"}>
            {() => <UrunButonu etiket="Üstüme gel" tur="ikincil" />}
          </HareketSatiri>
          <HareketSatiri ad="Anahtar" deger={"top hareketi authored spring"}>
            {() => <Anahtar acikMi={anahtarDemo} degistir={() => setAnahtarDemo(!anahtarDemo)} />}
          </HareketSatiri>
        </Bolum>

        {/* UYGULAMA */}
        <Bolum id="esleme" baslik="16 · Uygulama önizlemesi & eşleme" aciklama="Her şey canlı: kanal seç, katılımcıya tıkla (konuşan değişir), mesaj yaz ve Enter'la gönder, Davet et'e bas (gerçek kiplik açılır), kullanıcı çubuğundaki kontrolleri aç/kapa.">
          <Spec etiket="Uygulama dili (canlı)" deger={"üst çubuk: raised+blur hap\nadalar: radius 24, 8px boşluk\nkonuşan: mercan parıltı + halka\nmesaj: baloncuksuz satır\ncomposer: Enter'la gönderir"}>
            <UygulamaOnizleme davetAc={() => setKiplik("davet")} />
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

      {/* Kiplikler */}
      <AnimatePresence>
        {kiplik === "onay" ? <OnayKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "form" ? <FormKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "davet" ? <DavetKipligi kapat={() => setKiplik(null)} /> : null}
      </AnimatePresence>

      {/* Bildirim */}
      <AnimatePresence>
        {toast ? (
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={SPRING} className="fixed bottom-6 right-6 z-50">
            <div className="flex items-center gap-3 rounded-[16px] bg-[rgba(23,23,23,0.92)] py-3 pl-4 pr-3 backdrop-blur-[10px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
              <Avatar ad="Ece" boyut={28} />
              <div>
                <p className="text-[13px] font-medium leading-[17px] text-text-primary">Ece seni aradı</p>
                <p className="text-[12px] leading-[16px] text-text-dim">akşam odası · az önce</p>
              </div>
              <UrunButonu etiket="Katıl" tur="mercan" boy="sm" tikla={() => setToast(false)} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* Küçük canlı demolar */
function IkonDemo() {
  const [aktifler, setAktifler] = useState<Record<string, boolean>>({ monitor: true });
  const cevir = (k: string) => setAktifler((e) => ({ ...e, [k]: !e[k] }));
  return (
    <div className="flex items-center gap-2">
      {["monitor", "phone", "star", "mail"].map((ikon) => (
        <IkonButonu key={ikon} ikon={ikon} aktif={!!aktifler[ikon]} tikla={() => cevir(ikon)} />
      ))}
    </div>
  );
}

function KanalListesiDemo() {
  const [secili, setSecili] = useState("akşam odası");
  const kanallar = { Sesli: ["akşam odası", "film gecesi"], Yazı: ["sohbet", "oyun"] };
  return (
    <div className="flex max-w-[300px] flex-col gap-0.5 rounded-[24px] bg-base p-3">
      {Object.entries(kanallar).map(([grup, liste]) => (
        <div key={grup} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">{grup}</p>
          {liste.map((k) => (
            <button key={k} onClick={() => setSecili(k)} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: secili === k ? "rgba(255,132,100,0.12)" : "transparent" }}
              onMouseEnter={(e) => { if (secili !== k) e.currentTarget.style.background = "#171717"; }}
              onMouseLeave={(e) => { if (secili !== k) e.currentTarget.style.background = "transparent"; }}>
              <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: secili === k ? "#ffa48c" : "#a3a3a3" }}>{k}</span>
              {k === "akşam odası" ? <AvatarKume adlar={["Baran", "Ece"]} boyut={20} /> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
