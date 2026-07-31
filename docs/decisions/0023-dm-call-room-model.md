# 0023 — DM Araması bir ODADIR: koltuk modeli, ayrıl≠bitir, cihaz senkronu

**Status:** Accepted
**Date:** 2026-07-30
**Günceller:** ADR 0012 (DM aramaları — efemer `dmcall:` odası), ADR 0022 (tek deneyim katmanı)
**İlgili:** ADR 0020 (per-connection presence)

## Context

Founder model beyanı (2026-07-30, gereksinim): DM araması **sunucudaki sesli oda gibi** çalışmalı.
Tek fark: sınırsız süreli değil — **yalnız kalan kişi bir süre sonra çıkarılmalı**. Somut senaryo:
"mobilde ayrıl butonuna basıp ayrılıp bu süre içerisinde masaüstünden o call'a katılabilmeliyim."

Bugünkü kodda buna aykırı üç şey var:

1. **Ayrıl = bitir.** `hangup` satırı `ended` yapar ve karşı tarafa `call.ended{hung_up}` yollar
   (`apps/api/src/modules/dm-calls/index.ts` `endLiveCall`). "Odadan çıkmak" diye bir kavram yok;
   çıkan kişi odayı da yok eder. Oysa sunucu seslisinde `engine.leave()` yalnız medyadan çıkar.
2. **Satır-üyeliği ile medya-katılımı tek kavram.** İstemci FSM'de `active` demek "medyam bu odada
   canlı" demek. Hesabın BAŞKA cihazı aramadayken bu cihazın hiçbir gösterilebilir durumu yok —
   founder bulguları 1-2 bunun sonucu.
3. **Resync otomatik medya kurar.** `adoptExistingCall → ensureAdoptedMedia → engine.join`
   (`packages/client-core/src/dm-calls/call-controller.ts`). Director'ın accept-fan-out düzeltmesiyle
   (kabul olayı artık kabul edenin kendi oturumlarına da gidiyor) birleşince **canlı bir hata**
   doğuyor: telefonda kabul → masaüstü zili susturur → resync adopt eder → `engine.join` **aynı
   identity ile** LiveKit'e girer → LiveKit duplicate-identity kuralı **telefonu odadan atar**.
   Kabul eden cihazın araması, hiç dokunulmayan masaüstü tarafından çalınır.

Sweeper (`apps/api/src/lib/dm-call-sweeper.ts`) zaten oda-modeliyle yazılmış: canlılığın tek kaynağı
medya düzlemi; `active` satır odası 3 dk boş kalınca kapanır; **yalnız kalan kişi 3 dk sonra
çıkarılır** (`DEFAULT_ALONE_GRACE_MS`). Founder'ın "bir süre sonra çıkarılsın"ı üretimde çalışıyor.
Eksik olan sweeper değil, ayrıl/katıl anlamları ile istemci durum modeli.

## Decision

### 1. Satır-üyeliği ve medya-koltuğu ayrılır

Bir DM araması iki katmandır:

| Katman | Kaynak | Anlamı |
| --- | --- | --- |
| **Üyelik** | `dm_calls` satırı (`ringing`/`active`) | "Bu DM'de canlı bir oda var; iki taraf da üye" |
| **Koltuk** | LiveKit odası (`dmcall:<callId>`) | "Şu an hangi cihaz(lar) gerçekten seste" |

İstemci `CallState`'e koltuk alanı eklenir (isim uygulayıcıya; sözleşme şu):

```ts
seat: "here" | "elsewhere" | "vacant";
// here      → medya BU cihazda canlı (bugünkü "active" deneyimi)
// elsewhere → hesabın BAŞKA cihazı odada; bu cihaz kompakt "aramadasın — buraya al" bandı gösterir
// vacant    → hesap odadan çıktı ama satır canlı; DM'de "devam eden arama — Katıl" çipi
```

