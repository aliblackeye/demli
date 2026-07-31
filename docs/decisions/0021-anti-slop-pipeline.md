# 0021 — Anti-Slop Üretim Hattı ve Bağlayıcı Marka Sistemi

**Status:** Accepted
**Date:** 2026-07-29

## Context

Founder şikâyeti: vibe-coding çıktısı jenerik ("AI slop") — özgün değil, sorunları
görmüyor, UX'i eski kalıplarda, hata durumlarını atlıyor, yeşil teste güveniyor,
senaryoları görmüyor, landing ve metin jenerik. Depoya 11 genel tasarım skill'i bağlandı
ve landing bunlardan biriyle yenilendi; sonuç yine "AI slop" bulundu. Kolay cevap denendi
ve çalışmadı.

Kök neden: model eğitim verisinin medyanına çöker ve çöküş layout seviyesindedir; genel
zevk skill'leri de birer genel prior olduğundan medyanı kaydırır ama çöküşü durdurmaz.
Özgünlük ancak projeye özel, yazılı, üretimden ÖNCE bağlayıcı kararlar + üretenden farklı
gözle ölçülebilir denetim varsa çıkar. (Kaynaklar: `docs/product/anti-slop-method.md` §7.)

## Decision

1. **Bağlayıcı marka anayasası:** `docs/product/brand-system.md` — onliness, sözel kimlik,
   ton haritası (NN/g 4 boyut), yasak sözlük, yasak yapısal/görsel kalıplar, ayırt edici
   varlık defteri (Romaniuk fame×uniqueness), landing metni. Founder'a görünür her yüzey
   buna bağlanır.
2. **Üç aşamalı kapı hattı** (`docs/product/anti-slop-method.md`):
   - `surface-brief` (üretim öncesi, zorunlu): senaryo matrisi, 5-durum yığını (Hurff),
     hata metinleri önce, etkileşim envanteri, ≥3 beyanlı imza hamlesi, TR-önce metin.
   - `copy-voice` (metin): TR-önce yazım, ton haritası, takas testi, yasak sözlük.
   - `slop-check` (üretim sonrası, üretenden FARKLI ajan): 8 nesnel test — takas, şablon,
     imza envanteri, durum kapsamı, senaryo yürüyüşü, yasak kalıp, ses denetimi, kanıt
     kuralı (yeşil test tek başına yetmez). FAIL merge/publish'i bloklar.
3. **Zevk çatalları founder'a 2-3 adayla gider** (mevcut founder-taste-calibration kuralı
   sürece resmen bağlandı). İlk iki bekleyen karar: hero başlığı ve görsel yön (A/B/C).
4. **Genel tasarım skill'leri karar kaynağı olmaktan çıkarıldı**: brief'ten sonra craft el
   kitabı olarak çağrılabilirler; çelişkide brief kazanır. Altısı kullanım dışı
   (anti-slop-method §6 tablosu).

## Consequences

- Founder'a görünür iş için üretim maliyeti artar (brief + düşman geçiş); karşılığı,
  "slop" geri dönüşlerinin ve yeniden yapımların azalması.
- "Slop" öznel bir beğeni tartışması olmaktan çıkıp PASS/FAIL kanıtına bağlanır; Director
  yalnız yazılı istisnayla FAIL'i kabul edebilir.
- Ajan iş bölümü netleşir: üreten ajan kendi işini denetleyemez.
- brand-system.md canlı belgedir; kalıcılaşan cümleler ve motifler varlık defterine işlenir.

## Alternatives considered

- **12. genel zevk skill'i yazmak** — reddedildi: 11'inin çözemediğini 12.'si çözmez;
  mekanizma (medyana çöküş) skill'in genelliğinden bağımsız değil, bizzat onun sonucu.
- **Dış tasarımcı/ajans** — reddedilmedi ama ertelendi: maliyet + iterasyon hızı; hat
  işlemezse founder'la yeniden değerlendirilir.
- **Yalnız görsel token sıkılaştırması** — yetersiz: çöküş layout ve metin seviyesinde de
  yaşanıyor; token'lar §5-6 yasaklarıyla birlikte ancak işe yarar.
- **Otomatik "slop skorlayıcı" araç** — reddedildi: UI/metin için güvenilir sinyal yok;
  testler kanıt-temelli ve elle tutulur seçildi.
