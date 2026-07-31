# 0022 — Arama/Sesli Oda Video Deneyimi: Tek Deneyim Katmanı, Ayrı Kontrol Düzlemi

**Status:** Accepted
**Date:** 2026-07-30
**İlgili:** ADR 0012 (DM aramaları)

## Context

Founder cihaz testinde DM araması ile sunucu seslisi arasında deneyim farkları buldu ve ilkeyi
koydu: "sunucudaki sesli ile özel arasında fark olmamalıydı; ayırdıysan hata etmişsindir."

Kod incelemesi (plan dokümanı §1.1) durumu netleştirdi:
- **Medya katmanı zaten tek**: bir voice FSM + bir LiveKit engine (`packages/media`), DM
  araması aynı engine'e önceden basılmış token ile girer; token grant'ları, single-session
  registry, reconnect/kalite yolları bayt-bayt ortak. Masaüstünde video sahnesi
  (`VideoStage.tsx`) her iki yüzeyde aynı bileşendir.
- **Kontrol düzlemi kasıtlı ayrı** (ADR 0012): DM odası `dmcall:<callId>` efemer LiveKit
  odasıdır, `channels` satırı değildir; davet/kabul/kayıt HTTP `/dm-calls/*` üzerindedir.
- **Mobilde kasıtsız çatallanma var**: iki ekran kabuğu (`InCallView` / `VoiceRoomScreen`)
  tile-builder'ı kopyalamış, özellik seti asimetrik (sahne-içi kontrol barı yalnız aramada;
  ses rotası/kişi-bazlı ses/watch-party yalnız sesli odada — kişi-bazlı ses DM aramasında
  fiilen ölü). Masaüstündeki `lib/video-stage.ts` saf modelinin mobil karşılığı yok.

## Decision

1. **Kontrol düzlemi ayrımı KALIR.** ADR 0012'nin efemer `dmcall:` odası + HTTP kontrol
   düzlemi yeniden teyit edildi. Gerekçeler hâlâ geçerli: DM gizliliği (occupancy
   snapshot'ları DM sesli varlığını sızdıramaz), karşılıklı-arkadaş kapısı, arama kaydı ve
   rate-limit'in HTTP'de yaşaması.

2. **Deneyim katmanı TEK kaynağa iner.** Saf video-sahne modeli (tile üretimi, grid/focus
   çözümü, grid şekli, konuşan-filmstrip kuralı) masaüstü-özel
   `apps/desktop/.../lib/video-stage.ts`ten **`packages/media/src/stage.ts`e** taşınır
   (RN-safe, DOM'suz). Masaüstü dosyası re-export'a iner; mobil kopya tile-builder'lar
   silinip bu modeli tüketir. Mobilde DM araması ve sesli oda tek sahne bileşeni kümesini
   paylaşır; yüzey farkları (zil rozeti, süre sayacı, upgrade sheet'i vs.) ince kabuk olarak
   kalır — masaüstündeki `EmbeddedCallStage` deseninin aynısı.

3. **Aktif-konuşan seçimi tek modüldür.** `packages/media/src/active-speaker.ts`:
   speaking verisinden recency-sıralı liste + son-konuşan hafızası. Filmstrip görünürlüğü,
   Android OS PiP konu seçimi ve ekran-paylaşımı sahnesindeki picker bunu tüketir; dağınık
   ad-hoc seçiciler yasak (CLAUDE.md §23 ruhu: yaşam döngüsü mantığı UI'da kopyalanmaz).

4. **Self-view sözleşmesi platformlar-arası tektir** (plan K4): focus/fullscreen'de sağ-alt,
   sürüklenebilir, kamera kapalıyken placeholder, varsayılan açık. Davranış tanımı tek yerde
   yazılır; iki platform aynı sözleşmeyi uygular.

## Consequences

- Bir sahne/düzen davranışı değişikliği artık tek dosyada yapılır ve iki platform + iki yüzey
  aynı anda alır — parite kayması yapısal olarak zorlaşır.
- `packages/media` DOM'suz kalma sözünü sürdürmelidir; `stage.ts` MediaStreamTrack gibi
  tipleri yapısal (`Like`) tiplerle soyutlar (mevcut `room-adapter.ts` deseni).
- Mobil kabuk birleşmesi bir defalık göç maliyeti taşır (plan W3); bu göç sırasında iki ekranın
  asimetrik özellikleri (volume sheet host, ses rotası, sahne barı) eşitlenerek kapanır.
- Founder'a cevap: ilke doğru ve mimaride zaten kuruluydu; hata, mobil kabuğun kopya
  büyümesiydi — birleşme kontrol düzlemini değil deneyim katmanını hedefler.

## Alternatives considered

- **DM aramasını gizli voice-channel satırına bağlamak** (tam birleşme): ADR 0012'de
  reddedilmişti, yeniden reddedildi — occupancy/presence yolları kanal-temelli; DM'in sesli
  varlığını gizlemek için her tüketiciye istisna sızar.
- **Mobil kabuğu ayrı bırakıp yalnız tile-builder'ı paylaşmak**: kopyanın yarısını kapatır;
  asimetrik özellik seti (bugünkü ölü kişi-bazlı ses gibi) üremeye devam eder. Ret.
- **Sahne modelini `packages/ui`ya koymak**: `ui` masaüstü React primitifleri içindir; model
  React'siz ve RN tarafından da tüketileceği için `media` doğru ev (medya yaşam döngüsüne
  bitişik, §23).
