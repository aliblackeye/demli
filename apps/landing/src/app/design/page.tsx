"use client";

/** Genel bakış — sistemin haritası ve hızlı giriş. */

import Link from "next/link";
import { T } from "@/design/tokens";
import { Avatar, AvatarKume, SayacRozeti, TepkiCipi, UrunButonu } from "@/design/atoms";
import { Composer } from "@/design/molecules";
import { SayfaBaslik, onest } from "@/design/vitrin";

const KARTLAR = [
  ["/design/temeller", "Temeller", "Renk · tipografi · boşluk & radius · durumlar · hareket", "5 bölüm"],
  ["/design/atomlar", "Atomlar", "Butonlar · avatar · form kontrolleri · çipler · mikro atomlar · iskelet", "14 bileşen"],
  ["/design/molekuller", "Moleküller", "Composer · sohbet akışı · listeler · arama & yayın · kimlik kartları · geri bildirim", "18 bileşen"],
  ["/design/organizmalar", "Organizmalar", "Kiplik sistemi (3 kiplik) · ayarlar kabuğu", "4 yüzey"],
  ["/design/ekranlar", "Ekranlar", "Sesli oda · yazı kanalı · yayın odağı · ayarlar · boş masa", "5 ekran"],
] as const;

export default function GenelBakis() {
  return (
    <>
      <SayfaBaslik
        baslik="Koyu Masa — Demli Design System v1"
        aciklama="Landing'den çıkarılmış tek sistem; web + masaüstü buna çekilecek. Yapı: src/design/ altında atomic design (tokens · atoms · molecules · organisms · ekranlar) — bu sayfalar template. Her örnek canlı. Onay gelmeden entegrasyon yok."
      />

      {/* Hızlı tat: birkaç canlı parça */}
      <div className="mt-6 flex flex-wrap items-center gap-4 rounded-[24px] bg-base p-6">
        <UrunButonu etiket="Odaya gir" tur="mercan" />
        <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
        <Avatar ad="E" boyut={40} konusuyor />
        <SayacRozeti sayi={3} />
        <TepkiCipi emoji="🍵" ilkSayi={1} benimki />
        <div className="min-w-[240px] flex-1"><Composer /></div>
      </div>

      {/* Sayfa haritası */}
      <div className="mt-8 grid gap-3 tb:grid-cols-2">
        {KARTLAR.map(([href, ad, aciklama, sayi]) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col gap-2 rounded-[24px] bg-base p-6 transition-colors duration-200 hover:bg-[rgba(23,23,23,0.72)]"
          >
            <div className="flex items-center justify-between">
              <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>{ad}</p>
              <span className="rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">{sayi}</span>
            </div>
            <p className="text-[13px] leading-[18px] text-text-dim">{aciklama}</p>
            <p className="mt-1 text-[13px] font-medium leading-[18px] transition-colors duration-200" style={{ color: T.accentStrong }}>Aç →</p>
          </Link>
        ))}
        <div className="flex flex-col gap-2 rounded-[24px] p-6" style={{ background: T.accentSoft }}>
          <p className={onest.className + " text-[20px] font-medium leading-[1.15]"} style={{ color: T.accentStrong }}>Kararlar</p>
          <p className="text-[13px] leading-[18px] text-text-secondary">
            Zeminler nötr siyah · vurgu Demli mercanı (#ff8464) · display Onest (OFL) ·
            koyu + açık-hazır tokenlar · kayan metin yalnız landing&apos;de · satır/buton
            hover&apos;ı ton geçişi (200ms) · doküman: docs/design-system/demli-design-system.md
          </p>
        </div>
      </div>
    </>
  );
}
