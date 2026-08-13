"use client";

/**
 * Koyu Masa — MOLEKÜLLER: atomların birleşimiyle oluşan işlevli parçalar.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Onest } from "next/font/google";
import { MaskIcon } from "@/components/atoms/MaskIcon";
import { Anahtar, Avatar, AvatarKume, IkonButonu, Iskelet, UrunButonu, YaziyorNoktalari } from "./atoms";
import { T } from "./tokens";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

/* ── Yazışma ──────────────────────────────────────────────────── */

export function Composer({ gonder, yerTutucu = "Mesaj yaz…" }: { gonder?: (m: string) => void; yerTutucu?: string }) {
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

export function MesajSatiri({ ad, saat, cocuk }: { ad: string; saat: string; cocuk: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-[16px] px-3 py-2.5 transition-colors duration-200 hover:bg-[#141414]">
      <span className="mt-0.5"><Avatar ad={ad} /></span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
          <span className="text-[12px] font-medium leading-[14.4px] tracking-[-0.24px] text-[#404040]">{saat}</span>
        </p>
        <div className="break-words text-[15px] leading-[22px] text-text-secondary">{cocuk}</div>
      </div>
    </div>
  );
}

/** Okunmadı ayracı — ince mercan iz + "yeni" çipi (tek çizgi istisnası) */
export function OkunmadiAyraci() {
  return (
    <div className="flex items-center gap-3 px-3 py-1">
      <span className="h-px flex-1" style={{ background: T.accentSoft }} />
      <span className="rounded-[50px] px-2 py-0.5 text-[11px] font-medium leading-[15px]" style={{ background: T.accentSoft, color: T.accentStrong }}>yeni</span>
    </div>
  );
}

export function YaziyorSatiri({ ad }: { ad: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <YaziyorNoktalari />
      <span className="text-[13px] leading-[18px] text-text-dim">{ad} yazıyor…</span>
    </div>
  );
}

/** Dosya kartı — mesaj içi ek */
export function DosyaKarti() {
  return (
    <div className="flex w-fit items-center gap-3 rounded-[16px] bg-surface py-3 pl-3 pr-2 transition-colors duration-200 hover:bg-surface-2">
      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-surface-2">
        <span className="text-[11px] font-semibold tracking-[0.04em]" style={{ color: T.accentStrong }}>MP3</span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-medium leading-[19.6px] text-text-primary">gitar-provasi.mp3</span>
        <span className="block text-[12px] leading-[16px] text-text-dim">4,2 MB</span>
      </span>
      <IkonButonu ikon="arrow-circle-down" boyut={32} baslik="İndir" />
    </div>
  );
}

/* ── Liste öğeleri ────────────────────────────────────────────── */

export function UyeSatiri({ ad, oran }: { ad: string; oran: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] px-3 py-2 transition-colors duration-200 hover:bg-surface">
      <Avatar ad={ad} cevrimici />
      <span className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] text-text-primary">{ad}</span>
      <span className="ml-auto rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2 py-0.5 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{oran}</span>
    </div>
  );
}

