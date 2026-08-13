"use client";

/** Atomlar — en küçük parçalar: butonlar, kimlik, form kontrolleri,
 *  çipler, mikro atomlar, iskelet. Hepsi canlı. */

import { useState } from "react";
import { T } from "@/design/tokens";
import {
  Anahtar,
  AramaAlani,
  Avatar,
  AvatarKume,
  BahsetmeCipi,
  GirisAlani,
  IkonButonu,
  Iskelet,
  KisayolTusu,
  NoktaDurum,
  OnayKutusu,
  Radyo,
  RolCipi,
  SayacRozeti,
  SesSurgusu,
  TepkiCipi,
  UrunButonu,
  YaziyorNoktalari,
} from "@/design/atoms";
import { Bolum, SayfaBaslik, Spec } from "@/design/vitrin";

export default function Atomlar() {
  const [kabul, setKabul] = useState(true);
  const [kalite, setKalite] = useState<"hd" | "fhd">("fhd");
  const [anahtar, setAnahtar] = useState(true);
  const [aktifler, setAktifler] = useState<Record<string, boolean>>({ monitor: true });
  return (
    <>
      <SayfaBaslik baslik="Atomlar" aciklama="Tek başına anlamlı en küçük ürün parçaları (src/design/atoms.tsx). Kayan metin hover'ı YOK — ürün hover'ı ton geçişi (200ms). Hepsi canlı: bas, yaz, sürükle." />

      <Bolum id="butonlar" baslik="Butonlar">
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
        <Spec etiket="İkon butonu (yerleşik ipuçlu)" deger={"40×40 (küçük 32) · radius 12\nrest #171717 → hover #262626\naktif: accent-soft + accent-strong\nüstüne gel: ipucu belirir · tıkla"}>
          <div className="flex items-center gap-2">
            {[["monitor", "Ekranı paylaş"], ["phone", "Ara"], ["star", "Mikrofon"], ["mail", "Mesaj"]].map(([ikon, ipucu]) => (
              <IkonButonu key={ikon} ikon={ikon} baslik={ipucu} aktif={!!aktifler[ikon]} tikla={() => setAktifler((e) => ({ ...e, [ikon]: !e[ikon] }))} />
            ))}
          </div>
        </Spec>
      </Bolum>

      <Bolum id="kimlik" baslik="Kimlik">
        <Spec etiket="Avatar" deger={"boylar: 20 · 24 · 28 · 32 · 48\n56 · 64 · halka: 2px #0d0d0d\nkonusan: +2px accent halka\nonline nokta: %30 boy, success"}>
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
        <Spec etiket="Mikro atomlar" deger={"durum noktası: 10px —\n  çevrimiçi/boşta/kapalı\nsayaç rozeti: 18px mercan hap\nkısayol tuşu: mono 11, iç gölge\nrol çipi: beyaz %12 hap"}>
          <div className="flex flex-wrap items-center gap-5 rounded-[16px] bg-base p-5">
            <span className="flex items-center gap-2"><NoktaDurum durum="cevrimici" /><span className="text-[13px] text-text-secondary">çevrimiçi</span></span>
            <span className="flex items-center gap-2"><NoktaDurum durum="bosta" /><span className="text-[13px] text-text-secondary">boşta</span></span>
            <span className="flex items-center gap-2"><NoktaDurum durum="kapali" /><span className="text-[13px] text-text-secondary">kapalı</span></span>
            <SayacRozeti sayi={3} />
            <SayacRozeti sayi={128} />
            <span className="flex items-center gap-1.5"><KisayolTusu tus="Ctrl" /><KisayolTusu tus="K" /></span>
            <RolCipi ad="kurucu" />
            <RolCipi ad="çaycı" />
          </div>
        </Spec>
        <Spec etiket="Sohbet çipleri" deger={"bahsetme: accent-soft, radius 6\ntepki: rounded-50; benimki\naccent-soft — tıkla, say/çıkar\nyazıyor: 3 nokta 1.2s nefes"}>
          <div className="flex flex-wrap items-center gap-4 rounded-[16px] bg-base p-5">
            <span className="text-[15px] leading-[22px] text-text-secondary">Çay hazır <BahsetmeCipi ad="Baran" /> sen de gel.</span>
            <TepkiCipi emoji="🍵" ilkSayi={1} benimki />
            <TepkiCipi emoji="🎸" ilkSayi={2} />
            <YaziyorNoktalari />
          </div>
        </Spec>
      </Bolum>

      <Bolum id="form" baslik="Form kontrolleri">
        <Spec etiket="Metin girişi (canlı doğrulamalı)" deger={"etiket 13 (500) üstte\nalan: radius 12 · pad 10×14\nrest #171717 · focus #262626\nhata: zemin danger-soft + alt mesaj\n(çerçeve/ring YOK)"}>
          <div className="grid max-w-[560px] gap-4 tb:grid-cols-2">
            <GirisAlani etiket="Görünen ad" ilkDeger="Baran" yardim="Masada herkese böyle görünürsün." dogrula={(v) => (v.trim() === "" ? "Ad boş olamaz." : v.length > 24 ? "En fazla 24 karakter." : null)} />
            <GirisAlani etiket="Durum" yerTutucu="🎸 gitar gecesi hazırlığı" />
          </div>
        </Spec>
        <Spec etiket="Arama" deger={"radius 12 · pad 10×14 · bg #171717\nfocus: #262626 · ikon dim 15px"}>
          <div className="max-w-[320px]"><AramaAlani /></div>
        </Spec>
        <Spec etiket="Anahtar / onay kutusu / radyo" deger={"anahtar 44×24, top authored spring\nonay: 18px radius 6\nradyo: seçili accent-soft satır"}>
          <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
            <div className="flex items-center gap-4">
              <Anahtar acikMi={anahtar} degistir={() => setAnahtar(!anahtar)} />
              <span className="text-[14px] font-medium leading-[19.6px] text-text-primary">Gürültü engelleyici</span>
            </div>
            <OnayKutusu etiket="Beni davet edilince haberdar et" isaretli={kabul} degistir={() => setKabul(!kabul)} />
            <div className="flex flex-col gap-1">
              <Radyo etiket="1080p · 60 kare" aciklama="Önerilen" secili={kalite === "fhd"} sec={() => setKalite("fhd")} />
              <Radyo etiket="720p · 30 kare" secili={kalite === "hd"} sec={() => setKalite("hd")} />
            </div>
          </div>
        </Spec>
        <Spec etiket="Ses sürgüsü — SÜRÜKLE" deger={"ray 4px tam yuvarlak #262626\ndolu: accent · top 14px beyaz\n+ 2px koyu halka · pointer tabanlı"}>
          <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
            <SesSurgusu ad="Baran" baslangic={80} />
            <SesSurgusu ad="Ece" baslangic={100} />
          </div>
        </Spec>
      </Bolum>

      <Bolum id="iskelet" baslik="İskelet">
        <Spec etiket="İskelet blokları" deger={"animate-pulse · bg-surface\nradius içerikle aynı"}>
          <div className="flex max-w-[360px] flex-col gap-3 rounded-[16px] bg-base p-5">
            <Iskelet w={120} h={10} />
            <Iskelet w="100%" h={12} />
            <Iskelet w="70%" h={12} />
          </div>
        </Spec>
      </Bolum>

      <Bolum id="hap" baslik="Hap & rozet" aciklama="Saydam zemin + blur + iç gölge imzası landing'den.">
        <Spec etiket="Veil hapı" deger={"radius 50 · bg-veil + blur(8)\niç gölge imzası\niçerik: 12px (500) #e5e5e5"}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 rounded-[50px] bg-[rgba(0,0,0,0.24)] px-2.5 py-1 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38,49,64,0.32) 0px -1px 0px 0px inset" }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: T.accent }} />
              <span className="text-[12px] font-medium leading-[16px] text-[#e5e5e5]">Baran</span>
            </span>
            <span className="rounded-[50px] bg-[rgba(255,255,255,0.12)] px-2.5 py-1 text-[12px] font-medium leading-[16px] text-[#e5e5e5]">%80</span>
            <span className="flex items-center gap-1.5 rounded-[50px] px-2.5 py-1 text-[12px] font-medium leading-[16px]" style={{ background: T.accentSoft, color: T.accentStrong }}>3 yeni</span>
          </div>
        </Spec>
      </Bolum>
    </>
  );
}
