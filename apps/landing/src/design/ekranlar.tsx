"use client";

/**
 * Koyu Masa — EKRANLAR: uygulamanın tam yüzey önizlemeleri.
 * Yapı mevcut üründen (gruplar, kanallar, sesli oda, sohbet, ayarlar);
 * stil bu sistemin reçeteleri. Hepsi canlı: kanal seç, konuştur, yaz.
 */

import { useState } from "react";
import {
  Avatar,
  AvatarKume,
  BahsetmeCipi,
  IkonButonu,
  NoktaDurum,
  SayacRozeti,
  TepkiCipi,
  UrunButonu,
} from "./atoms";
import {
  BolumEtiketi,
  Composer,
  EkranPaylasimKarosu,
  KatilimciTile,
  KullaniciCubugu,
  MesajSatiri,
  OkunmadiAyraci,
  TarihAyraci,
  YaziyorSatiri,
} from "./molecules";
import { AyarlarKabugu } from "./organisms";
import { T } from "./tokens";

/** Onest — fonts.css'teki ürün fontu (build sırasında Google'dan indirilmez). */
const onest = { className: "font-display" };

/* ── Ortak kabuk parçaları ────────────────────────────────────── */

function UstCubuk({ davetAc }: { davetAc?: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-[16px] bg-[rgba(23,23,23,0.72)] py-2.5 pl-5 pr-2.5 backdrop-blur-[10px]">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-[12px]" style={{ background: T.accentSoft }}>
          <span className="text-[13px] font-semibold" style={{ color: T.accentStrong }}>D</span>
        </span>
        <span className={onest.className + " text-[17px] font-semibold text-white"}>bizim masa</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="translate-y-[1px]"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div className="flex items-center gap-2">
        <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
        <UrunButonu etiket="Davet et" boy="sm" tikla={davetAc} />
      </div>
    </div>
  );
}

function KanalPaneli({ kanal, sec, okunmamis }: { kanal: string; sec: (k: string) => void; okunmamis?: Record<string, number> }) {
  const satir = (k: string, kume?: boolean) => (
    <button key={k} onClick={() => sec(k)} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: kanal === k ? T.accentSoft : "transparent" }}
      onMouseEnter={(e) => { if (kanal !== k) e.currentTarget.style.background = "#171717"; }}
      onMouseLeave={(e) => { if (kanal !== k) e.currentTarget.style.background = "transparent"; }}>
      <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: kanal === k ? T.accentStrong : "#a3a3a3" }}>{k}</span>
      <span className="flex items-center gap-1.5">
        {okunmamis?.[k] ? <SayacRozeti sayi={okunmamis[k]} /> : null}
        {kume ? <AvatarKume adlar={["Baran", "Ece"]} boyut={20} /> : null}
      </span>
    </button>
  );
  return (
    <div className="flex w-64 shrink-0 flex-col rounded-[24px] bg-base p-3">
      <BolumEtiketi etiket="Sesli" />
      {satir("akşam odası", true)}
      {satir("film gecesi")}
      <BolumEtiketi etiket="Yazı" />
      {satir("sohbet")}
      {satir("oyun")}
      <div className="mt-auto pt-4"><KullaniciCubugu /></div>
    </div>
  );
}

/* ── Ekranlar ─────────────────────────────────────────────────── */

