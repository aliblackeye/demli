"use client";

/** Organizmalar — moleküllerin birleştiği büyük yüzeyler: kiplikler ve
 *  ayarlar kabuğu. Kiplikler gerçekten açılır. */

import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { UrunButonu } from "@/design/atoms";
import { AyarlarKabugu, DavetKipligi, FormKipligi, OnayKipligi } from "@/design/organisms";
import { Bolum, SayfaBaslik, Spec } from "@/design/vitrin";

export default function Organizmalar() {
  const [kiplik, setKiplik] = useState<null | "onay" | "form" | "davet">(null);
  return (
    <>
      <SayfaBaslik baslik="Organizmalar" aciklama="Moleküllerin birleştiği büyük yüzeyler (src/design/organisms.tsx): kiplik sistemi ve ayarlar kabuğu. Tam ekran birleşimleri Ekranlar sayfasında." />

      <Bolum id="kiplikler" baslik="Kiplikler" aciklama="Örtü veil+blur(4), kart radius 24 spring'le gelir; Escape ve dışarı tıklama kapatır.">
        <Spec etiket="Üç kiplik — gerçekten açılır" deger={"onay (yıkıcı): tehlike butonu\nform: canlı validasyon —\n  \"akşam odası\" yazıp dene;\n  ad geçersizken Oluştur kapalı\ndavet: Kopyala panoya yazar,\n  etiket 1.5s \"Kopyalandı\""}>
          <div className="flex flex-wrap gap-3">
            <UrunButonu etiket="Onay kipliğini aç" tikla={() => setKiplik("onay")} />
            <UrunButonu etiket="Form kipliğini aç" tikla={() => setKiplik("form")} />
            <UrunButonu etiket="Davet kipliğini aç" tikla={() => setKiplik("davet")} />
          </div>
        </Spec>
      </Bolum>

      <Bolum id="ayarlar" baslik="Ayarlar kabuğu" aciklama="Sekmeler gezilir, her kontrol çalışır: mikrofon seçimi, anahtarlar, sürgü; Hesap'ta canlı doğrulamalı ad alanı ve tehlike alanı.">
        <Spec etiket="Ayarlar (canlı)" deger={"sol: bölüm listesi — tıkla\niçerik: seçim kutusu, ayar\nsatırları, sürgü, tehlike alanı"}>
          <AyarlarKabugu />
        </Spec>
      </Bolum>

      <AnimatePresence>
        {kiplik === "onay" ? <OnayKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "form" ? <FormKipligi kapat={() => setKiplik(null)} /> : null}
        {kiplik === "davet" ? <DavetKipligi kapat={() => setKiplik(null)} /> : null}
      </AnimatePresence>
    </>
  );
}