`phase: "active"` üç koltuk durumunda da geçerlidir — arama tektir, cihazlar koltuk değiştirir.

### 2. Ayrıl = odadan çık; odayı yalnız SON çıkan kapatır

- **Ayrıl butonu** artık `engine.leave()` + `seat:"vacant"` yapar. Satıra dokunulmaz, karşı tarafa
  `call.ended` GİTMEZ. Karşı taraf odada kalır (LiveKit zaten participant-left gösterir); yalnız
  kalırsa **3 dk sonra** sweeper onu çıkarır ve satırı kapatır (mevcut davranış, değişmez).
- **Son kişi çıkarken** (istemci LiveKit görünümünde uzak katılımcı yoksa) Ayrıl mevcut
  `POST /dm-calls/:id/hangup`'ı çağırır: satır hemen kapanır, "Arama bitti · 4:32" tarih satırı
  gecikmeden yazılır. İstemci yanılırsa sweeper yedektir (idempotent kapanış zaten var).
- **Yeni endpoint YOK.** "Odadan çık" sunucuya bildirilmez; kimin odada olduğunun tek dürüst
  kaynağı zaten medya düzlemi (sweeper'ın ilkesi). Ayrı bir `leave` endpoint'i ikinci bir
  katılım-defteri yaratırdı.

**Geri katılma penceresi:** karşı taraf odada kaldığı sürece + yalnız kaldıysa
`DEFAULT_ALONE_GRACE_MS` (**3 dk**, tek sabit, founder ayarlayabilir). İki taraf da çıkarsa oda
son-çıkan kuralıyla zaten kapanmıştır; kural atlanırsa `DEFAULT_EMPTY_GRACE_MS` (3 dk) yedektir.

### 3. Resync asla medya ÇALMAZ — otomatik join kapısı

`GET /dm-calls/active` yanıtına bir alan eklenir: **`inRoom: boolean`** — "bu kullanıcının
identity'si şu an LiveKit odasında mı" (API, sweeper'ın kullandığı `listParticipants` ile okur;
yalnız kullanıcının KENDİ katılımı döner, sızıntı yok). İstemci kuralı:

> Resync/adopt, medyayı yalnız `inRoom === false` iken kurabilir. `inRoom === true` iken cihaz
> `seat:"elsewhere"` bandına oturur; medyayı ancak kullanıcının **Katıl/Buraya al** eylemi kurar
> (bilinçli devir — single-session eviction diğer cihazı düşürür, o cihaz `session_replaced`'i
> `seat:"elsewhere"` olarak gösterir, "arama bitti" olarak DEĞİL).

Bu, Context §3'teki duplicate-identity çalma hatasını kapatır ve founder'ın "masaüstünden
katılmasam bile aramada olduğum gözüksün" isteğinin kendisidir.

### 4. Terminal olaylar İKİ tarafın TÜM cihazlarına gider

Accept fan-out düzeltmesinin aynası: `hangup/cancel/reject` ve `endLiveCall`, `call.ended`'i yalnız
karşı tarafa değil **her iki userId'ye** yayınlar (sweeper zaten böyle yapıyor). Aksi hâlde eylemi
yapan kişinin diğer cihazındaki "devam eden arama" bandı bir sonraki resync'e kadar asılı kalır.
Kendi yankısı reducer'da zaten no-op.

### 5. Presence'a "aramada" durumu EKLENMEZ; yanlış-idle kaynağında düzeltilir

Gerilim: founder "platformlar senkron olmalı, sunucudaki gibi işlesin" diyor; ADR 0012 §4 ise DM
aramasının varlığını üçüncü kişilere sızdırmamayı varlık sebebi sayıyor. Çözüm kitleye göre:

