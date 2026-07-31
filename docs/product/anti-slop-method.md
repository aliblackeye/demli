# Anti-Slop Üretim Hattı (kanonik yöntem)

Founder şikâyeti (2026-07-29): vibe-coding çıktısı özgün değil, sorun görmüyor, UX'i geri
kafalı, hata durumlarına düşüyor, yeşil teste güveniyor, senaryoları görmüyor, landing jenerik,
metni kötü dolduruyor. Bu doküman bunun **yapısal** çözümüdür. Manifesto değil, boru hattıdır.

Bağlayıcı dosyalar: bu doküman + `docs/product/brand-system.md`.
Uygulayan skill'ler: `surface-brief` (üretim öncesi) · `copy-voice` (metin) · `slop-check`
(üretim sonrası düşman geçiş). Karar kaydı: `docs/decisions/0021-anti-slop-pipeline.md`.

---

## 1. Teşhis — neden 12. zevk skill'i yazmıyoruz

Model, eğitim verisinin **medyanına** çöker: her landing'in ortalaması ortalanmış hero + üç
kart + mavi buton'dur ve "ortalama bir stil değildir, stilin yokluğudur" (SmoothUI, 925studios).
Depodaki 11 genel tasarım skill'i bunu çözmedi çünkü **onlar da geneldir**: daha kaliteli bir
medyana ("premium SaaS medyanı") iterler ama Demli'ye özgü hiçbir bağlayıcı karar içermezler.
Genel bir prior başka bir genel prior'la yer değiştirir; özgünlük ancak **projeye özel, yazılı,
bağlayıcı kararlar** üretimden ÖNCE varsa çıkar. Ayrıca çöküş **bileşen değil yerleşim (layout)
seviyesindedir** — terracotta butonlu standart hero yine sloptur; yasaklar yapısal olmalı.

