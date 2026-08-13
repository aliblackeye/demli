# Demli Design System v1 — "Koyu Masa"

Landing'den (apps/landing) uçtan uca çıkarılmış, ürünün web + masaüstü
yüzeylerine taşınacak tek sistem. **Durum: FOUNDER ONAYI BEKLİYOR.**
Canlı örnek: `localhost:3001/design`.

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

Ürün eşlemesi (entegrasyonda): `--tc-rail→bg-page`, `--tc-app→bg-base`,
`--tc-surface→bg-surface`, `--tc-raised→bg-surface-2` vb. Sıcak
"Demli Voice v2" rampası emekli olur (founder kararı).

### 1.2 Metin rampası

| Token | Değer | Kullanım |
|---|---|---|
| `text-display` | `#ffffff` | Büyük başlıklar |
| `text-primary` | `#e5e5e5` | UI birincil metin |
| `text-secondary` | `#a3a3a3` | İkincil metin, gövde |
| `text-dim` | `#737373` | Sönük metin, ikonlar |
| `text-faint` | `#404040` | Telif, en silik |

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
| `danger` | `#ff6fb5` | Mercandan ≥30° hue uzaklığı (brand-system kırmızı disiplini) — hata daha kuvvetli bir kırmızı OLAMAZ |
| `warn` | `#eab30a` | Altınla paylaşır |
| `info` | `#a3a3a3` | Nötr — soğuk SaaS mavisi markaya giremez (brand-system §8) |

### 1.5 Çizgiler / ayraçlar

Kenar çizgisi YOK denecek kadar az: yüzey farkı + radius ayrımı esas.
Gerekirse `stroke` `rgba(255,255,255,0.08)`, `stroke-strong` `0.16`.
İç gölge imzası: `inset 0 -1px 0 rgba(38,49,64,0.32)` (hap/rozet).

## 2. Tipografi

- **Display: Onest (OFL, latin-ext ✓)** — Stack Sans Headline'ın ücretsiz
  karşılığı olarak öneri; alternatifler: Schibsted Grotesk, General Sans.
  Showcase Onest ile basılmıştır; beğenmezsen alternatife tek satırla geçilir.
- **Gövde/UI: Inter (OFL)** — mevcut, kalır. `cv` OpenType özellikleri yalnız
  Inter'de; display fontta `font-feature-settings: normal`.

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
- **atoms.tsx** — UrunButonu (5 varyant × 3 boy), IkonButonu, Avatar,
  AvatarKume, Anahtar, OnayKutusu, Radyo, GirisAlani, AramaAlani,
  SesSurgusu, BahsetmeCipi, TepkiCipi, YaziyorNoktalari, Iskelet.
- **molecules.tsx** — Composer, MesajSatiri, OkunmadiAyraci, YaziyorSatiri,
  DosyaKarti, UyeSatiri, KanalListesi, AyarSatiri, SecimKutusu,
  BaglamMenuluMesaj, KatilimciTile, EkranPaylasimKarosu, GelenAramaKarti,
  ProfilKarti, KullaniciCubugu, Ipucu, BosDurum, IskeletListe.
- **organisms.tsx** — KiplikOrtusu + OnayKipligi/FormKipligi/DavetKipligi,
  AyarlarKabugu, UygulamaOnizleme.

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

## 7. Entegrasyon planı (ONAYDAN SONRA — bu doküman onaylanmadan başlamaz)

1. `packages/app-ui/tokens.css` yeni anlamsal tokenlarla yeniden yazılır
   (`--tc-*` adları korunur, değerler bu sisteme çekilir — web Tailwind v3
   + desktop v4 aynı dosyadan beslenmeye devam eder).
2. Landing'in yeşil vurguları mercana çekilir (CSS parıltıları + accent
   sınıfları + görsel üretim promptlarıyla uyumlu).
3. Display font değişimi: landing'de Stack Sans woff2'leri Onest ile
   değiştirilir (lisans temizliği), ürün display rolleri Onest'e bağlanır.
4. Desktop renderer + apps/web bileşen taraması: buton/kart/satır/panel
   reçetelere çekilir (ui-quality-review + slop-check kapılarından geçer).
5. brand-system.md §8 bu sistemle güncellenir (görsel yön: "Koyu Masa").
