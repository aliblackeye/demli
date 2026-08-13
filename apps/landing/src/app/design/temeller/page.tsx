"use client";

/** Temeller — renk, tipografi, boşluk & radius, durumlar, hareket. */

import { motion } from "framer-motion";
import { T, SPRING } from "@/design/tokens";
import { Anahtar, Avatar, UrunButonu } from "@/design/atoms";
import { Bolum, HareketSatiri, SayfaBaslik, Spec, Swatch, onest } from "@/design/vitrin";
import { useState } from "react";

export default function Temeller() {
  const [anahtar, setAnahtar] = useState(true);
  return (
    <>
      <SayfaBaslik baslik="Temeller" aciklama="Renk, tipografi, boşluk, radius, durum renkleri ve hareket dili. İki katmanlı token mimarisi (src/design/tokens.ts): açık tema geldiğinde yalnız anlamsal değerler değişir." />

      <Bolum id="renk" baslik="Renk" aciklama="Kenar çizgisi yok — derinlik yüzey tonuyla kurulur.">
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
            <Swatch ad="gold" deger={T.gold} koyu not="yıldız, uyarı" />
            <Swatch ad="success" deger={T.success} koyu not="YALNIZ çevrimiçi/başarı" />
            <Swatch ad="danger" deger={T.danger} koyu not="pembe — ≥30° hue ayrımı" />
          </div>
        </Spec>
      </Bolum>

      <Bolum id="tipografi" baslik="Tipografi" aciklama="Display: Onest (OFL, Türkçe tam). Gövde/UI: Inter. Üründe display yalnız başlık rollerinde.">
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

      <Bolum id="bosluk" baslik="Boşluk & radius" aciklama="4'lük taban. Panel içi pad 12–16; öğe içi 10×12; kart içi 20–24. Dış gölge yok; tek istisna hap iç gölgesi.">
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

      <Bolum id="durumlar" baslik="Durumlar" aciklama="Yeşil yalnız çevrimiçi/başarı. Hata pembe, düz tonda; ne oldu → ne yapılıyor → ne yapabilirsin sırasıyla (copy-voice).">
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

      <Bolum id="hareket" baslik="Hareket" aciklama="Üründe mikro hareket: ton geçişleri 200ms; konum değiştirenler authored spring (damping 60, stiffness 500). Kayan metin hover'ı ve pazarlama reveal'leri ÜRÜNE GİRMEZ — landing'e özgüdür.">
        <HareketSatiri ad="Panel girişi" deger={"y 24→0 + opacity\nspring damping 60, stiffness 500"}>
          {(tur) => (
            <motion.div key={tur} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="h-12 w-40 rounded-[16px] bg-surface-2" />
          )}
        </HareketSatiri>
        <HareketSatiri ad="Ton geçişi" deger={"background 200ms ease\n(satır, buton, kart hover'ı)"}>
          {() => <UrunButonu etiket="Üstüme gel" tur="ikincil" />}
        </HareketSatiri>
        <HareketSatiri ad="Anahtar" deger={"top hareketi authored spring"}>
          {() => <Anahtar acikMi={anahtar} degistir={() => setAnahtar(!anahtar)} />}
        </HareketSatiri>
      </Bolum>
    </>
  );
}
