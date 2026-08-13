"use client";

/**
 * Demli Design System v1 "Koyu Masa" — SPEC SAYFASI (onay turu, v7).
 * Atomic design: src/design/tokens.ts + atoms.tsx + molecules.tsx +
 * organisms.tsx; bu sayfa TEMPLATE'tir (yalnız birleştirir ve belgeler).
 * Her bileşen ÇALIŞIR. Kayan metin hover'ı YALNIZ landing'de kalır.
 * Kaynak doküman: docs/design-system/demli-design-system.md
 */

import { Onest } from "next/font/google";
import { AnimatePresence, motion } from "framer-motion";
import { useRef, useState } from "react";
import { T, SPRING } from "@/design/tokens";
import {
  Anahtar,
  AramaAlani,
  Avatar,
  AvatarKume,
  BahsetmeCipi,
  GirisAlani,
  IkonButonu,
  OnayKutusu,
  Radyo,
  SesSurgusu,
  TepkiCipi,
  UrunButonu,
} from "@/design/atoms";
import {
  BaglamMenuluMesaj,
  BosDurum,
  Composer,
  DosyaKarti,
  EkranPaylasimKarosu,
  GelenAramaKarti,
  Ipucu,
  IskeletListe,
  KanalListesi,
  KatilimciTile,
  KullaniciCubugu,
  MesajSatiri,
  OkunmadiAyraci,
  ProfilKarti,
  SecimKutusu,
  UyeSatiri,
  YaziyorSatiri,
} from "@/design/molecules";
import { AyarlarKabugu, DavetKipligi, FormKipligi, OnayKipligi, UygulamaOnizleme } from "@/design/organisms";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

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
  ["sohbet", "Sohbet"],
  ["yayin", "Arama & yayın"],
  ["yukleme", "Yükleme & boş"],
  ["kiplikler", "Kiplikler"],
  ["kaplamalar", "Kaplamalar"],
  ["ayarlar", "Ayarlar"],
  ["profil", "Profil"],
  ["durum", "Durumlar"],
  ["hareket", "Hareket"],
  ["esleme", "Uygulama"],
] as const;

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
            <span className="ml-2 text-[12px] font-medium text-text-dim">design system v1 · atomic · her şey canlı</span>
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
            Atomic design: <span className="font-mono text-[13px] text-text-primary">src/design/</span> altında
            tokens · atoms · molecules · organisms; bu sayfa template. Yapı mevcut üründen, stil
            landing&apos;den doğma. Her örnek ÇALIŞIR — sürükle, yaz, aç-kapa, gönder.
          </p>
        </div>

        {/* 01 RENK */}
        <Bolum id="renk" baslik="01 · Renk" aciklama="İki katman: ham palet + anlamsal tokenlar (src/design/tokens.ts). Kenar çizgisi yok — derinlik yüzey tonuyla. Açık tema geldiğinde yalnız anlamsal değerler değişir.">
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

        {/* 02 TİPOGRAFİ */}
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

        {/* 03 BOŞLUK */}
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

        {/* 04 BUTONLAR */}
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

        {/* 05 HAP */}
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

        {/* 06 KARTLAR */}
        <Bolum id="kart" baslik="06 · Kartlar & paneller" aciklama="Panel: radius 24, bg-base, kenarsız, siyah boşlukla ayrılır. Panel içi kart: radius 16–18, bg-surface.">
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

        {/* 07 FORM */}
        <Bolum id="form" baslik="07 · Form" aciklama="Kenarsız, dolgulu dil: alanlar yüzeyle ayrılır, çizgi/ring yok. Focus'ta yüzey yarım ton açılır. Hepsi gerçek — yaz, sürükle, seç.">
          <Spec etiket="Composer" deger={"radius 18 · pad 14×24 · metin 16/24\nrest: #262626 · focus: #303030\n+ iç gölge imzası + mercan imleç"}>
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
          <Spec etiket="Ses sürgüsü — SÜRÜKLE" deger={"ray 4px tam yuvarlak #262626\ndolu: accent · top 14px beyaz\n+ 2px koyu halka · pointer tabanlı"}>
            <div className="flex max-w-[420px] flex-col gap-4 rounded-[16px] bg-base p-5">
              <SesSurgusu ad="Baran" baslangic={80} />
              <SesSurgusu ad="Ece" baslangic={100} />
            </div>
          </Spec>
        </Bolum>

        {/* 08 VALİDASYON */}
        <Bolum id="validasyon" baslik="08 · Validasyon" aciklama="Kenarsız dilde hata: alanın zemini danger-soft'a döner, altına düz tonlu tek mesaj gelir. Canlı: alanları boşalt/boz. Sıra copy-voice'tan: ne oldu → ne yapmalısın.">
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

        {/* 09 SATIRLAR */}
        <Bolum id="satirlar" baslik="09 · Satırlar & listeler" aciklama="Satır hover'ı sade: yalnız yüzey açılır (200ms). Bölüm etiketleri cümle düzeninde. Kanal seçimi ve bağlam menüsü canlı.">
          <Spec etiket="Kanal listesi (tıklanır)" deger={"satır: radius 12 · pad 10×12\nmetin 15 (500) ls −0.28\nseçili: accent-soft + accent-strong\nbölüm etiketi: 13 (500) dim"}>
            <KanalListesi />
          </Spec>
          <Spec etiket="Üye satırı" deger={"avatar 32 + 2px koyu halka\nonline nokta success\nses oranı: beyaz %12 hap"}>
            <div className="flex max-w-[300px] flex-col gap-1 rounded-[24px] bg-base p-3">
              <UyeSatiri ad="Baran" oran="%80" />
              <UyeSatiri ad="Ece" oran="%100" />
            </div>
          </Spec>
          <Spec etiket="Mesaj satırı + bağlam menüsü" deger={"BALONCUK YOK — sakin satır\nradius 16 · pad 10×12\nmenü: SAĞ TIKLA — öğeler çalışır\ntehlike öğesi: danger + soft hover"}>
            <BaglamMenuluMesaj />
          </Spec>
        </Bolum>

        {/* 10 SOHBET */}
        <Bolum id="sohbet" baslik="10 · Sohbet öğeleri" aciklama="Bahsetme, tepki, yazıyor, okunmadı ayracı ve dosya kartı — hepsi mesaj akışının içinde yaşar. Tepkilere tıkla, say/çıkar.">
          <Spec etiket="Sohbet akışı (canlı)" deger={"bahsetme: accent-soft çip\ntepki: rounded-50, benimki\n  accent-soft — tıklanır\nyazıyor: 3 nokta 1.2s nefes\nokunmadı: accent-soft iz + çip\ndosya: radius 16 surface kart"}>
            <div className="flex w-full max-w-[520px] flex-col rounded-[24px] bg-base p-2">
              <MesajSatiri ad="Ece" saat="21:04" cocuk={<>Çay hazır <BahsetmeCipi ad="Baran" /> sen de gel.</>} />
              <div className="flex gap-1.5 pb-1 pl-[52px]">
                <TepkiCipi emoji="🍵" ilkSayi={1} benimki />
                <TepkiCipi emoji="🎸" ilkSayi={2} />
              </div>
              <MesajSatiri ad="Baran" saat="21:05" cocuk={<DosyaKarti />} />
              <OkunmadiAyraci />
              <MesajSatiri ad="Kaan" saat="21:12" cocuk={<>Ben de geliyorum, film seçin.</>} />
              <YaziyorSatiri ad="Ece" />
            </div>
          </Spec>
        </Bolum>

        {/* 11 ARAMA & YAYIN */}
        <Bolum id="yayin" baslik="11 · Arama & yayın" aciklama="Gelen arama kartı canlı (Katıl/Reddet bas, geri döner); konuşan halkası ve yayın karosu landing'in parıltı imzasını taşır.">
          <Spec etiket="Gelen arama" deger={"radius 24 · bg-base\navatar 48 + nefes alan parıltı\n(1.4s ease) · Katıl: mercan sm\nReddet: tehlike sm"}>
            <GelenAramaKarti />
          </Spec>
          <Spec etiket="Katılımcı karosu" deger={"radius 24 · konuşana mercan\nparıltı + 2px halka\nisim: veil hapı — tıkla,\nkonuşan değişsin"}>
            <KatilimciDemo />
          </Spec>
          <Spec etiket="Ekran paylaşım karosu" deger={"16:9 · radius 24 · bg-surface\nsol üst: canlı hapı (mercan nokta\n+ kaynak + kalite)\nsağ alt: tam pencere kutusu"}>
            <EkranPaylasimKarosu />
          </Spec>
        </Bolum>

        {/* 12 YÜKLEME */}
        <Bolum id="yukleme" baslik="12 · Yükleme & boş durum" aciklama="İskelet nabızlı surface blok; boş durum masaya çağırır (tek tutam espri serbest — copy-voice).">
          <Spec etiket="İskelet" deger={"animate-pulse · bg-surface\nradius içerikle aynı\nmetin 10-12px yükseklik"}>
            <IskeletListe />
          </Spec>
          <Spec etiket="Boş durum" deger={"panel içinde ortalı\nikon kutusu 48 · başlık display 18\naçıklama 13 dim · eylem mercan sm"}>
            <BosDurum />
          </Spec>
        </Bolum>

        {/* 13 KİPLİKLER */}
        <Bolum id="kiplikler" baslik="13 · Kiplikler" aciklama="Gerçekten açılır: butona bas. Örtü veil+blur(4), kart radius 24 spring'le gelir, Escape ve dışarı tıklama kapatır. Form kipliğinde canlı validasyon var.">
          <Spec etiket="Üç kiplik" deger={"onay (yıkıcı): tehlike butonu\nform: canlı validasyon —\n  \"akşam odası\" yazıp dene;\n  ad geçersizken Oluştur kapalı\ndavet: Kopyala panoya yazar,\n  etiket 1.5s \"Kopyalandı\""}>
            <div className="flex flex-wrap gap-3">
              <UrunButonu etiket="Onay kipliğini aç" tikla={() => setKiplik("onay")} />
              <UrunButonu etiket="Form kipliğini aç" tikla={() => setKiplik("form")} />
              <UrunButonu etiket="Davet kipliğini aç" tikla={() => setKiplik("davet")} />
            </div>
          </Spec>
        </Bolum>

        {/* 14 KAPLAMALAR */}
        <Bolum id="kaplamalar" baslik="14 · Kaplamalar" aciklama="İpucu hover'da çıkar; bildirim butonla tetiklenir, 4 saniyede kendiliğinden gider.">
          <Spec etiket="İpucu" deger={"radius 8 · pad 6×10\nraised(.92)+blur · 12px (500)\nhover'da 200ms'de belirir"}>
            <Ipucu />
          </Spec>
          <Spec etiket="Bildirim (toast)" deger={"radius 16 · raised(.92)+blur\niç gölge imzası · sağ altta belirir\n4s sonra kendiliğinden gider"}>
            <UrunButonu etiket="Bildirim göster" tikla={toastGoster} />
          </Spec>
        </Bolum>

        {/* 15 AYARLAR */}
        <Bolum id="ayarlar" baslik="15 · Ayarlar" aciklama="Sekmeler gezilir, her kontrol çalışır: mikrofon seçimi, anahtarlar, sürgü, Hesap'ta canlı doğrulamalı ad alanı ve tehlike alanı.">
          <Spec etiket="Ayarlar kabuğu (canlı)" deger={"sol: bölüm listesi — tıkla\niçerik: seçim kutusu, ayar\nsatırları, sürgü, tehlike alanı"}>
            <AyarlarKabugu />
          </Spec>
        </Bolum>

        {/* 16 PROFİL */}
        <Bolum id="profil" baslik="16 · Profil & kimlik" aciklama="Avatarlar her boyda 2px koyu halka; konuşan +2px mercan halka. Profil kartında landing'in parıltısı kimlik bandı olur.">
          <Spec etiket="Avatar boyları" deger={"20 (küme) · 24 · 28 · 32 (satır)\n48 (arama) · 56 (tile) · 64 (profil)\nhalka: 2px #0d0d0d\nkonusan: +2px accent\nonline nokta: %30 boy, success"}>
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

        {/* 17 DURUMLAR */}
        <Bolum id="durum" baslik="17 · Durumlar" aciklama="Yeşil yalnız çevrimiçi/başarı. Hata pembe, düz tonda; ne oldu → ne yapılıyor → ne yapabilirsin sırasıyla (copy-voice).">
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

        {/* 18 HAREKET */}
        <Bolum id="hareket" baslik="18 · Hareket" aciklama="Üründe mikro hareket: ton geçişleri 200ms; konum değiştirenler authored spring (damping 60, stiffness 500). Kayan metin hover'ı ve pazarlama reveal'leri ÜRÜNE GİRMEZ.">
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

        {/* 19 UYGULAMA */}
        <Bolum id="esleme" baslik="19 · Uygulama önizlemesi & eşleme" aciklama="Her şey canlı: kanal seç, katılımcıya tıkla, mesaj yaz ve Enter'la gönder, Davet et'e bas, kullanıcı çubuğu kontrollerini aç/kapa.">
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
          Yapı: src/design/tokens.ts · atoms.tsx · molecules.tsx · organisms.tsx — bu sayfa template.
          Doküman: docs/design-system/demli-design-system.md · Onay gelmeden entegrasyon yok.
        </p>
      </main>

      <AnimatePresence>
        {kiplik === "onay" ? <OnayKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "form" ? <FormKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "davet" ? <DavetKipligi kapat={() => setKiplik(null)} /> : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24, transition: { duration: 0.15 } }} transition={SPRING} className="fixed bottom-6 right-6 z-50">
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

function KatilimciDemo() {
  const [konusan, setKonusan] = useState("Baran");
  return (
    <div className="flex w-full max-w-[520px] gap-2">
      {["Baran", "Ece"].map((a) => (
        <KatilimciTile key={a} ad={a} konusuyor={konusan === a} tikla={() => setKonusan(a)} />
      ))}
    </div>
  );
}
