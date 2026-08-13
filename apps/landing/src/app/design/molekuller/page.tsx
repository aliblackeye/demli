"use client";

/** Moleküller — atomların birleşimiyle oluşan işlevli parçalar. Hepsi canlı. */

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SPRING } from "@/design/tokens";
import { Avatar, BahsetmeCipi, TepkiCipi, UrunButonu } from "@/design/atoms";
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
  TarihAyraci,
  UyeSatiri,
  YaziyorSatiri,
} from "@/design/molecules";
import { Bolum, SayfaBaslik, Spec } from "@/design/vitrin";

export default function Molekuller() {
  const [toast, setToast] = useState(false);
  const zaman = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [konusan, setKonusan] = useState("Baran");
  const toastGoster = () => {
    setToast(true);
    if (zaman.current) clearTimeout(zaman.current);
    zaman.current = setTimeout(() => setToast(false), 4000);
  };
  return (
    <>
      <SayfaBaslik baslik="Moleküller" aciklama="Atomların birleşimiyle oluşan işlevli parçalar (src/design/molecules.tsx). Hepsi canlı: yaz, seç, sağ tıkla, tetikle." />

      <Bolum id="yazisma" baslik="Yazışma">
        <Spec etiket="Composer" deger={"radius 18 · pad 14×24 · metin 16/24\nrest: #262626 · focus: #303030\n+ iç gölge imzası + mercan imleç"}>
          <div className="max-w-[520px]"><Composer /></div>
        </Spec>
        <Spec etiket="Sohbet akışı" deger={"mesaj: baloncuksuz satır, radius 16\ntarih ayracı: beyaz %6 çizgi çifti\nokunmadı: accent-soft iz + çip\nyazıyor: 3 nokta + 13px dim"}>
          <div className="flex w-full max-w-[520px] flex-col rounded-[24px] bg-base p-2">
            <TarihAyraci etiket="Bugün" />
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
        <Spec etiket="Bağlam menüsü" deger={"SAĞ TIKLA — radius 12, p-1\nraised(.92)+blur10 · öğe radius 8\ntehlike öğesi: danger + soft hover"}>
          <BaglamMenuluMesaj />
        </Spec>
      </Bolum>

      <Bolum id="listeler" baslik="Listeler">
        <Spec etiket="Kanal listesi (tıklanır)" deger={"satır: radius 12 · pad 10×12\nseçili: accent-soft + accent-strong\nbölüm etiketi: 13 (500) dim,\ncümle düzeni"}>
          <KanalListesi />
        </Spec>
        <Spec etiket="Üye satırı" deger={"avatar 32 + 2px koyu halka\nonline nokta success\nses oranı: beyaz %12 hap"}>
          <div className="flex max-w-[300px] flex-col gap-1 rounded-[24px] bg-base p-3">
            <UyeSatiri ad="Baran" oran="%80" />
            <UyeSatiri ad="Ece" oran="%100" />
          </div>
        </Spec>
        <Spec etiket="Seçim kutusu" deger={"tetik: radius 12 · pad 10×14\nmenü: raised(.92)+blur10\naktif: mercan check — tıkla, seç"}>
          <SecimKutusu secenekler={["720p · 30 kare", "1080p · 30 kare", "1080p · 60 kare"]} ilk="1080p · 60 kare" />
        </Spec>
      </Bolum>

      <Bolum id="arama" baslik="Arama & yayın">
        <Spec etiket="Gelen arama" deger={"radius 24 · avatar 48 + nefes alan\nparıltı (1.4s) · Katıl: mercan sm\nReddet: tehlike sm — bas, dene"}>
          <GelenAramaKarti />
        </Spec>
        <Spec etiket="Katılımcı karosu" deger={"radius 24 · konuşana mercan\nparıltı + halka — tıkla, değişsin"}>
          <div className="flex w-full max-w-[520px] gap-2">
            {["Baran", "Ece"].map((a) => (
              <KatilimciTile key={a} ad={a} konusuyor={konusan === a} tikla={() => setKonusan(a)} />
            ))}
          </div>
        </Spec>
        <Spec etiket="Ekran paylaşım karosu" deger={"16:9 · radius 24 · bg-surface\ncanlı hapı + tam pencere kutusu"}>
          <EkranPaylasimKarosu />
        </Spec>
      </Bolum>

      <Bolum id="kimlik" baslik="Kimlik kartları">
        <Spec etiket="Profil kartı" deger={"radius 24 · bg-base · kenarsız\nüst: mercan parıltı bandı\navatar 64 · ad display 20 (500)\nroller: beyaz %12 hap"}>
          <ProfilKarti />
        </Spec>
        <Spec etiket="Kullanıcı çubuğu" deger={"radius 16 · bg-surface · p 8\nkontroller 32px — tıkla, aç/kapa\n(ipuçları hover'da)"}>
          <KullaniciCubugu />
        </Spec>
      </Bolum>

      <Bolum id="geribildirim" baslik="Geri bildirim">
        <Spec etiket="İpucu" deger={"radius 8 · pad 6×10\nraised(.92)+blur · hover'da belirir"}>
          <Ipucu />
        </Spec>
        <Spec etiket="Bildirim (toast)" deger={"radius 16 · raised(.92)+blur\nsağ altta belirir, 4s sonra gider"}>
          <UrunButonu etiket="Bildirim göster" tikla={toastGoster} />
        </Spec>
        <Spec etiket="Boş durum & iskelet" deger={"boş: ikon 48 + display 18 +\nmercan sm eylem\niskelet: animate-pulse surface"}>
          <div className="flex flex-wrap gap-4">
            <BosDurum />
            <IskeletListe />
          </div>
        </Spec>
      </Bolum>

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
    </>
  );
}