Mekanizma tablosu (founder'ın 8 şikâyeti, doğrulanmış + 2 ek):

| # | Şikâyet | Mekanizma | Karşı-yöntem |
|---|---|---|---|
| 1 | özgün değil | medyana regresyon; çöküş layout seviyesinde | brand-system bağlayıcı + **yapısal** yasak listesi + imza envanteri (§4.3) |
| 2 | sorunu fark etmiyor | üreten göz = denetleyen göz; tek atış, öz-eleştiri döngüsü yok | farklı ajanla düşman geçiş (`slop-check`), üret→eleştir→düzelt→tekrar-değerlendir döngüsü |
| 3 | UX geri kafalı | eğitim verisi pazarlama sayfası + admin panel ağırlıklı, yüksek-craft ürün uygulaması az | brief'te güncel isimli referans seti + etkileşim envanteri (hover/focus/klavye/boş/sürükle) |
| 4 | hataya çok düşüyor | mutlu yol önce tasarlanıyor, hata sonradan yamanıyor | **5-durum yığını önce**: her ekran için boş/yükleniyor/kısmi/ideal/hata brief'te tasarlanır (Hurff UI Stack) |
| 5 | teste güveniyor | yeşil test = doğru ürün sanılıyor | test gerekli-ama-yetersiz; ekran görüntüsü + senaryo yürüyüşü kanıtı zorunlu |
| 6 | senaryoları görmüyor | senaryo girdi değil, akla gelirse geliyor | persona × giriş-durumu × ağ × izin matrisi brief'in zorunlu girdisi (Design for Real Life "stress cases") |
| 7 | landing özgün değil | hero+3-kart+lucide refleksi (layout monotonluğu) | şablon testi (§4.2) + imza envanteri; yapı marka fikrinden türetilir, şablondan değil |
| 8 | metni kötü dolduruyor | jenerik pazarlama dili; EN-düşünüp-TR'ye çevirme slop'u ikiler | sözel kimlik + ton haritası + yasak sözlük (`brand-system.md`), **TR-önce yazım**, takas testi (§4.1) |
| 9 | *(ek)* "beğenmedim" ölçülemiyor | slop öznel kalınca hiçbir şey bloklanamıyor | §4'teki nesnel testler — her biri PASS/FAIL, kanıt ister |
| 10 | *(ek)* skill yığılması | 11 genel skill çelişiyor, hiçbiri bağlayıcı değil | skill'ler **craft el kitabı**dır, karar kaynağı değil; brief > her genel skill (§6 yönlendirme) |

---

## 2. Boru hattı

```txt
Faz 0  BAĞLAYICI KARARLAR (bir kez, düzenlemesi ADR-disipliniyle)
       brand-system.md: onliness, sözel kimlik, ton haritası, yasak sözlük,
       yasak görsel/yapısal kalıplar, ayırt edici varlık defteri, seçilmiş görsel yön
       └─ zevk çatalları: 2-3 aday → founder seçer (tek atış YASAK)

Faz 1  YÜZEY BRIEF'İ (founder'a görünür her UI/landing/metin işi öncesi) → `surface-brief`
       senaryo matrisi + 5-durum yığını + hata metinleri ÖNCE + etkileşim envanteri
       + yapısal eskiz (≥3 beyan edilmiş imza hamlesi) + referans seti + TR-önce metin taslağı

Faz 2  ÜRETİM
       token'lardan çalış; genel skill'ler brief'ten SONRA craft için çağrılabilir;
       çelişkide brief kazanır. Metin işi `copy-voice` kurallarına tabi.

Faz 3  DÜŞMAN GEÇİŞ → `slop-check`
       üreten ajandan FARKLI bir ajan; ekran görüntüsü + senaryo yürüyüşü kanıtıyla
       §4 testlerini uygular. FAIL = merge/publish yok. Düzelt → yeniden geçir.

FOUNDER  zevk kararı = 2-3 aday arasından seçim (founder-taste-calibration);
         founder cihaz bulgusu = P0.
```

---

## 3. Faz 0-1'in zorunlu girdileri (özet — ayrıntı skill'lerde)

- **Senaryo matrisi:** persona (yeni üye / davetli misafir / 2 yıllık kullanıcı / mobil-yalnız)
  × giriş durumu (ilk açılış / dolu geçmiş / boş grup / davet linkinden) × ağ (iyi / kopuk /
  geri gelen) × izin (Owner / Member / Guest / mikrofon-kamera reddedilmiş). Her hücre ya
  tasarlanır ya açıkça N/A işaretlenir.
- **5-durum yığını:** boş, yükleniyor, kısmi, ideal, hata — ekran başına. Hata metinleri ideal
  durumdan ÖNCE yazılır; ham stack trace asla (CLAUDE.md §26).
- **Etkileşim envanteri:** hover, focus-visible, klavye yolu, uzun-metin taşması, boş liste,
  çok-öğe (100+), dokunma hedefi ≥44px (mobil), reduce-motion.
- **Yapısal eskiz:** sayfanın/ekranın tek satırlık yapı cümlesi + varsayılan şablondan
  ayrıldığı **en az 3 beyan edilmiş imza hamlesi** (bunlar `slop-check`'te doğrulanır).

---

## 4. Slop nasıl ÖLÇÜLÜR — nesnel testler (hepsi `slop-check` içinde)

1. **Takas testi (metin):** "Demli" yerine rakip bir uygulamanın adını koy.
   Cümle hâlâ doğruysa o cümle jeneriktir. Sayfadaki cümlelerin >%30'u takas geçiyorsa FAIL.
   (Neumeier onliness: farklılaşma "only" ile söylenemiyorsa yoktur.)
2. **Şablon testi (yapı):** sayfanın yapısını tek satırda betimle. Satır, varsayılan arketiple
   (ortalanmış hero → N özdeş özellik kartı → CTA bandı → footer; ya da mobilde jenerik
   tab-bar + kart listesi) beyan edilmiş sapma olmadan eşleşiyorsa FAIL.
3. **İmza envanteri:** denetleyen ajan, üretenin listesine bakmadan, "varsayılan bir üretimde
   asla çıkmayacak" **≥3 somut öğe** sayabilmeli (öğe = yapı, etkileşim, metin cümlesi, motif).
   Sayamıyorsa FAIL.
4. **Durum kapsamı:** 5-durum yığını ekran başına kanıtla (ekran görüntüsü). Hata veya boş
   durum eksikse FAIL.
5. **Senaryo yürüyüşü:** matristeki her hücre gezildi ya da N/A gerekçeli. Gezilmemiş hücre
   varsa FAIL.
6. **Yasak kalıp taraması:** `brand-system.md` §yasaklar + skill içi liste; tek eşleşme = FAIL
   (görsel, yapısal veya sözel).
7. **Ses/ton denetimi:** metinler ton haritasındaki hedef boyutlara uyuyor mu (NN/g 4 boyut);
   yasak sözlükten kelime var mı (grep'lenebilir liste).
8. **Kanıt kuralı:** yalnız yeşil test/typecheck ile gelen iş otomatik FAIL — görsel +
   senaryo kanıtı olmadan geçiş yok.

"Beğenmedim" bu 8 kapıdan geçen bir iş için hâlâ mümkündür — o zaman founder'a 2-3 aday
sunulur; kapılar zevki garanti etmez, slop'u eler.

---

## 5. Rollerin ayrımı

- **Üreten ajan:** brief'i uygular, kanıtı toplar. Kendi işini slop-check'ten GEÇİREMEZ.
- **Denetleyen ajan:** farklı bir ajan/oturum; merceği §4. Reddetme yetkisi tam.
- **Director:** brief'i onaylar, denetleyeni atar, founder'a aday sunumunu yapar.
- **Founder:** zevk çatallarında seçer; cihaz bulgusu P0.

---

## 6. Mevcut skill yönlendirmesi (yeniden yazma, çağır)

| Durum | Çağır | Not |
|---|---|---|
| Founder'a görünür UI/landing/metin işi başlıyor | `surface-brief` | brief yoksa üretim başlayamaz |
| Kullanıcıya görünen herhangi bir string | `copy-voice` | i18n kataloğuna giren her şey |
| Üretim bitti, merge/publish öncesi | `slop-check` | farklı ajan; `ui-quality-review` ile birlikte (o performans/yapı, bu özgünlük/kapsam) |
| Mevcut yüzeyi elden geçirme (audit) | `redesign-existing-projects` | yalnız audit prosedürü; karar kaynağı brief |
| Craft uygulama detayı (gölge, spacing, tipografi işçiliği) | `high-end-visual-design` | brief'ten SONRA, çelişkide brief kazanır |
| Görsel komp/konsept üretimi gerekiyorsa | `imagegen-frontend-web` / `-mobile` | üretilen komp da `slop-check` §4.2-4.3'ten geçer |
| Marka görseli/board | `brandkit` | brand-system.md sözel kimliğiyle beslenir |
| Kullanılmaz | `design-taste-frontend`, `gpt-taste`, `ui-ux-pro-max`, `stitch-design-taste`, `minimalist-ui`, `industrial-brutalist-ui` | genel prior enjeksiyonu; Demli kararlarıyla çelişme riski > katkısı. İhtiyaç doğarsa Director istisna verir. |

---

## 7. Kaynaklar

- SmoothUI — "AI Design Slop: Why AI-Generated UI Looks Generic": istatistiksel ortalama,
  slop işaretleri, kapalı döngü (üret→eleştir→düzelt) — https://smoothui.dev/blog/ai-design-slop
- 925studios — "AI Slop Web Design Guide (2026)": çöküşün layout seviyesinde olduğu —
  https://www.925studios.co/blog/ai-slop-web-design-guide
- Scott Hurff — UI Stack (5 durum: blank/loading/partial/ideal/error) —
  https://www.scotthurff.com/posts/why-your-user-interface-is-awkward-youre-ignoring-the-ui-stack/
- Meyer & Wachter-Boettcher — *Design for Real Life* (stress cases girdi olarak) —
  https://abookapart.com/products/design-for-real-life.html
- NN/g — "The Four Dimensions of Tone of Voice" (komik↔ciddi, resmî↔samimi,
  saygılı↔lauba­li, coşkulu↔düz) — https://www.nngroup.com/articles/tone-of-voice-dimensions/
- Mailchimp Content Style Guide — ses sabit, ton duruma göre; açık lisanslı örnek —
  https://styleguide.mailchimp.com/voice-and-tone/
- Neumeier — *Zag*, onliness statement ("only" testi) — https://www.cuspcapital.com/article/onliness-statement
- Romaniuk — *Building Distinctive Brand Assets* (fame × uniqueness ızgarası) —
  https://global.oup.com/academic/product/building-distinctive-brand-assets-9780190311506
- Figma — "How we run design critiques" (yapılandırılmış eleştiri formatları) —
  https://www.figma.com/blog/design-critiques-at-figma/

İşe yaramaz bulunanlar (denendi/elendi): genel "iyi tasarım" prompt paketleri (bu depodaki 11
skill dahil) — bağlayıcı proje kararı içermedikleri için medyanı kaydırıyor ama çöküşü
durdurmuyor; "AI detector" tarzı otomatik slop skorlayıcılar — UI/metin için güvenilir sinyal
üretmiyor, testlerimiz bu yüzden kanıt-temelli ve elle.
