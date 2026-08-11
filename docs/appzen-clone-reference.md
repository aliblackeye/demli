# Appzen birebir klon — keşif referansı

Kaynak: https://appzen.framer.website/ (founder lisanslı Framer template'i).
Hedef: `apps/landing` — Next.js (App Router, static export), atomic design,
GSAP + Lenis + framer-motion, dev sunucu `localhost:3000`. Bu doküman
site-replication skill'inin "repo'ya özel ölçülen değerler" dosyasıdır;
bölüm klonlanırken ölçülen kesin değerler buraya işlenir.

## Bölüm haritası (1280px, ilk yükleme)

| Bölüm (data-framer-name) | top | yükseklik |
| --- | --- | --- |
| [Section] Nav (fixed) | 0 | 83 |
| [Section] Hero | 0 | 2105 |
| [Section] Features | 2105 | 2186 |
| [Section] Reviews | 4291 | 1555 |
| [Section] Pricing | 5846 | 1102 |
| [Section] Footer | 6948 | 1430 |
| Features Section Floating CTA (fixed) | scroll'a bağlı | 125 |
| Top/Bottom ProgressiveBlur (fixed) | viewport | 120 / 180 |

Not: `networkidle` + tam scroll sonrası toplam yükseklik 9978'e çıkıyor
(ilk ölçüm 8378). Lazy açılan içerik var — bölüm bölüm yeniden ölçülecek.
Tablet 810px: 10023, mobil 390px: 8863.

## Renk tokenları

| Rol (tahmini) | Değer |
| --- | --- |
| Zemin | `#0d0d0d` |
| Yüzey 1 | `#171717` (+ `#171717b8` yarı saydam) |
| Yüzey 2 | `#262626` |
| Kenar/çizgi | `#404040` |
| Metin birincil | `#f5f5f5` |
| Metin ikincil | `#a3a3a3` |
| Metin sönük | `#737373` |
| Vurgu (yeşil) | `#22c55e` (+ `#22c55e00` gradyan ucu) |
| Yıldız/sarı | `#eab30a` |
| Beyaz/siyah | `#fff` / `#000` / `#e5e5e5` / `#f5f5f5` |
| Saydamlar | `#0000003d`, `#ffffff1f`, `#0d0d0db8` |

## Tipografi

- Gövde: **Inter** 400/500/700 — framerusercontent'ten unicode-range'li
  woff2 alt kümeleri; klonda Google Fonts/Fontsource tam set kullanılacak.
- Başlık: **Stack Sans Headline** 400/500/600/700 — `fonts.gstatic.com`
  üzerinden (Google font). Ölçülen kullanım örnekleri:
  H1 112px/600, 56px/500, 52px/400, 44px/400, 28px/700.
- Gövde varsayılanı: 18px, line-height %140, `text-wrap: balance`,
  OpenType özellikleri: `"blwf","cv09","cv03","cv04","cv11"`.
- Link rengi: `#09f` (Framer varsayılanı — gerçek kullanımda ezildiği
  yerler bölüm ölçümünde netleşecek).

## Animasyon envanteri (ilk tespit)

- **17 appear efekti** (`data-framer-appear-id`): Navbar, Tagline, Title,
  Mockup Wrapper, Buttons, Video Wrapper'lar, Light Rays Wrapper'lar,
  "Light" (yüzen CTA). Değerleri (y-offset, süre, easing, stagger)
  modüllerden çözülüp scroll konumlarında ölçülerek doğrulanacak.
- **8 shimmer metin animasyonu**: `shimmer-*` keyframe, 3s linear infinite.
- **Fixed katmanlar**: Nav, Features Floating CTA (scroll'la görünür),
  Top ProgressiveBlur (120px), Bottom ProgressiveBlur (180px).
- **Videolar**: 2 framerusercontent webm (ışık huzmeleri) + 1 cloudinary
  webm (footer BG). Ticker'lar: logo şeritleri (hero + footer bölgesi).

## Asset envanteri (ana olanlar)

- Telefon mockup PNG/WebP'leri: `2mtt8wGCJXMs87jsvHRFg3m68Y.png`,
  `pYqeuA6vPWnavCp029xVQ7bFkTQ.webp`, `q7C91U2QZqfLWHxBY6xIe568C2A.png`,
  `My8MpuiQlA6S8qTwBVY75yhHEZ0.png`, `UYzBFdJQj66igrI8votemtHsEg.png`
- Ekran görüntüsü çerçevesi: `j6CDSJq9i4ibu7tPn5mm1FqLU.webp` (1920×871)
- App ikonu: `S9bfaQpnJQTB0PuEdiTu2F4i7zw.png`, footer ikon:
  `tsnwcDuNxGuvQisjNnoYPAoCyhk.png`
- Avatarlar: 4×76px jpg + 32px jpg
- Noise dokusu: `6mcf62RlDfRfU61Yg5vb2pefpi4.png` (256×256, repeat)
- Videolar: `mFAWTRLyYdZLliu04GwwDthusZQ.webm`,
  `DlHR9x8xMldHUIw61nmC1uMLw.webm` (×4 kullanım),
  `res.cloudinary.com/djdhzjwru/video/upload/v1776402111/5_ti4qay.webm`

Hepsi `framerusercontent.com` üzerinde herkese açık; klonda
`apps/landing/public/` altına indirilecek.

## Modül envanteri

`scratchpad/appzen-ref/modules/` altına indirildi (10 dosya):
`script_main.C3cZyIhF.mjs`, `react.yv2l4TOJ.mjs`, `motion.CSjfHx7_.mjs`,
`framer.C_zBRueq.mjs`, `shared-lib.DbcX6o3I.mjs` (695KB),
`AKQe783Ra9ZBbSPUNw8VLvk4JNyS6OKtiEyt-2zcWU8.2Ih7z4wN.mjs` (220KB — sayfa
bileşeni, animasyon değerleri burada), `wl7F4RZ3C.DzIty8xo.mjs` (56KB),
`dnZBXGY1a.WwjeVyd6.mjs`, `augiA20Il.CEa2U__j.mjs`, rolldown-runtime.
İkinci seviye import yok — küme kendi içinde kapalı.

## Doğrulama kuralı

Her bölüm için skill reçeteleri (konum/tipografi beşlisi, scroll eğrisi,
hover iki eksen, ekran görüntüsü karşılaştırma) referans ve klonda AYNI
koşularak sayısal tablo çıkarılır; fark kapatılmadan bölüm bitmez.
Referans tam sayfa görüntüleri: `scratchpad/appzen-ref/appzen-{desktop,tablet,mobile}-full.png`.
