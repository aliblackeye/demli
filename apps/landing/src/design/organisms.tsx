"use client";

/**
 * Koyu Masa — ORGANİZMALAR: moleküllerin birleştiği büyük yüzeyler
 * (kiplikler, ayarlar kabuğu, uygulama önizlemesi).
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AvatarKume, GirisAlani, Radyo, SesSurgusu, UrunButonu } from "./atoms";
import { AyarSatiri, Composer, KatilimciTile, KullaniciCubugu, MesajSatiri, SecimKutusu } from "./molecules";
import { SPRING, T } from "./tokens";

/** Onest — fonts.css'teki ürün fontu (build sırasında Google'dan indirilmez). */
const onest = { className: "font-display" };

/* ── Kiplik sistemi ───────────────────────────────────────────── */

export function KiplikOrtusu({ kapat, children }: { kapat: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const tus = (e: KeyboardEvent) => { if (e.key === "Escape") kapat(); };
    document.addEventListener("keydown", tus);
    return () => document.removeEventListener("keydown", tus);
  }, [kapat]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }} onClick={kapat}>
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24, transition: { duration: 0.15 } }} transition={SPRING} className="w-full max-w-[400px] rounded-[24px] bg-base p-6" onClick={(e) => e.stopPropagation()}>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function OnayKipligi({ kapat }: { kapat: () => void }) {
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanalı sil</p>
      <p className="mt-2 text-[14px] leading-[19.6px] text-text-secondary">&quot;oyun&quot; kanalı ve mesajları kalıcı olarak silinir. Bu geri alınamaz.</p>
      <div className="mt-6 flex justify-end gap-2">
        <UrunButonu etiket="Vazgeç" tur="hayalet" tikla={kapat} />
        <UrunButonu etiket="Kanalı sil" tur="tehlike" tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

export function FormKipligi({ kapat }: { kapat: () => void }) {
  const [ad, setAd] = useState("");
  const [tur, setTur] = useState<"yazi" | "sesli">("sesli");
  const [odak, setOdak] = useState(false);
  const mevcut = ["akşam odası", "film gecesi", "sohbet", "oyun"];
  const hata = ad.trim() !== "" && mevcut.includes(ad.trim().toLowerCase()) ? "Bu ad zaten var. Başka bir ad seç." : null;
  const gecersiz = ad.trim() === "" || hata !== null;
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Kanal oluştur</p>
      <div className="mt-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Kanal adı</label>
          <div className="flex items-center rounded-[12px] px-3.5 py-2.5 transition-colors duration-200" style={{ background: hata ? T.dangerSoft : odak ? "#262626" : "#171717" }}>
            <input value={ad} onChange={(e) => setAd(e.target.value)} onFocus={() => setOdak(true)} onBlur={() => setOdak(false)} placeholder='"akşam odası" yazıp dene' className="w-full bg-transparent text-[14px] leading-[19.6px] text-text-primary outline-none placeholder:text-text-dim" style={{ caretColor: T.accent }} autoFocus />
          </div>
          {hata ? <p className="text-[13px] leading-[18px]" style={{ color: T.danger }}>{hata}</p> : null}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Tür</p>
          <Radyo etiket="Sesli kanal" aciklama="Konuşma, ekran ve kamera" secili={tur === "sesli"} sec={() => setTur("sesli")} />
          <Radyo etiket="Yazı kanalı" aciklama="Mesajlar ve dosyalar" secili={tur === "yazi"} sec={() => setTur("yazi")} />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <UrunButonu etiket="Vazgeç" tur="hayalet" tikla={kapat} />
        <UrunButonu etiket="Oluştur" tur="mercan" devre={gecersiz} tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

export function DavetKipligi({ kapat }: { kapat: () => void }) {
  const [kopyalandi, setKopyalandi] = useState(false);
  const kopyala = () => {
    try {
      void navigator.clipboard.writeText("https://getdemli.com/davet/k7x2m9");
    } catch {
      // pano erişilemedi — etiket yine döner
    }
    setKopyalandi(true);
    setTimeout(() => setKopyalandi(false), 1500);
  };
  return (
    <KiplikOrtusu kapat={kapat}>
      <p className={onest.className + " text-[20px] font-medium leading-[1.15] text-white"}>Masaya davet et</p>
      <p className="mt-1.5 text-[13px] leading-[18px] text-text-dim">Bağlantı 7 gün geçerli; istediğinde iptal edersin.</p>
      <div className="mt-4 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-[12px] bg-surface px-3.5 py-2.5">
          <span className="truncate font-mono text-[13px] leading-[18px] text-text-secondary">getdemli.com/davet/k7x2m9</span>
        </div>
        <UrunButonu etiket={kopyalandi ? "Kopyalandı" : "Kopyala"} tur="mercan" tikla={kopyala} />
      </div>
      <div className="mt-4 flex items-center justify-between rounded-[12px] bg-surface px-3.5 py-2.5">
        <span className="text-[13px] font-medium leading-[18px] text-text-primary">Masadakiler</span>
        <AvatarKume adlar={["Baran", "Ece", "Kaan"]} boyut={20} />
      </div>
      <div className="mt-6 flex justify-end">
        <UrunButonu etiket="Kapat" tur="hayalet" tikla={kapat} />
      </div>
    </KiplikOrtusu>
  );
}

/* ── Ayarlar kabuğu ───────────────────────────────────────────── */

export function AyarlarKabugu() {
  const [sekme, setSekme] = useState("Ses ve görüntü");
  const [gurultu, setGurultu] = useState(true);
  const [kapanista, setKapanista] = useState(true);
  const [davetBildirim, setDavetBildirim] = useState(true);
  const [sesBildirim, setSesBildirim] = useState(false);
  const sekmeler = ["Hesap", "Ses ve görüntü", "Bildirimler"];
  return (
    <div className="flex gap-2 rounded-[32px] bg-black p-2">
      <div className="flex w-52 shrink-0 flex-col gap-0.5 rounded-[24px] bg-base p-3">
        <p className={onest.className + " px-3 pb-2 pt-1 text-[18px] font-semibold leading-[1.15] text-white"}>Ayarlar</p>
        {sekmeler.map((s) => (
          <button key={s} onClick={() => setSekme(s)} className="flex items-center rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: sekme === s ? T.accentSoft : "transparent" }}
            onMouseEnter={(e) => { if (sekme !== s) e.currentTarget.style.background = "#171717"; }}
            onMouseLeave={(e) => { if (sekme !== s) e.currentTarget.style.background = "transparent"; }}>
            <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: sekme === s ? T.accentStrong : "#a3a3a3" }}>{s}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-5">
        <p className={onest.className + " px-1 pb-2 text-[20px] font-medium leading-[1.15] text-white"}>{sekme}</p>
        {sekme === "Hesap" ? (
          <>
            <div className="max-w-[320px]"><GirisAlani etiket="Görünen ad" ilkDeger="Baran" yardim="Masada herkese böyle görünürsün." dogrula={(v) => (v.trim() === "" ? "Ad boş olamaz." : v.length > 24 ? "En fazla 24 karakter." : null)} /></div>
            <div className="mt-2 rounded-[16px] p-4" style={{ background: T.dangerSoft }}>
              <p className="text-[14px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: T.danger }}>Hesabı sil</p>
              <p className="mt-0.5 text-[13px] leading-[18px] text-text-dim">Mesajların ve üyeliklerin kalıcı olarak silinir. Bu geri alınamaz.</p>
              <div className="mt-3"><UrunButonu etiket="Hesabı sil" tur="tehlike" boy="sm" /></div>
            </div>
          </>
        ) : null}
        {sekme === "Ses ve görüntü" ? (
          <>
            <div className="rounded-[16px] bg-surface p-4">
              <p className="pb-2 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Mikrofon</p>
              <SecimKutusu secenekler={["Varsayılan — Yeti X", "Kulaklık mikrofonu", "Dahili mikrofon"]} ilk="Varsayılan — Yeti X" />
            </div>
            <AyarSatiri baslik="Gürültü engelleyici" aciklama="Müzik modunda kendiliğinden kapanır" acikMi={gurultu} degistir={() => setGurultu(!gurultu)} />
            <AyarSatiri baslik="Kapanışta güncelle" aciklama="Yeni sürüm çıkışta sessizce kurulur" acikMi={kapanista} degistir={() => setKapanista(!kapanista)} />
            <div className="rounded-[16px] bg-surface p-4">
              <p className="pb-3 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-secondary">Çıkış sesi</p>
              <SesSurgusu ad="Genel" baslangic={80} />
            </div>
          </>
        ) : null}
        {sekme === "Bildirimler" ? (
          <>
            <AyarSatiri baslik="Davet bildirimleri" aciklama="Masaya çağrılınca haber ver" acikMi={davetBildirim} degistir={() => setDavetBildirim(!davetBildirim)} />
            <AyarSatiri baslik="Bildirim sesi" aciklama="Yeni mesajda kısa ses çal" acikMi={sesBildirim} degistir={() => setSesBildirim(!sesBildirim)} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ── Uygulama önizlemesi ──────────────────────────────────────── */

export function UygulamaOnizleme({ davetAc }: { davetAc: () => void }) {
  const [kanal, setKanal] = useState("akşam odası");
  const [konusan, setKonusan] = useState("Baran");
  const [mesajlar, setMesajlar] = useState([
    { ad: "Ece", saat: "21:04", metin: "Çay hazır, oda açık." },
    { ad: "Baran", saat: "21:05", metin: "Geliyorum, iki dakika." },
  ]);
  const kanallar = { sesli: ["akşam odası", "film gecesi"], yazi: ["sohbet", "oyun"] };
  const gonder = (m: string) => {
    const simdi = new Date();
    const saat = String(simdi.getHours()).padStart(2, "0") + ":" + String(simdi.getMinutes()).padStart(2, "0");
    setMesajlar((eski) => [...eski.slice(-5), { ad: "Sen", saat, metin: m }]);
  };
  const kanalSatiri = (k: string, kume?: boolean) => (
    <button key={k} onClick={() => setKanal(k)} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left transition-colors duration-200" style={{ background: kanal === k ? T.accentSoft : "transparent" }}
      onMouseEnter={(e) => { if (kanal !== k) e.currentTarget.style.background = "#171717"; }}
      onMouseLeave={(e) => { if (kanal !== k) e.currentTarget.style.background = "transparent"; }}>
      <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: kanal === k ? T.accentStrong : "#a3a3a3" }}>{k}</span>
      {kume ? <AvatarKume adlar={["Baran", "Ece"]} boyut={20} /> : null}
    </button>
  );
  return (
    <div className="flex flex-col gap-2 rounded-[32px] bg-black p-2">
      <div className="flex items-center justify-between rounded-[16px] bg-[rgba(23,23,23,0.72)] py-2.5 pl-5 pr-2.5 backdrop-blur-[10px]">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-[12px]" style={{ background: T.accentSoft }}>
            <span className="text-[13px] font-semibold" style={{ color: T.accentStrong }}>D</span>
          </span>
          <span className={onest.className + " text-[17px] font-semibold text-white"}>bizim masa</span>
        </div>
        <div className="flex items-center gap-2">
          <AvatarKume adlar={["Baran", "Ece", "Kaan"]} />
          <UrunButonu etiket="Davet et" boy="sm" tikla={davetAc} />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex w-64 shrink-0 flex-col rounded-[24px] bg-base p-3">
          <p className="px-3 pb-1.5 pt-1 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Sesli</p>
          {kanallar.sesli.map((k) => kanalSatiri(k, k === "akşam odası"))}
          <p className="px-3 pb-1.5 pt-4 text-[13px] font-medium leading-[17px] tracking-[-0.26px] text-text-dim">Yazı</p>
          {kanallar.yazi.map((k) => kanalSatiri(k))}
          <div className="mt-auto pt-4"><KullaniciCubugu /></div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-[24px] bg-base p-4">
          <p className={onest.className + " px-1 pb-1 text-[20px] font-medium leading-[1.15]"}>
            <span className="text-white">{kanal} </span>
            <span className="text-text-dim">{kanallar.sesli.includes(kanal) ? "· 3 kişi" : ""}</span>
          </p>
          {kanallar.sesli.includes(kanal) ? (
            <div className="flex gap-2">
              {["Baran", "Ece", "Kaan"].map((a) => (
                <KatilimciTile key={a} ad={a} konusuyor={konusan === a} tikla={() => setKonusan(a)} />
              ))}
            </div>
          ) : null}
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