/** Sesli oda ekranı — katılımcı karoları + sohbet akışı */
export function EkranSesliOda({ davetAc }: { davetAc?: () => void }) {
  const [kanal, setKanal] = useState("akşam odası");
  const [konusan, setKonusan] = useState("Baran");
  const [mesajlar, setMesajlar] = useState([
    { ad: "Ece", saat: "21:04", metin: "Çay hazır, oda açık." },
    { ad: "Baran", saat: "21:05", metin: "Geliyorum, iki dakika." },
  ]);
  const gonder = (m: string) => {
    const t = new Date();
    setMesajlar((e) => [...e.slice(-4), { ad: "Sen", saat: String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"), metin: m }]);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <UstCubuk davetAc={davetAc} />
      <div className="flex gap-2">
        <KanalPaneli kanal={kanal} sec={setKanal} okunmamis={{ sohbet: 3 }} />
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-4">
          <p className={onest.className + " px-1 pb-1 text-[20px] font-medium leading-[1.15]"}>
            <span className="text-white">{kanal} </span>
            <span className="text-text-dim">· 3 kişi</span>
          </p>
          <div className="flex gap-2">
            {["Baran", "Ece", "Kaan"].map((a) => (
              <KatilimciTile key={a} ad={a} konusuyor={konusan === a} tikla={() => setKonusan(a)} />
            ))}
          </div>
          <div className="mt-1 flex flex-col">
            {mesajlar.map((m, i) => (
              <MesajSatiri key={i} ad={m.ad} saat={m.saat} cocuk={<>{m.metin}</>} />
            ))}
          </div>
          <Composer gonder={gonder} yerTutucu="Mesaj yaz… (Enter'la gönder)" />
        </div>
      </div>
    </div>
  );
}

/** Yazı kanalı ekranı — akış: tarih ayracı, bahsetme, tepki, okunmadı, yazıyor */
export function EkranYaziKanali() {
  const [mesajlar, setMesajlar] = useState([
    { ad: "Ece", saat: "20:58", metin: "Film listesi hazır, oylayalım." },
    { ad: "Kaan", saat: "21:01", metin: "Ben korku diyorum, itiraz kabul etmiyorum." },
  ]);
  const gonder = (m: string) => {
    const t = new Date();
    setMesajlar((e) => [...e.slice(-4), { ad: "Sen", saat: String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"), metin: m }]);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <UstCubuk />
      <div className="flex gap-2">
        <KanalPaneli kanal="sohbet" sec={() => {}} okunmamis={{ oyun: 1 }} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[24px] bg-base p-4">
          <div className="flex items-center justify-between px-1 pb-2">
            <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>sohbet</p>
            <div className="flex items-center gap-2">
              <IkonButonu ikon="star" boyut={32} baslik="Sabitlenenler" />
              <IkonButonu ikon="mail" boyut={32} baslik="Ara" />
            </div>
          </div>
          <TarihAyraci etiket="Bugün" />
          <MesajSatiri ad="Ece" saat="20:58" cocuk={<>Film listesi hazır, <BahsetmeCipi ad="Baran" /> oylayalım.</>} />
          <div className="flex gap-1.5 pb-1 pl-[52px]">
            <TepkiCipi emoji="🍿" ilkSayi={2} benimki />
            <TepkiCipi emoji="👻" ilkSayi={1} />
          </div>
          <OkunmadiAyraci />
          {mesajlar.slice(1).map((m, i) => (
            <MesajSatiri key={i} ad={m.ad} saat={m.saat} cocuk={<>{m.metin}</>} />
          ))}
          <YaziyorSatiri ad="Baran" />
          <Composer gonder={gonder} />
        </div>
      </div>
    </div>
  );
}

/** Yayın odak ekranı — büyük ekran paylaşımı + katılımcı şeridi */
export function EkranYayinOdak() {
  const [konusan, setKonusan] = useState("Ece");
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <UstCubuk />
      <div className="flex min-w-0 flex-col gap-2 rounded-[24px] bg-base p-4">
        <p className={onest.className + " px-1 pb-1 text-[20px] font-medium leading-[1.15]"}>
          <span className="text-white">akşam odası </span>
          <span className="text-text-dim">· Baran yayında</span>
        </p>
        <div className="[&>div]:max-w-none"><EkranPaylasimKarosu /></div>
        <div className="flex gap-2">
          {["Baran", "Ece", "Kaan"].map((a) => (
            <button key={a} onClick={() => setKonusan(a)} className="flex items-center gap-2 rounded-[16px] bg-surface px-3 py-2 transition-colors duration-200 hover:bg-surface-2">
              <Avatar ad={a} boyut={24} konusuyor={konusan === a} />
              <span className="text-[13px] font-medium leading-[17px] text-text-primary">{a}</span>
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2">
            <IkonButonu ikon="star" boyut={32} baslik="Mikrofon" aktif />
            <IkonButonu ikon="monitor" boyut={32} baslik="Yayını durdur" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Ayarlar ekranı — kabuk içinde ayarlar organizması */
export function EkranAyarlar() {
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <UstCubuk />
      <AyarlarKabugu />
    </div>
  );
}

/** Boş masa — ilk açılış */
export function EkranBosMasa({ davetAc }: { davetAc?: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <UstCubuk davetAc={davetAc} />
      <div className="flex gap-2">
        <div className="flex w-64 shrink-0 flex-col rounded-[24px] bg-base p-3">
          <BolumEtiketi etiket="Sesli" />
          <div className="flex items-center rounded-[12px] px-3 py-2.5" style={{ background: T.accentSoft }}>
            <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.accentStrong }}>akşam odası</span>
          </div>
          <div className="mt-auto pt-4"><KullaniciCubugu /></div>
        </div>
        <div className="flex min-h-[320px] min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-[24px] bg-base p-8 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-surface">
            <NoktaDurum durum="kapali" boyut={14} />
          </span>
          <p className={onest.className + " text-[18px] font-medium leading-[1.2] text-white"}>Masa henüz boş</p>
          <p className="max-w-[280px] text-[13px] leading-[18px] text-text-dim">İlk mesajı sen yaz; çay nasılsa demleniyor.</p>
          <div className="mt-1"><UrunButonu etiket="Davet et" tur="mercan" boy="sm" tikla={davetAc} /></div>
        </div>
      </div>
    </div>
  );
}
