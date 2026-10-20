"use client";

/**
 * Koyu Masa — vitrin yardımcıları: spec satırı, bölüm, renk kutusu,
 * hareket satırı. Yalnız design sayfalarında kullanılır.
 */

import { useState } from "react";

/** Onest — fonts.css'teki ürün fontu (build sırasında Google'dan indirilmez). */
export const onest = { className: "font-display" };

export function SayfaBaslik({ baslik, aciklama }: { baslik: string; aciklama: string }) {
  return (
    <div className="pb-2 pt-2">
      <h1 className={onest.className + " text-[32px] font-semibold leading-[1.1] tracking-[-0.2px] text-white"}>{baslik}</h1>
      <p className="mt-2 max-w-[720px] text-[14px] leading-[19.6px] text-text-secondary">{aciklama}</p>
    </div>
  );
}

export function Bolum({ id, baslik, aciklama, children }: { id: string; baslik: string; aciklama?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/[0.06] py-12">
      <h2 className={onest.className + " text-[22px] font-semibold leading-[1.15] text-white"}>{baslik}</h2>
      {aciklama ? <p className="mt-2 max-w-[720px] text-[14px] leading-[19.6px] text-text-secondary">{aciklama}</p> : null}
      <div className="mt-7 flex flex-col gap-9">{children}</div>
    </section>
  );
}

export function Spec({ etiket, deger, children }: { etiket: string; deger: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4 tb:grid-cols-[minmax(0,1fr)_290px] tb:items-start">
      <div className="min-w-0">{children}</div>
      <div className="rounded-[12px] bg-base p-4">
        <p className="text-[13px] font-medium leading-[18px] text-text-primary">{etiket}</p>
        <p className="mt-1 whitespace-pre-line font-mono text-[12px] leading-[18px] text-text-dim">{deger}</p>
      </div>
    </div>
  );
}

export function Swatch({ ad, deger, koyu, not }: { ad: string; deger: string; koyu?: boolean; not?: string }) {
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

export function HareketSatiri({ ad, deger, children }: { ad: string; deger: string; children: (tur: number) => React.ReactNode }) {
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
