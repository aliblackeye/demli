# Demli Design System v1 — "Koyu Masa"

Landing'den (apps/landing) uçtan uca çıkarılmış, ürünün web + masaüstü +
mobil yüzeylerine taşınan tek sistem. **Durum: M16 Dalga 2 temeli uygulandı
(token'lar, fontlar, hareket, `packages/ui` atomları) — founder G2 görsel
onayı bekliyor; ürün ekranlarının taraması (Dalga 3/4) onaydan sonra.**
Canlı örnekler: landing showcase `localhost:3001/design` (yalnız referans) ve
ürün UI kiti `apps/web` → `pnpm --filter @demli/web dev` → `/ui-kit.html`
(gerçek atomlar, gerçek stil dosyası, token'dan ölçülen kontrast).

Founder kararları (2026-08-12): zeminler nötr siyah kalır · yeşil vurgu
Demli mercanına çekilir (landing dahil) · display font ücretsiz (OFL)
alternatife geçer · token mimarisi koyu + açık-tema-hazır · onaydan önce
entegrasyon yok.

---

## 1. Renk

İki katman: **ham palet** (değişmez değerler) + **anlamsal tokenlar**
(yüzeylerin kullandığı adlar). Açık tema geldiğinde yalnız anlamsal
katmanın değerleri değişir.

### 1.1 Zeminler (nötr siyah — landing'den birebir)

| Token | Değer | Kullanım |
|---|---|---|
| `bg-page` | `#000000` | Sayfa/pencere zemini (saf siyah) |
| `bg-base` | `#0d0d0d` | Kart, koyu blok |
| `bg-surface` | `#171717` | İkincil yüzey, ikon kutusu |
| `bg-surface-2` | `#262626` | Buton zemini, hover yüzeyi |
| `bg-raised` | `rgba(23,23,23,0.72)` + blur(10px) | Nav hapı, yüzen paneller |
| `bg-veil` | `rgba(0,0,0,0.24)` | Saydam rozet/hap zemini |

Ürün eşlemesi (uygulandı — `globals.css @theme` `--color-*`, `tokens.css`
`--tc-*`, mobil `theme.ts`; üçü testle kilitli). Sıcak "Demli Voice v2"
rampası emekli (founder kararı).

| Ürün token'ı | Değer | Not |
|---|---|---|
| `rail` | `#000000` | bg-page — pencere |
| `sidebar`, `app` | `#0d0d0d` | bg-base — kolonlar, kiplik kartı |
| `surface`, `hover`, `overlay` | `#171717` | giriş alanı, satır hover'ı, opak cam yedeği |
| `raised` / `raised-hover` / `raised-pressed` | `#262626` / `#303030` / `#1f1f1f` | ikincil buton, odaklı alan, menü hover'ı |
| `glass` / `glass-strong` | `rgba(23,23,23,.72)` / `.92` + blur(10) | nav hapı / menü, ipucu |
| `veil` / `scrim` | `rgba(0,0,0,.24)` / `.55` (+blur 4) | medya hapı / kiplik örtüsü |
| `selected` | `rgba(255,132,100,.12)` | seçili satır = accent-soft |
| `wash` / `wash-strong` | `rgba(255,255,255,.06)` / `.10` | kendi dolgusu olmayan kontrolün (hayalet/çerçeveli buton, kapat düğmesi, seçenek satırı) hover / basılı hâli; `wash-strong` iskelet bloğu da. Göreli ton: `surface`/`overlay`/`hover` aynı `#171717` olduğu için yüzey tonlu bir hover, yüzey tonlu araç çubuğunda veya popover'da görünmez olur; beyaz yıkama altındaki her tonu kaldırır. `ui-tones.test.tsx` her durumu her kap tonunda ölçer (taban: surface/app adımı 1.084:1). |
| `stroke` / `stroke-strong` | `rgba(255,255,255,.08)` / `.16` | yalnız işlevsel çizgi |
| `inverse` (+hover/pressed) / `on-inverse` | `#fff` (`#e5e5e5`/`#d4d4d4`) / `#171717` | beyaz birincil buton |

### 1.2 Metin rampası

| Token | Değer | Kullanım |
|---|---|---|
| `text-display` | `#ffffff` | Büyük başlıklar |
| `text-primary` | `#e5e5e5` | UI birincil metin |
| `text-secondary` | `#a3a3a3` | İkincil metin, gövde |
| `text-dim` | `#737373` | Sönük metin, ikonlar |
| `text-faint` | `#404040` | Telif, en silik |

**Üründe iki değer değişti (WCAG, ölçülü — `design-tokens.test.ts`):**
`#737373` `#0d0d0d` üstünde 4.10:1 (AA 4.5 altı), `#404040` ≈2:1. Ürün
token'ları: `fg-display #fff` · `fg #e5e5e5` · `fg-muted #a3a3a3` (7.70:1) ·
**`fg-faint #8f8f8f`** (meta metin; app'te 6.01:1, `raised #262626` üstünde
4.68:1 — AA her yüzeyde) · **`fg-subtle #666666`** (YALNIZ metin olmayan öğe:
boşta ikon, ayraç, çevrimdışı nokta; rail/app/surface üstünde ≥3:1, WCAG
1.4.11). Landing kendi `#737373`'ünü koruyabilir; ürün metni koruyamaz.

### 1.3 Vurgu — Demli mercanı (yeşilin yerini alır)

| Token | Değer | Kullanım |
|---|---|---|
| `accent` | `#ff8464` | Birincil vurgu: linkler, aktif durum, parıltılar |
| `accent-strong` | `#ffa48c` | Hover/açık ton |
| `accent-deep` | `#e8624a` | Basılı durum |
| `accent-soft` | `rgba(255,132,100,0.12)` | Vurgu zemini (seçili satır vb.) |
| `accent-glow` | `rgba(255,132,100,0.24)` | Radyal parıltılar (yeşil 0.24'ün birebir karşılığı) |
| `gold` | `#eab30a` | Yıldız/puan/shimmer |

Kontrast (ölçülü, brand-system §8): `#ff8464` / `#0d0d0d` ≈ 7.4:1,
`#ff8464` / `#262626` ≈ 6.4:1 — ikisi de AA'nın rahat üstünde.

### 1.4 Anlamsal durum renkleri (ürün UI için)

| Token | Değer | Not |
|---|---|---|
| `success` / `online` | `#22c55e` | Yeşil MARKA vurgusu olmaktan çıkar, yalnız durum rengi olarak yaşar (çevrimiçi, başarı) |
| `danger` | `#ff6fb5` | Mercandan ≥30° hue uzaklığı (brand-system kırmızı disiplini) — hata daha kuvvetli bir kırmızı OLAMAZ. Ürün: `dnd` de bu renk; dolgu olarak üstünde koyu mürekkep (7.0:1), beyaz yasak (2.6:1) |
| `warn` | `#eab30a` | Altınla paylaşır |
| `info` | `#a3a3a3` | Nötr — soğuk SaaS mavisi markaya giremez (brand-system §8) |

### 1.5 Çizgiler / ayraçlar

Kenar çizgisi YOK denecek kadar az: yüzey farkı + radius ayrımı esas.
Gerekirse `stroke` `rgba(255,255,255,0.08)`, `stroke-strong` `0.16`.
İç gölge imzası: `inset 0 -1px 0 rgba(38,49,64,0.32)` (hap/rozet).

**Tehlike rengi kararı (M16 Dalga 2, ölçüm — founder onayına).** Mikrofon
kapalı, aramadan çık, at/yasakla ve yıkıcı eylemler anında tanınmalı. Aday
renkler mercana (#ff8464) ve çevrimiçi yeşile (#22c55e) karşı, renk körlüğü
simülasyonuyla (Machado 2009, CIEDE2000; ~20 = "açıkça farklı") ölçüldü:

| Aday | Hue farkı | ΔE mercan (normal/protan/döteran) | ΔE yeşil (döteran) |
|---|---|---|---|
| `#ff6fb5` pembe (doküman) | 41.6° | 26.6 / 35.5 / 26.0 | 24.0 |
| `#ff6aa0` ahududu | 34.1° | 22.9 / 30.0 / 17.3 | 14.9 |
| `#ff5c8f` gül-kırmızı | 31.2° | 21.4 / 27.2 / 13.7 | 10.8 |
| `#ff4d6d` kırmızı | 23.2° ✗ | 16.8 / 17.1 / 7.8 | 3.9 |
| `#ef4444` saf kırmızı | 12.4° ✗ | 14.0 / 16.3 / 9.9 | 7.7 |

Sonuç: **`#ff6fb5` korundu.** Kırmızıya yaklaştıkça hem mercandan ≥30° kuralı
bozuluyor hem de kırmızı-yeşil renk körlüğünde (erkeklerin ~%8'i) "rahatsız
etmeyin" noktası "çevrimiçi" yeşiliyle karışıyor (#ff4d6d ↔ yeşil ΔE 3.9 —
neredeyse aynı). Pembenin "tehlike" anlamı rengin kendisinden değil
yerleşimden ve işaretten gelir: tehlike kontrolleri her zaman ikonuyla
(kesik mikrofon, kapanan telefon, çöp kutusu) ve etiketiyle çizilir.
`Button`/`IconButton` `danger` varyantı ve menüdeki yıkıcı öğe dolgu değil
pembe yıkama + pembe yazıdır; çağrı reddet/kapat/odadan çık düğmeleri ve
okunmamış rozeti ise dolu pembedir ve üstünde koyu `on-accent` mürekkebi
(7.0:1) taşır — beyaz 2.56:1'dir, ikon için gereken 3:1'in de altında. Aynı
kural kabul (yeşil, beyaz 2.28:1) dahil bütün açık dolgular için geçerli;
`design-tokens.test.ts` masaüstü/web kaynağını tarar, aynı sınıf dizesinde
açık dolgu + açık mürekkep bulursa kırılır. Founder kırmızıya
daha yakın bir ton isterse ölçülen en iyi yedek **`#ff6aa0`** (testler
geçer: hue 34°, döteran ΔE mercan 17.3 — eşik 20'nin altında kaldığı için
CVD testi o eşikle güncellenmeli). Tritan (çok nadir) için hiçbir aday
mercandan iyi ayrılmıyor; orada da ikon taşıyor.

## 2. Tipografi

- **Display: Onest (OFL, latin-ext ✓)** — Stack Sans Headline'ın ücretsiz
  karşılığı olarak öneri; alternatifler: Schibsted Grotesk, General Sans.
  Showcase Onest ile basılmıştır; beğenmezsen alternatife tek satırla geçilir.
- **Gövde/UI: Inter (OFL)** — ürünün önceki gövde fontu Instrument Sans'tı
  (doküman "mevcut" diyordu, değildi); M16'da Inter'e geçildi, Instrument Sans
  ve Space Grotesk kaldırıldı.
- **Ürün kurulumu:** masaüstü/web Google Fonts'un resmi latin + latin-ext
  DEĞİŞKEN woff2 altkümeleri (`apps/desktop/src/renderer/src/assets/fonts/`,
  wght 100–900, same-origin — CSP `font-src 'self'`); mobil aynı sürümlerin
  statik TTF'leri (Inter 400/500/600, Onest 500/600/700, latin+latin-ext,
  `expo-font`, OTA-güvenli). OFL metinleri dosyaların yanında, THIRD-PARTY.md
  kayıtlı. Not: Google'ın altkümeleri `cv03/cv04/cv09/cv11` özelliklerini
  taşımıyor (yalnız `calt`, `tnum`) — landing'deki `cv` ayarları da etkisiz.

### Ölçek (landing'den ölçülü; mobil / tablet / masaüstü)

| Rol | Boyut | lh | ls | Ağırlık |
|---|---|---|---|---|
| Display-1 (hero H1) | 56 / 92 / 112 | %110 | −0.2px | 600 |
| Display-2 (bölüm H2) | 36 / 48 / 56 | %110 | −0.2px | 500 |
| Display-3 (kart H3) | 40 / 52 | %110 | normal | 400 |
| Büyük açıklama | 32 / 40 / 44 | %120 | −0.02em | 400 |
| Gövde-L | 16 / 18 | 24 / 25.2 | — | 400 |
| UI | 14 / 16 | 19.6 / 19.2 | −0.28 / −0.32px | 500 |
| Küçük | 12 / 14 | 14.4 / 16.8 | −0.24 / −0.28px | 500 |

İki tonlu başlık deseni: beyaz ön parça + `text-dim` kuyruk (H2'lerde
`white-space: pre-wrap`, kırılımlar yazarın `\n`'iyle).

## 3. Boşluk, radius, gölge

- **Boşluk:** 4'lük taban. Bölüm ritmi: `py 80 / 120 / 160` (m/t/d),
  bölüm-içi büyük boşluk 40→80, kart içi 24/32, satır içi 8–16.
- **Radius:** 8 · 10 · 12 (nav sekme/ikon kutusu) · 16 (nav hapı, ikon grubu)
  · 18 (CTA) · 24 (yorum kartı) · 32 (kart) · 44 (büyük kart, dt)
  · 50px (hap) · tam yuvarlak `100%`/`1000px`.
- **Gölge:** dış gölge kullanılmaz; derinlik = yüzey tonu + blur.
  Tek istisna: hap iç gölgesi (§1.5) ve mobil nav'ın yumuşak halesi.

## 4. Hareket dili (landing'den ölçülü — authored değerler)

| Desen | Değer |
|---|---|
| Hover kayan metin | spring `{bounce .2, duration .4}`, kopya 23/29px altta |
| Kart/blok reveal | y64–y400 → 0, spring `{damping 60, stiffness 500, mass 1}` |
| Başlık blok reveal | spring `{bounce .3, duration 3}`, threshold .5 |
| Kelime blur kademe | blur(10px)+y10→0, 0.5s, ~70ms/adım, power2.out |
| Yüzen CTA | y120↔0, spring `{bounce .2, duration 2}` |
| Parıltı salınımı | 0→380→0, 7017ms (hero) / 4017ms (footer), ease `[.44,0,.56,1]` |
| Telefon parallax | scroll-bağlı, layout vh→0.209vh, y 250→0 (çift yönlü) |
| Çift yön kuralı | Reveal'ler görünümden çıkınca gecikmesiz geri sarar (founder kararı) |

Ürün UI'da ölçek: pazarlama reveal'leri ürüne taşınmaz; üründe hover
spring'i, panel aç/kapa (150–250ms), liste satır hover'ı gibi mikro
hareketler kullanılır. §27 performans kuralları bağlayıcı.

**Ürün hareket token'ları (uygulandı):** süreler instant 120 · fast 180 ·
**hover 200** (yalnız ton; temel geçiş katmanı bu) · standard 240 · arrival
500ms. Konum yayı `{stiffness 500, damping 60, mass 1}` (ζ≈1.34, taşmaz):
framer'da `springs.position` (`@demli/app-ui`), RN'de
`motion.spring.position` + `MOTION_PRESETS.position`, CSS'te
`--motion-ease-spring` = yayın örneklenmiş `linear()` eğrisi, 554ms
(`packages/ui/src/motion/spring.ts` üretir, test sabitler). Hover yayı
`{bounce .2, duration .4}`; RN karşılığı framer'ın kendi `findSpring`'iyle
çözülmüş `stiffness 505.6 / damping 36.0`. Hover'da ölçek/kayan metin YOK
(`pressable` artık yalnız basışta küçülür). Azaltılmış hareket: CSS global
koruma + `MotionConfig reducedMotion="user"` + RN `useReducedMotion()`/
`animate(..., { reduced })`. `m.*` yardımcıları (`MotionFade/Pop/Toast/Sheet`)
`LazyMotion strict` altında test edilir; `motion.*` orada beyaz ekran verir.

## 5. Bileşen reçeteleri (özet — canlı örnekler /design'da)

- **Buton (CTA):** radius 18, pad 16×32 (ikonluda sol 24), metin 16/24 →
  18/25.2, hover'da kayan metin. Birincil: beyaz zemin koyu metin.
  İkincil: `surface-2`. Vurgulu: `accent` zemin koyu metin (yeni).
- **Nav hapı:** `bg-raised` + blur, radius 16, pad 12/24-12; sekmeler kayan
  hover'lı; GitHub = Invertocat + yıldız çipi; dil = dropdown.
- **Hap/rozet:** radius 50, `bg-veil` + blur(8), iç gölge imzası.
- **Kart:** `bg-base`, radius 32/44, kenar yok; hover `rgba(23,23,23,0.72)`.
- **Yorum kartı:** radius 24, pad 24, isim 14/19.6 · tarih 12/14.4 ·
  gövde 16/24 op .7.
- **Giriş alanı (ürün):** `bg-surface`, radius 12, focus'ta `accent-soft`
  zemin + `accent` çizgi izi (kenarsız dil korunur).
- **Seçili satır (ürün):** `accent-soft` zemin, `accent` metin/ikon.
  Satır hover'ı sade: yalnız yüzey açılır (#171717, 200ms) — kayan metin
  hover'ı YALNIZ landing'e özgüdür, ÜRÜN BİLEŞENLERİNDE KULLANILMAZ
  (founder kararı; buton hover'ı da ton geçişidir).
- **Ürün butonları:** 5 varyant (birincil beyaz · ikincil surface-2 ·
  mercan · tehlike danger-soft · hayalet), 3 boy (lg 14/12×20/15 ·
  md 12/10×16/14 · sm 10/6×12/13); devre dışı %40.
- **Metin girişi:** etiket 13 üstte; alan radius 12, pad 10×14, rest
  #171717 → focus #262626 + mercan imleç; yardım metni 13 dim.
- **Validasyon:** hata = alanın zemini `danger-soft` + altta 13px danger
  düz mesaj (çerçeve/ring/ikon YOK); form düzeyi = uyarı bandı.
- **Kiplikler:** örtü veil+blur(4); kart radius 24 bg-base pad 24, başlık
  display 20; butonlar sağ altta (hayalet + eylem); yıkıcı eylem tehlike
  butonu; form kiplikleri form+validasyon reçetesini taşır.
- **Ayarlar:** ada dilinde — sol bölüm listesi (kanal listesi reçetesi) +
  içerik paneli; gruplar surface kartında, anahtarlar ayar satırında,
  yıkıcı işlemler danger-soft "tehlike alanı" kartında.
- **Anahtar/radyo/onay kutusu:** anahtar 44×24 (top authored spring);
  radyo seçili satırı accent-soft; onay kutusu 18px radius 6, işaretli
  accent + koyu check.
- **Ses sürgüsü:** ray 4px surface-2, dolu accent, top 14px beyaz +
  2px koyu halka, değer beyaz-%12 hap çipinde.
- **Profil kartı:** radius 24 bg-base kenarsız; üstte mercan parıltı
  bandı; avatar 64 (2px halka + online nokta); roller beyaz-%12 hap;
  eylemler mercan md + ikon butonu.
- **Avatarlar:** her boyda 2px #0d0d0d halka; konuşan +2px accent halka;
  online nokta boyun %30'u, success; küme bindirmesi −%30.
- **Parıltılar:** radyal `accent-glow` (yeşilin yerine), blur(8) yalnız
  şerit parıltısında.

## 5.1 Atomik yapı ve bileşen envanteri

Sistem kodu atomic design'la örgütlü (`apps/landing/src/design/`; entegrasyonda
`packages/ui`ye taşınır) — showcase sayfası template'tir:

- **tokens.ts** — renk/spring sabitleri (tek kaynak).
- **atoms.tsx** — UrunButonu (5 varyant × 3 boy), IkonButonu (yerleşik
  ipuçlu), IpucuSarmal, Avatar, AvatarKume, Anahtar, OnayKutusu, Radyo,
  GirisAlani, AramaAlani, SesSurgusu, BahsetmeCipi, TepkiCipi,
  YaziyorNoktalari, NoktaDurum, SayacRozeti, KisayolTusu, RolCipi, Iskelet.
- **molecules.tsx** — Composer, MesajSatiri, OkunmadiAyraci, TarihAyraci,
  BolumEtiketi, YaziyorSatiri, DosyaKarti, UyeSatiri, KanalListesi,
  AyarSatiri, SecimKutusu, BaglamMenuluMesaj, KatilimciTile,
  EkranPaylasimKarosu, GelenAramaKarti, ProfilKarti, KullaniciCubugu,
  Ipucu, BosDurum, IskeletListe.
- **organisms.tsx** — KiplikOrtusu + OnayKipligi/FormKipligi/DavetKipligi,
  AyarlarKabugu, UygulamaOnizleme.
- **ekranlar.tsx** — tam yüzey önizlemeleri: EkranSesliOda, EkranYaziKanali,
  EkranYayinOdak, EkranAyarlar, EkranBosMasa (yapı üründen, stil sistemden).
- **vitrin.tsx** — showcase yardımcıları (SayfaBaslik, Bolum, Spec, Swatch).

Showcase sayfalandı (sol kenar çubuğuyla gezinilir): `/design` genel bakış ·
`/design/temeller` · `/design/atomlar` · `/design/molekuller` ·
`/design/organizmalar` · `/design/ekranlar`. Her örnek canlıdır.

Ek reçeteler: bahsetme (accent-soft çip) · tepki (rounded-50, benimki
accent-soft) · yazıyor (3 nokta, 1.2s nefes) · okunmadı ayracı (accent-soft
iz + "yeni" çipi) · dosya kartı (radius 16 surface + tür kutusu + indir) ·
gelen arama (avatar 48 + 1.4s nefes alan parıltı, Katıl mercan / Reddet
tehlike) · ekran paylaşım karosu (16:9, canlı hapı, tam pencere kutusu) ·
iskelet (animate-pulse surface) · boş durum (ikon 48 + display 18 + mercan sm).

## 6. Ruh (VIBE) — bu sistemin imzası

Saf siyah üzerinde tek sıcak ışık. Kenarsızlık: hiçbir kutunun çizgisi
yok, her şey yüzey tonuyla ayrılır. Büyük, sakin display tipografi; iki
tonlu başlıklar. Hareket ödüllü ama yumuşak: her şey spring, hiçbir şey
lineer kaymaz. Işık motifi (huzme + parıltı) markanın "dem" ışığıdır ve
artık mercan tonundadır. Doku: 128px noise karosu, screen blend, düşük
opaklık. Doluluk düşük: az öğe, bol nefes.

## 7. Entegrasyon — gerçek dikiş ve sıra

**Düzeltme:** önceki adım 1 (`packages/app-ui/tokens.css`'i yeniden yaz)
masaüstü ve web'de HİÇBİR ŞEYİ değiştirmezdi — o dosya ikisine de import
edilmiyor. Gerçek dikiş:

- **Masaüstü + web:** `apps/desktop/src/renderer/src/styles/globals.css`
  `@theme` (`--color-*`, `--radius-*`, `--text-*`, `--font-*`) ve `:root`
  (`--motion-*`). Web bu dosyayı `apps/web/src/styles/desktop-shell.css`
  üzerinden import eder; her semantik sınıf `var(--color-*)`'a derlenir.
- **`tokens.css`:** çerçevesiz, nötr beyan (`--tc-*`). Kimse import etmez;
  iki tarafın da karşılaştırıldığı referanstır.
- **Mobil:** `apps/mobile/src/theme/theme.ts` (+ `motion.ts`,
  `motion-presets.ts`, `fonts.ts`).
- **Kilit:** `apps/desktop/.../styles/design-tokens.test.ts` (globals ⇄
  tokens: renk, radius, hareket, font, yay eğrisi + WCAG kontrast + tehlike
  renk-körlüğü ayrımı) ve `apps/mobile/src/theme/__tests__/design-tokens.test.ts`
  (theme.ts ⇄ tokens: renk, radius, tipografi, süre, yay + kontrast + font
  dosyaları). Bir değer değişirse üç dosya birlikte değişmeden test geçmez.

Sıra (M16 planı):

1. ✅ Dalga 2: token'lar (üç dosya birlikte), fontlar, hareket, `packages/ui`
   atomları (Button, IconButton+Tooltip, Avatar/AvatarGroup, Input/Textarea/
   Field, Switch, Checkbox, Radio, Slider, Select, Dropdown/Context menü,
   Dialog/Sheet, Toast, Skeleton, Badge/CountBadge, Kbd, Chip'ler) — mevcut
   API'ler korunarak yerinde yeniden stillendi.
2. ⏳ Founder G2: `/ui-kit.html` (Parçalar · Giriş ekranı · Sesli sahne).
3. Dalga 3 (masaüstü + web) / Dalga 4 (mobil): ekran ekran tarama. Token
   değişiminin YAKALAMADIĞI elle düzeltilecek değişmezler: pencere flaş rengi
   (`main/index.ts` `#0c0304`), iki `index.html` önyükleme iskeleti, BootSplash
   gradyanı, VideoStage `#2a0f07→#0c0403` gradyanı, CameraPip, VideoTileLabel,
   AvatarTile, EmojiMartPicker RGB üçlüleri, `lib/banner.ts`, LinkEmbedCard
   `#171c25`, mobil `push-manager.ts`/`foreground-service.ts` eski turuncu,
   `app.json` splash/ikon renkleri (APK gerekir). 511 `border` kullanımı ve
   `shadow-*` kalıntıları kenarsız dile tek tek çekilir.
4. Landing'in yeşil vurguları mercana çekilir; Stack Sans → Onest (landing
   dalının sahibi).
5. `brand-system.md` §6/§8 bu sistemle güncellenir (hâlâ sıcak rampa ve
   "saf beyaz metin yok" diyor).