| Kim | Ne görür | Nasıl |
| --- | --- | --- |
| Kendi cihazların | Tam durum (koltuk modeli) | Kontrol düzlemi: `call.*` fan-out + resync — presence DEĞİL |
| Karşı taraf | Zaten biliyor; oda içi durumu LiveKit'ten | Değişiklik yok |
| Üçüncü kişiler | **Hiçbir arama bilgisi yok** — ama artık yanlış "dışarıda" da yok | Aşağıdaki aktivite kuralı |

**Aktivite kuralı:** ses FSM'i `joining/connected/reconnecting` iken **auto-idle bastırılır** (girmez,
girdiyse çıkar) — hem mobil (`apps/mobile/src/realtime/connection.ts` auto-idle katmanı) hem masaüstü
(`apps/desktop/.../stores/idle-auto.ts`). Aramadaki insan aktiftir; ekranı kilitli telefonda konuşan
kişi "çevrimiçi (mobil)" görünür. Sunucu tarafında sıfır değişiklik, sıfır sızıntı: üçüncü kişi
yalnız "çevrimiçi" görür, nedenini görmez. Bulgu 3'ü tamamen kapatır.

Üçüncü kişilere "seste" göstergesi DM araması için **bilinçli olarak reddedildi**
(sızıntı). Sunucu sesli kanalları zaten meşru occupancy yayınlıyor; orada değişiklik yok. Founder
ileride "DM aramasında da görünsün" derse bu ADR 0012 §4'ü değiştiren ayrı bir founder kararıdır.

### 6. Yeni realtime olayı YOK

`call.participant_joined/left` benzeri olaylara gerek görülmedi: oda içi gerçeği LiveKit taşır,
satır gerçeğini `GET /dm-calls/active` + mevcut `call.*` taşır (basit olan seçildi). Protokole
eklenen tek şey `DmCallActiveResponse.inRoom`.

## Consequences

- Founder senaryosu birebir çalışır: mobilde Ayrıl → karşı taraf odada bekler → masaüstünde DM
  "devam eden arama — Katıl" gösterir → Katıl medya kurar; süre aşılırsa sweeper temizler.
- Kabul-eden-cihaz-dışı cihazlar artık aramayı ÇALMAZ; gösterir (bulgu 1-2 kapanır).
- "Ayrıl"ın anlamı değişir: karşı tarafın araması benim ayrılmamla bitmez.
  UI, yalnız kalan tarafa "X ayrıldı" + kendi Ayrıl butonunu göstermelidir.
- Sweeper, migration, oda adı, token yolu, tek-oturum kuralı: **değişmez**.
- Sessiz oda kabulü: `vacant` çipinden geri katılmak karşı tarafı YENİDEN ÇALDIRMAZ (karşı taraf
  ya odadadır ya kendi çipini görür). Yeniden zil istenirse o, satır kapandıktan sonraki yeni bir
  aramadır — bilinçli erteleme.

## Alternatives considered

- **`POST /dm-calls/:id/leave` endpoint'i + sunucuda katılım defteri.** Ret: medya düzlemi zaten
  tek dürüst katılım kaynağı (sweeper ilkesi); ikinci defter drift üretir, hiçbir tüketicisi yok.
- **Presence'a `in_call`/`busy` durumu.** Ret: DM aramasının varlığını sızdırır (ADR 0012 §4) ve
  ADR 0020'nin "intent kalıcı değildir" kuralıyla çelişen yeni bir türetilmiş durum sınıfı açar.
  Yanlış-idle'ın kökü presence modeli değil, auto-idle'ın aramayı aktivite saymamasıydı.
- **Ayrılınca satırı hemen kapatmak, geri-katılımı "yeni arama"ya çevirmek.** Ret: founder'ın
  senaryosu kesintisiz devir istiyor; yeni arama karşı tarafı yeniden çaldırır ve geçmişe iki
  kayıt yazar.
- **`seat` yerine yeni `detached` fazı.** Ret: faz alfabesini büyütür, `active`-bağımlı her guard
  (upgrade, resync, busy-banner) ikiye çatallanırdı; ortogonal bir alan daha küçük değişiklik.