export function KanalListesi() {
  const [secili, setSecili] = useState("akşam odası");
  const kanallar = { Sesli: ["akşam odası", "film gecesi"], Yazı: ["sohbet", "oyun"] };
  return (
    <div className="flex max-w-[300px] flex-col gap-0.5 rounded-[24px] bg-base p-3">
      {Object.entries(kanallar).map(([grup, liste]) => (
        <div key={grup} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">{grup}</p>
          {liste.map((k) => (
            <button key={k} onClick={() => setSecili(k)} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: secili === k ? T.accentSoft : "transparent" }}
              onMouseEnter={(e) => { if (secili !== k) e.currentTarget.style.background = "#171717"; }}
              onMouseLeave={(e) => { if (secili !== k) e.currentTarget.style.background = "transparent"; }}>
              <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: secili === k ? T.accentStrong : "#a3a3a3" }}>{k}</span>
              {k === "akşam odası" ? <AvatarKume adlar={["Baran", "Ece"]} boyut={20} /> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AyarSatiri({ baslik, aciklama, acikMi, degistir }: { baslik: string; aciklama: string; acikMi: boolean; degistir: () => void }) {
  // Dış sarmalayıcı div: içteki Anahtar buton — buton içinde buton geçersiz.
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

export function SecimKutusu({ secenekler, ilk }: { secenekler: string[]; ilk: string }) {
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

export function BaglamMenuluMesaj() {
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
      <MesajSatiri ad="Ece" saat="21:04" cocuk={<>Çay hazır, oda açık. (sağ tıkla)</>} />
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

/* ── Arama & yayın ────────────────────────────────────────────── */

export function KatilimciTile({ ad, konusuyor, tikla }: { ad: string; konusuyor?: boolean; tikla?: () => void }) {
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

/** Ekran paylaşım karosu — canlı yayın çerçevesi */
export function EkranPaylasimKarosu() {
  const [tam, setTam] = useState(false);
  return (
    <div className="relative aspect-video w-full max-w-[480px] overflow-hidden rounded-[24px] bg-surface">
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[13px] leading-[18px] text-text-dim">yayın görüntüsü</span>
      </div>
      <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-2.5 py-1 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.accent }} />
        <span className="text-[12px] font-medium leading-[16px] text-[#e5e5e5]">Baran&apos;ın ekranı · 1080p60</span>
      </span>
      <span className="absolute bottom-3 right-3">
        <IkonButonu ikon="monitor" boyut={32} aktif={tam} tikla={() => setTam(!tam)} baslik="Tam pencere" />
      </span>
    </div>
  );
}

/** Gelen arama kartı — kabul/reddet */
export function GelenAramaKarti() {
  const [durum, setDurum] = useState<"caliyor" | "katildin" | "reddettin">("caliyor");
  useEffect(() => {
    if (durum === "caliyor") return;
    const z = setTimeout(() => setDurum("caliyor"), 1800);
    return () => clearTimeout(z);
  }, [durum]);
  return (
    <div className="flex w-fit items-center gap-4 rounded-[24px] bg-base p-4 pr-3">
      <span className="relative">
        <motion.span
          animate={durum === "caliyor" ? { scale: [1, 1.15, 1] } : { scale: 1 }}
          transition={{ duration: 1.4, repeat: durum === "caliyor" ? Infinity : 0, ease: "easeInOut" }}
          className="absolute inset-[-8px] rounded-full"
          style={{ background: T.glow, filter: "blur(6px)" }}
        />
        <Avatar ad="Ece" boyut={48} konusuyor={durum === "caliyor"} />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium leading-[19.6px] text-text-primary">Ece seni arıyor</span>
        <span className="block text-[13px] leading-[18px] text-text-dim">
          {durum === "caliyor" ? "akşam odası" : durum === "katildin" ? "katılıyorsun…" : "reddedildi"}
        </span>
      </span>
      <span className="flex items-center gap-2 pl-2">
        <UrunButonu etiket="Katıl" tur="mercan" boy="sm" tikla={() => setDurum("katildin")} />
        <UrunButonu etiket="Reddet" tur="tehlike" boy="sm" tikla={() => setDurum("reddettin")} />
      </span>
    </div>
  );
}

/* ── Kimlik kartları ──────────────────────────────────────────── */

export function ProfilKarti() {
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

export function KullaniciCubugu() {
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

/* ── Durum & yükleme ──────────────────────────────────────────── */

export function Ipucu() {
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

/** Boş durum — masaya çağıran ton (tek tutam espri serbest) */
export function BosDurum() {
  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-3 rounded-[24px] bg-base px-8 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-surface">
        <MaskIcon name="mail" size={22} color="#737373" />
      </span>
      <p className={onest.className + " text-[18px] font-medium leading-[1.2] text-white"}>Masa henüz boş</p>
      <p className="text-[13px] leading-[18px] text-text-dim">İlk mesajı sen yaz; çay nasılsa demleniyor.</p>
      <div className="mt-1"><UrunButonu etiket="Davet et" tur="mercan" boy="sm" /></div>
    </div>
  );
}

/** İskelet mesaj listesi — yüklenirken */
export function IskeletListe() {
  return (
    <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[24px] bg-base p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <span className="block h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <Iskelet w={90 + i * 30} h={10} />
            <Iskelet w="80%" h={12} />
          </div>
        </div>
      ))}
    </div>
  );
}

export { MesajSatiri as MesajSatiriTemel };
