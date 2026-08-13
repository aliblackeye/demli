"use client";

/** Ekranlar — uygulamanın tam yüzey önizlemeleri. Hepsi canlı:
 *  kanal seç, konuştur, mesaj gönder, Davet et'le gerçek kiplik açılır. */

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { EkranAyarlar, EkranBosMasa, EkranSesliOda, EkranYayinOdak, EkranYaziKanali } from "@/design/ekranlar";
import { DavetKipligi } from "@/design/organisms";
import { Bolum, SayfaBaslik, Spec } from "@/design/vitrin";

export default function Ekranlar() {
  const [davet, setDavet] = useState(false);
  return (
    <>
      <SayfaBaslik baslik="Ekranlar" aciklama="Yapı mevcut üründen (gruplar, kanallar, sesli oda, sohbet, ayarlar); stil bu sistemin reçeteleri. Masaüstü ve web bu görünümlere çekilecek. Hepsi canlı." />

      <Bolum id="sesli" baslik="Sesli oda" aciklama="Katılımcıya tıkla — konuşan (parıltı + halka) değişir; mesaj yaz, Enter'la gönder; sohbet kanalında okunmamış rozeti.">
        <Spec etiket="Sesli oda ekranı" deger={"üst çubuk: raised+blur hap\nadalar: radius 24, 8px boşluk\nkatılımcılar: karo + veil isim hapı\naltta akış + composer"}>
          <EkranSesliOda davetAc={() => setDavet(true)} />
        </Spec>
      </Bolum>

      <Bolum id="yazi" baslik="Yazı kanalı" aciklama="Akışta tarih ayracı, bahsetme, tepkiler (tıklanır), okunmadı ayracı ve yazıyor göstergesi; başlıkta ipuçlu ikon kutuları.">
        <Spec etiket="Yazı kanalı ekranı" deger={"tarih ayracı: beyaz %6 çift çizgi\nbahsetme: accent-soft çip\ntepki: rounded-50 — tıklanır\nokunmadı: accent-soft iz + çip"}>
          <EkranYaziKanali />
        </Spec>
      </Bolum>

      <Bolum id="yayin" baslik="Yayın odağı" aciklama="Büyük ekran paylaşımı + altta katılımcı şeridi; konuşana tıkla, halka taşınır.">
        <Spec etiket="Yayın odak ekranı" deger={"karo 16:9 tam genişlik\ncanlı hapı: kaynak + kalite\nkatılımcı şeridi: surface çipler\nkontroller ipuçlu"}>
          <EkranYayinOdak />
        </Spec>
      </Bolum>

      <Bolum id="ayarlar" baslik="Ayarlar" aciklama="Kabuk içinde ayarlar organizması — sekmeler ve tüm kontroller canlı.">
        <Spec etiket="Ayarlar ekranı" deger={"sol bölüm listesi + içerik paneli\ntehlike alanı: danger-soft kart"}>
          <EkranAyarlar />
        </Spec>
      </Bolum>

      <Bolum id="bos" baslik="Boş masa" aciklama="İlk açılış: masaya çağıran boş durum (tek tutam espri — copy-voice).">
        <Spec etiket="Boş masa ekranı" deger={"boş durum panel ortasında\neylem: mercan sm — Davet et\ngerçek kipliği açar"}>
          <EkranBosMasa davetAc={() => setDavet(true)} />
        </Spec>
      </Bolum>

      <AnimatePresence>
        {davet ? <DavetKipligi kapat={() => setDavet(false)} /> : null}
      </AnimatePresence>
    </>
  );
}
