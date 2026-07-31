# Demli Marka Sistemi (BAĞLAYICI)

Bu dosya Demli'nin sözel kimliğinin ve marka kararlarının tek kaynağıdır. Founder'a görünür
her yüzey (`surface-brief`), her kullanıcı metni (`copy-voice`) ve her denetim (`slop-check`)
buraya bağlanır. Değişiklik = founder onayı ya da Director kararı + bu dosyaya yazım.
Görsel yön (§8) 2026-07-29'da **AKŞAM** olarak KARARLANDI ve landing'de uygulandı
(`apps/landing/`). Ürün UI'ı hâlâ "Demli Voice v2" token'larını
(`packages/app-ui/src/tokens.css`) kullanır; AKŞAM'ın ürüne taşınıp taşınmayacağı ayrı bir
karardır ve bu dosya onu henüz iddia etmiyor.

---

## 1. Kimlik çekirdeği

**İsim.** "Demli" — uzun demlenmiş, koyu, sabırlı çay. İsim bir vaat: aceleye gelmemiş,
tavşan kanı bir yer. Paket adları ve alan adı da artık Demli (`@demli/*`,
`getdemli.com`); yalnız kurulu istemcilerin güncelleme yolunu taşıyan üç kimlik
(Android paket id'si, masaüstü `appId`, Expo slug'ı) eski adı korur — kullanıcı
hiçbirini görmez.

**Onliness (Neumeier formatı).**
Demli, *bir arkadaş grubunun kendi sunucusunda dönen* tek özel sesli ev'dir —
herkese açık bir platform değil, davetle oturulan bir masa.

**Marka fikri: MASA.** Bu kategorideki uygulamalar bir "sunucu"lar galaksisidir; Demli tek bir masadır. Çay ocağının
masası: herkes birbirini tanır, biri anlatır, biri ekranı çevirir, çay tazelenir. Her yüzey
kararı bu soruyla sınanır: *"Bu, kalabalık bir platform mu, yoksa bizim masamız gibi mi
hissettiriyor?"*

**Gerçek farklar (metinde kullanılacak hammadde — hepsi üründe doğrudur).** İki kolon: sol
taraf takas testinden GEÇER (rakipte yanlış), sağ taraf doğrudur ama rakipte de doğrudur,
yani **metne alınmaz** — yalnız ürün kararlarında kullanılır.

*Ayırt edici (metne girebilir):*
- Sunucuyu kendimiz işletiyoruz (kiralık VPS, yönetimi bizde; veritabanı Supabase).
  **Mülkiyet iddiası YASAK** — "kendi makinemiz", "bir şirketin bulutunda değil" gibi
  cümleler yanlıştır (aşağıdaki altyapı notu).
- Reklam yok, veri satışı yok, algoritmik akış yok.
- Davetle girilir; keşfet sayfası, herkese açık sunucu yok.
- Ücretli kademe yok: hiçbir kalite/özellik bir plana bağlı değil.
- Ekran yayını 480p→2K × 15/30/60, kamera 720p/1080p × 30/60 — seçim kullanıcıda, ücretsiz.
- Müzik modu: 256 kbps stereo, gürültü engelleyici kendiliğinden çekilir (AEC kalır).
- Tarayıcı sürümü masaüstü uygulamasının AYNI kodudur; kırpılmış bir web istemcisi yok.
- Google Play'e mahkûm değil; APK'yı uygulama kendi indirir, masaüstü kapanışta sessizce kurar.

*Doğru ama ayırt edici DEĞİL (metne girmez — hepsi rakipte de var):*
- Bağlantı kopunca sesli odanın kendini toparlaması.
- Birebir aramanın gruba yükselmesi; DM geçmişinin gizli kalması (bu kategoride grup
  sohbetinin geçmişi zaten ayrıdır — `packages/db/src/repositories/call-upgrade.ts` bizde
  yeni ve BOŞ bir kanal açar, doğru; ama fark değil).
- Kişi başı ses seviyesi, okunmadı çizgisi, mesaj arama, arama geçmişi, birlikte izleme.
- Sesli kanalda tek başına süresiz oturabilme (`feature-parity.md`: yaygın davranış).

*Artık DOĞRU OLMAYAN (iddia edilmez):* on yıllık iPhone / Safari 12 — `apps/web`
`esnext` hedefliyor, plugin-legacy kaldırıldı; en iyi çaba, vaat değil.

---

## 2. Ses (değişmez) — dört özellik

| Özellik | Böyle | Böyle değil |
|---|---|---|
| **Sıcak** — masaya çağırır | "Çayını al, gel." | "Hoş geldiniz, değerli kullanıcı!" |
| **Sakin** — kendinden emin, bağırmaz | "Reklam yok. Algoritma yok." | "DEVRİM NİTELİĞİNDE bir deneyim! 🚀" |
| **Somut** — davranış anlatır, sıfat değil | "Bağlantı kopunca oda kendini toparlar." | "Kusursuz, kesintisiz bağlantı teknolojisi." |
| **Bizden** — grup içi konuşma, pazarlamacı değil | "Küçük tutuyoruz; davetle girilir." | "Topluluğunuzu bugün ölçeklendirin!" |

Ses her yerde aynıdır; **ton** yüzeye göre değişir (§3). (Mailchimp ilkesi: voice sabit,
tone duruma göre.)

## 3. Ton haritası (NN/g 4 boyut: komik↔ciddi · resmî↔samimi · saygılı↔laubali · coşkulu↔düz)

| Yüzey | Ayar | Not |
|---|---|---|
| Landing / pazarlama | samimi, hafif esprili, sakin-coşkulu | Çay sıcaklığı burada serbest; ünlem israfı yine yasak. |
| Boş durumlar / ilk açılış | samimi, tek tutam espri | "Masa henüz boş" tonu; kullanıcıyı işe çağır. |
| Ürün UI (buton, menü, durum) | düz, samimi-ciddi arası | Kısa, fiil önde: "Odaya gir", "Ekranı paylaş". |
| Hata / veri kaybı / arama kopması | ciddi, düz, sıcak ama ŞAKASIZ | Sıra: ne oldu → uygulama ne yapıyor → sen ne yapabilirsin. Suçlama ve kod dökümü yok. |
| Bildirim / sistem | düz | Bilgi + eylem, süs yok. |
| Sürüm notları | samimi, somut | Ne değişti, kullanıcı dilinde; commit dili değil. |

## 4. Yazım kuralları

1. **Önce Türkçe.** Demli Türkçe düşünür; İngilizce metin Türkçe'nin doğal çevirisidir, tersi
   asla. İngilizce kendi başına akıcı okunur (kelimesi kelimesine çeviri de yasak).
2. **Takas testi.** "Demli" yerine rakip bir sohbet uygulamasının adını yaz; cümle hâlâ
   doğruysa cümle jeneriktir —
   §1'deki gerçek farklardan biriyle yeniden yaz ya da sil.
3. **Her iddia üründe karşılığı olan bir davranıştır.** Yerine getirilmeyen vaat metne giremez.
4. Sen'li hitap (TR), "you" (EN). "Siz" yalnız hukuki metinlerde.
5. Ünlem bütçesi: yüzey başına en fazla bir; hata durumlarında sıfır.
6. Emoji UI metninde yok (kullanıcı içeriği hariç).
7. Çay metaforu baharattır, sos değil: pazarlama ve boş durumlarda tek tutam; ürün UI'ında
   ve hatalarda kullanılmaz. ("Demleniyor…" gibi bir yükleme esprisi landing'de olabilir,
   arama kopması ekranında olamaz.)

> **Altyapı iddiaları — 2026-07-29'da düzeltildi.** "Kendi makinemizde / a machine we own"
> yazılmıştı: VPS **kiralık** (`docs/architecture/deploy.md`) ve veritabanı **Supabase**
> (`docker-compose.prod.yml` — bilerek postgres servisi yok), yani donanım mülkiyeti iddiası
> yanlıştı. Aynı kökten, "bir şirketin bulutunda değil" cümlesi de yanlıştı: her kullanıcı ve
> mesaj satırı Supabase'de duruyor, üstelik cümle "veri satışı yok"un yanında durduğu için
> tam da güven verdiği yerde açık veriyordu. Savunulabilir olan **işletme duruşu**dur
> ("sunucuyu biz işletiyoruz"), mülkiyet değil. Kural: altyapı hakkında yazılan her cümle
> `deploy.md` + `docker-compose.prod.yml` ile karşılaştırılır.

## 5. Yasak sözlük (grep'lenebilir; `copy-voice` ve `slop-check` tarar)

**TR:** sorunsuz · kusursuz · kesintisiz (iddia sıfatı olarak; teknik bağlamda davranış
anlatıyorsa serbest) · devrim · devrim niteliğinde · güçlü özellikler · zengin özellikler ·
benzersiz deneyim · deneyimin keyfini çıkar · hemen şimdi · fırsatı kaçırma · topluluğunu
büyüt/ölçeklendir · profesyonel çözüm · yeni nesil · yapay zekâ destekli · %100 güvenli ·
değerli kullanıcı

**EN:** seamless · flawless · revolutionary · game-changing · powerful features ·
rich features · unique experience · unleash · empower · supercharge · elevate ·
take ... to the next level · don't miss out · sign up now · scale your community ·
next-generation · AI-powered · 100% secure · blazing fast

**Yapısal metin yasakları:** üç özdeş "ikon + başlık + iki satır" kartıyla anlatım; "X için
Y" kalıbında boş hero ("İletişim için en iyi yol"); özellik listesini sıfat listesine çevirme;
CTA olarak yalın "Başla / Get Started" (ürüne özgü fiil kullan: "Demli'yi aç", "Masaya otur").

## 6. Ayırt edici varlık defteri (Romaniuk: fame × uniqueness hedefi)

| Varlık | Durum | Kural |
|---|---|---|
| İnce belli çay bardağı (logo/maskot) | canlı, güçlü | Tek maskot budur; başka maskot/karakter üretilmez. Silüeti (kavisli negatif alan) ikincil grafik motif olarak kullanılabilir. |
| Buhar kıvrımı | canlı (logoda) | Tek "canlı" süs motifi: yükleme, boş durum, ayraç. Başka dekoratif motif eklenmez. |
| Konuşma balonu + buhar birleşimi | canlı (logoda) | Yalnız markalama yüzeylerinde; UI ikonu olarak kullanılmaz. |
| Sıcak kırmızı-turuncu rampa | canlı (tokens.css) | Mor-cyan, neon, soğuk SaaS mavisi markaya giremez. |
| Cream metin (#F8EED4 ailesi) | canlı | Saf beyaz metin yok. |
| "Çayını al, gel." çağrısı | aday | Tutarsa kalıcı slogan adayı; her yüzeyde aynı biçimde yazılır. |

## 7. Landing metni — GERÇEK metin (doldurma değil)

Yapı önerisi metinle birlikte gelir: özdeş üç kart yerine **sahne anlatımı** (bir akşamın
akışı) + **dürüstlük bloğu** (altyapı gerçekleri) + indirme. Uygulama ayrı bir dalganın işidir;
o dalga `surface-brief`ten geçer.

> **2026-07-29 düzeltmesi — bu bölüm bir kez YANLIŞ BEYAN taşıdı.** Burada "metnin tamamı
> takas testinden geçirilmiştir" yazıyordu; geçirilmemişti. Sahne bloğunun beş vuruşundan
> dördü ("yayını pencereye alma", "oda kendini toparlar", "ikili arama gruba dönüşür",
> "okunmadı çizgisi") "Demli" yerine rakip bir uygulamanın adı konunca aynen doğru
> kalıyordu, yani jenerikti
> (`anti-slop-method` §4.1). Metin oradan landing'e birebir kopyalandığı için hata yüzeye
> taşındı ve `slop-check` FAIL verdi. Aşağıdaki vuruşlar yeniden yazıldı ve **her birinin
> dayanağı yanına yazıldı**. Kural: bu bölümden bir cümle alan yüzey, dayanağı da alır;
> dayanağı olmayan cümle bu bölüme giremez ve "geçirilmiştir" beyanı, gerçekten
> geçirilmeden bir daha yazılmaz.

**Takas testinin kestikleri (doğru ama AYIRT EDİCİ DEĞİL — metne alınmaz):** kopan
bağlantıdan sonra odanın kendini toparlaması · ikili aramanın gruba yükselirken DM
geçmişini gizli tutması (bu kategoride grup sohbetinin geçmişi zaten ayrıdır) · kişi başı ses seviyesi ·
okunmadı çizgisi · birlikte video izleme · sesli kanalda tek başına süresiz oturabilme
(`feature-parity.md`: yaygın davranış).

### Meta (başlık + açıklama) — KAPI BURADA DA GEÇERLİ

Arama sonucunda ve her paylaşımda görünen metin budur, yani sayfayı hiç açmamış birinin
gördüğü TEK cümle. Bu bölümün var olma sebebi bir hata: hero ve dürüstlük bloğundan
kaldırılan yanlış altyapı iddiası ("kendi sunucumuzda çalışır") meta'da kaldı ve iki tur
boyunca canlıda dağıtıldı — çünkü §7'nin meta bölümü yoktu, dolayısıyla hiçbir kapı onu
taramıyordu. **Bir cümle §7'de yoksa denetlenmiyor demektir.**

- **TR başlık:** Demli — arkadaş grubunun sesli evi
- **TR açıklama:** Sesli odalar, ekran paylaşımı, görüntülü arama ve sohbet — hepsi açık,
  ücretli kademe yok. Reklam yok, algoritma yok, davetle girilir.
- **EN başlık:** Demli — your friend group's own place
- **EN açıklama:** Voice rooms, screen sharing, video calls and chat — all of it unlocked,
  with no paid tier. No ads, no algorithm, invite-only.
- *Dayanak:* ücretli kademe yok → repoda billing/subscription/entitlement kodu yok (iki
  bağımsız arama). Ayırt edici olan bu; "sunucuyu kendimiz işletiyoruz" DOĞRU ama rakip de
  kendi sunucusunu işletir, yani takas testinden geçiyordu — meta'da ve hero'da yer alamaz.

### Hero
- **TR başlık:** Çayını al, gel.
- **TR alt:** Demli, arkadaş grubunun sesli evi. Sesli odalar, ekran paylaşımı, görüntülü
  arama, sohbet. Hepsi açık; ücretli kademe yok. Davetle girilir.
- **EN başlık:** The kettle's on.
- **EN alt:** Demli is your friend group's own place. Voice rooms, screen sharing, video
  calls, chat. All of it unlocked; no paid tier. You get in by invitation.
  ("voice house" İngilizce'de bir şey ifade etmiyordu — TR'deki "sesli ev"in birebir
  çevirisiydi ve §4.1'in yasakladığı kelimesi kelimesine çeviriydi.)
  > Ses A: uzun tire ile bağlanmış tek nefeslik cümle, üç kısa bildirime bölündü. Bilgi
  > aynı; kayıt sertleşti.
- CTA'lar: "Demli'yi aç / Open Demli" · "Uygulamayı indir / Get the app" (mevcut, korunur).

### Sahne bloğu — "Bir akşam, Demli'de" / "One evening on Demli"
Üç özdeş kart değil; saat ilerledikçe akan tek anlatı. Her cümle gerçek bir ürün davranışı —
ve **her vuruş "Demli için doğru, rakip bir uygulama için yanlış" olmak zorunda**. Dayanaklar vuruşların
altında; dayanağı doğrulanmadan bu liste değiştirilmez.

- **21:04 —** TR: Biri sesli odaya girer, rozeti yanar. Kanal 128 kbps'te açık; kimsenin bunu
  açmak için sunucuyu yükseltmesi gerekmedi. Bit hızı burada bir kanal ayarı, kazanılan bir
  ödül değil.
  EN: Someone joins the voice room and their badge lights up. The channel is running at
  128 kbps, and nobody had to level the server up to get it there. Bitrate is a channel
  setting here, not a reward.
  *Dayanak:* `packages/config/src/index.ts` `AUDIO_BITRATE_PRESETS_KBPS = [8, 64, 128]`,
  kanal ayarı olarak sunuluyor; hiçbir kademe/ödeme kapısına bağlı değil (billing kodu
  repoda yok — iki bağımsız arama).
  *Neden eski cümle DÜŞTÜ:* "masaüstü ile tarayıcı aynı uygulamadır" bizde DOĞRU ama
  ayırt edici DEĞİL — dayanağı yalnız bizdeki doğruluğu kanıtlıyordu. Bir vuruşun dayanağı
  "bizde şöyle" değil, **"başkasında böyle değil"** olmak zorunda; ilk turda FAIL'e yol
  açan metodoloji hatası tam olarak buydu ve ikinci turda yeni cümlelerde tekrarlandı.
- **21:15 —** TR: Ekran paylaşılır. Çözünürlüğü de kare hızını da paylaşan seçer: 480p'den
  2K'ya, 15, 30 ya da 60 kare — listenin üst ucu kilitli değil, hepsi açık. Kamera da öyle:
  1080p, saniyede 60 kare.
  EN: A screen goes up. Whoever shares it picks the resolution and the frame rate: 480p
  through 2K, at 15, 30 or 60 — the top of that list is not locked behind anything. The
  camera too: 1080p at 60 frames a second.
  *Ayırt edici olan kısım "üst ucun kilitli olmaması":* seçenek listesi tek başına ayırt
  etmiyor, listeyi AÇIK sunmak ediyor.
  *Dayanak:* `packages/media/src/quality.ts` (`SCREEN_SHARE_RESOLUTIONS` 480p→1440p ×
  `SCREEN_SHARE_FRAME_RATES` 15/30/60, hücre başına bitrate tavanı) ·
  `video-settings.ts` (`CAMERA_QUALITIES` auto/hd/fhd × `CAMERA_FRAME_RATES` 30/60).
  UI'da 1440p "2K" etiketiyle çıkar (`VideoSettingsForm.tsx`, `SourcePicker.tsx`) —
  metin kullanıcının gördüğü etiketi kullanır. "Sınırsız/tavansız" DENMEZ: her hücre
  bilerek sınırlı.
- **21:40 —** TR: Biri gitarını getirir. Sesini müzik moduna alırsın: 256 kbps stereo,
  gürültü engelleyici kendiliğinden çekilir — açık kalsa teli gürültü sanıp kemirirdi.
  EN: Somebody brings out a guitar. You put your sound into music mode: 256 kbps in stereo,
  and the noise suppressor steps aside — left on, it would hear the strings as noise and
  chew them up.
  *Dayanak:* `packages/media/src/audio-settings.ts` — `AUDIO_QUALITY_BITRATE_KBPS.music =
  256` (stereo), `effectiveNoiseSuppression` müzik modunda `off` döner, `AGC` kapanır,
  **AEC her modda açık kalır**. Ses kademesini kullanıcı seçer (sunucu/kanal ayarı değil).
- **23:00 —** TR: Üç saat oldu, kimse bir yükseltme ekranı görmedi. Demli'de ücretli kademe
  yok: 2K yayın da, müzik modu da, 60 karelik kamera da herkeste açık.
  EN: Three hours in, and nobody has seen an upgrade screen. There is no paid tier on Demli:
  the 2K stream, music mode and the 60fps camera are open to everyone.
  *Dayanak:* `apps/api/src`, `packages/db/src`, `packages/protocol/src` içinde ödeme /
  abonelik / hak-sahipliği (entitlement) kodu YOK; yukarıdaki kademelerin hiçbiri bir
  plana bağlı değil. **Şimdiki zaman kipinde yazılır** — geleceğe söz verilmez (§4.3).
- **02:30 —** TR: Film bitti, oda boşaldı, uygulamayı kapatırsın. Yeni sürüm varsa kapanışta
  sessizce kurulur — sihirbaz yok; telefonda da APK'yı mağaza değil, uygulamanın kendisi
  indirir.
  EN: The film's over, the room empties, you close the app. A new version, if there is one,
  installs quietly on the way out — no wizard; and on the phone the APK comes from the app
  itself, never a store.
  *Dayanak:* `apps/desktop/src/main/auto-update.ts` (`autoInstallOnAppQuit = true`, sessiz
  kurulum) · `apps/mobile/src/updates/native-apk.ts` (APK'yı uygulama indirir, sistem
  kurulumunu başlatır — tarayıcıya/mağazaya gönderilmez).

### Dürüstlük bloğu — "Kendi demliğimizde" / "Our own kettle"
- TR: Reklam yok. Veri satışı yok. Algoritmik akış yok.
- TR: Keşfet sayfası yok. Gruplara davetle girilir; masaya kimin oturacağını sen
  belirlersin.
- TR: Windows ve Android'de uygulama var. Mac'te, Linux'ta, iPhone'da kurulacak bir şey
  yok; Demli tarayıcıdan çalışır.
- EN: No ads. No data sales. No algorithmic feed.
- EN: No discover page either. You get into a group by invitation; who sits at the table is
  yours to decide.
- EN: Windows and Android have apps. On a Mac, on Linux, on an iPhone there is nothing to
  install; Demli runs in the browser.

> **Supabase itirafı KALDIRILDI (2026-07-29, ses A kararı).** Birinci satır şöyleydi:
> "Sunucuyu biz işletiyoruz; veritabanı da yüklediğiniz dosyalar da Supabase'de duruyor —
> onu da söylüyoruz." Bu, yapılmaması gereken bir iddiaya sonradan eklenmiş bir dipnottu.
> Fazla-iddianın çözümü tedarikçiyi ifşa etmek değil, **iddiayı hiç yapmamaktır**: bir
> landing sayfasının altyapı anlatması gerekmez, ve "sunucuyu biz işletiyoruz" zaten takas
> testinden geçiyordu (rakip de kendi sunucusunu işletir). Satır artık üç "yok"tan ibaret —
> hepsi doğru, hepsi denetlenebilir, hepsi bize ait. Sonuç olarak sayfa verinin nerede
> durduğu hakkında **hiçbir şey** söylemiyor; bu bir örtme değil, bir landing sayfası için
> doğru kapsam. Kaldırılan yanlış ifadeler `apps/landing/test/claim-sweep.test.mjs`
> tarafından hâlâ taranıyor (artık `dist/` üzerinde, kaynak listesi üzerinde değil).

> **"On yıllık bir iPhone'da bile" ÇIKARILDI (2026-07-29).** Bu bir takas testi sorunu
> değil, **tutulamayan bir iddiaydı**: `apps/web/vite.config.ts` `build.target: "esnext"`
> kullanıyor ve `@vitejs/plugin-legacy` kaldırıldı ("iPhone 6 / Safari 12 perfection is no
> longer required (best-effort only)" — founder onaylı). Eski Safari artık en iyi çaba,
> vaat değil. `apps/web/README.md` ve `apps/web/index.html` hâlâ eski hattı anlatıyor
> (bayat doküman, ayrı iş). Landing SAYFASININ KENDİSİ hâlâ safari12 hedefliyor
> (`apps/landing/vite.config.ts`) — ama sayfanın açılması, ürünün açılması demek değil.

### İndirme
- `download.lead` TR: "Windows ve Android için uygulama var. Diğer tüm platformlarda
  tarayıcıdan çalışır."
  EN: "Windows and Android have apps. Everywhere else it runs in the browser."
- `download.soon` TR: "macOS ve iPhone'da kurulacak bir şey yok."
  EN: "There is nothing to install on macOS or iPhone."
  > İki tur sürdü. Önce **söz veriyordu** ("macOS ve iOS demleniyor. Hazır olduklarında
  > burada olacaklar.") — macOS build hattı founder kararı bekliyor (`feature-parity.md`
  > 🚧), iOS'un planı yok, ve `copy-voice` tutulamayan iddiayı bloklar (§4.3). Sonra
  > **boşluğu savunuyordu** ("...uygulama yok, sözünü de vermiyoruz"): kimsenin istemediği
  > bir sözü reddetmek, sayfayı kendi eksiği hakkında konuşturur. Ses A ("kesin ve sade")
  > kararından sonra cümle olguyu söyleyip susuyor.
- Diğer indirme metinleri (Windows/Android notları) olduğu gibi kalır — takas testinden
  geçiyorlar çünkü somut davranış anlatıyorlar ("Google Play'de değil").

### Footer
- TR: "Demli sürekli güncellenir; yeni sürümler uygulamaya kendiliğinden gelir."
- EN: "Demli is updated continuously; new versions arrive in the app on their own."
  > Bir önceki footer ("Demli demlenmeye devam ediyor — küçük tutuyoruz, aceleye
  > getirmiyoruz") **yol haritası için özür diliyordu**. Ses A kararı: ziyaretçinin o
  > satırdan kazandığı şey güncelleme davranışıdır, o yüzden söylenen o. 02:30 vuruşuyla
  > aynı gerçeğe dayanıyor ama farklı bir soruya cevap veriyor (vuruş "bu akşam ne olur",
  > footer "bu şey bakımlı mı"), o yüzden tekrar sayılmıyor.

**Hero başlığı — KARARLANDI (2026-07-29): A, "Çayını al, gel." / "The kettle's on."**
Üç adaydan (B "Masa kurulu.", C "Arkadaş grubunun sesli evi.") bu seçildi ve üç görsel yön
turunun hepsinde aynı kaldı; artık §6'daki kalıcı slogan adayı statüsünü hak ediyor. Her
yüzeyde birebir aynı yazılır.

---

## 8. Görsel yön — KARARLANDI (2026-07-29): "AKŞAM"

Landing'in görsel dili artık tek: **AKŞAM**. Canlı uygulaması
`apps/landing/src/styles/aksam.css` ve `apps/landing/src/App.tsx`; bu bölüm o dosyaların
özeti değil, **niyeti**dir — yeni bir yüzey buradan türetilir.

### Tarif

- **Palet — koyu kakao, ışık olarak kırmızı.** Zemin `#241412` (LCh kroma 9: kahve-siyah,
  ne nötr ne doygun) ve üstünde birbirine çok yakın iki adım (`#33201c`, `#452c26`).
  Yakınlıkları kasıtlı: hiçbir yüzeyin sınırı parmakla gösterilemesin. Çay kırmızısı zemin
  değil **ışık**tır — hero'nun arkasındaki kenarsız parıltı, çip ve butonlardaki mercan
  (`#ff8464`). Metin sıcak açık (`#f6e7e0`), asla saf beyaz (§6).
- **Tipografi — Nunito, 400 ve 600.** Gerçekten yuvarlak uçlu: her çizgi kavisle biter,
  kesikle değil. **Başlıklar küçük harf.** Hiyerarşi ölçek ve boşlukla kurulur; **600
  üstü ağırlık yok.** Küçük/büyük harf çevirimi CSS'te değil TypeScript'te yapılır
  (`src/lib/case.ts`) — Türkçe I→ı eşlemesini motora bırakmak kelimeyi değiştirir.
- **Kenar — yok.** Tek bir `border`, `rule` ya da kıl çizgi yok. Bölüm ayracı **parıltı**:
  ayracın olacağı yere kenarı olmayan geniş bir radyal bloom konur. Her köşe ya kapsül ya
  en az 28px yarıçap.
- **Doku — grain.** `public/textures/grain.png`, 200×200 saydam zerre, tüm belgenin
  üstünde 0.38 opaklıkta. Düz koyu alan ekranda "CSS arka planı" gibi durur; bunun dişi
  var. CSP'de `data:` yok, o yüzden gerçek dosya (`scripts/gen-grain.mjs`).
- **İmza hareketi — netleşme.** Blok yerinde belirir ve 10px bulanıktan nete çözülür.
  Hiçbir şey kaymaz, ölçeklenmez, **hiçbir şey solmaz**. Üç hareket seçeneği içinde
  geometriyi hiç oynatmayan tek seçenek buydu: okuyan gözün altında hiçbir şey yer
  değiştirmiyor.
- **İşaret — yuvarlak uçlu kontur bardak.** `src/marks/glass.ts` + `DemliMark.tsx`. Dolgu
  yok, yalnız çizgi; `stroke-linecap`/`linejoin` round. Maskot, yüz, emoji, gradyan, 3D
  yok. Geometri tek dosyada durur, çünkü favicon/launcher/adaptive türevleri aynı
  koordinatlardan üretilmezse birbirinden kayar (o yayılım ayrı dalga; `assets/brand/`
  ve `brand-manifest.json`dan yalnız landing'in iki raster işareti çıkarıldı (47→45); platform ikonlarına dokunulmadı).

### Kırmızı disiplini (bağlayıcı)

Sayfanın tek vurgusu bir kırmızı olduğu için hata rengi **daha kuvvetli bir kırmızı
olamaz** — farklı bir HUE olmak zorunda. Serin pembe `#ff6fb5` (HSL 331°), mercan `#ff8464`'ün 12°'sine karşı — 41° ayrı.
Sayılar burada ÖLÇÜLDÜ; doküman bir süre 33°/351° yazdı ve hiçbiri kodla
eşleşmiyordu. Bağlayıcı olan test, bu satır değil. Ölçülüdür, göz kararı değil: ΔE00 ≥ 20 ve ≥ 30° hue ayrımı, artı `--danger`ın
`.notice` dışında hiçbir kuralda geçmemesi —
`apps/landing/test/color-contract.test.mjs` üçünü de kilitler.

### Kontrast (founder uyarısı üzerine sertleştirildi)

İlk sürüm her yerde WCAG AA'yı geçiyordu ve founder yine "mercan/kakao kontrastı düşük"
dedi. Ölçüm founder'ı doğruladı: mercan-kapsül üzerinde **4.60:1** — sınırın dört yüzde
biri üstünde. *AA'yı geçmek* ile *rahat okunmak* aynı iddia değildir. Mercan açıldı
(`#e8624a`→`#ff8464`, `#ff8168`→`#ffa48c`), grain 0.5'ten 0.38'e indirildi (metnin
üstünde durduğu için hiçbir token çiftinde görünmeyen tek kontrast kaybı buydu), ve
stylesheet'teki `@contrast` satırları mercan çiftlerini **≥ 7 / ≥ 6**'da kilitledi.

| çift | önce | sonra |
|---|---|---|
| gövde metni (`--ink` / `--ground`) | 14.72 | 14.72 |
| ikincil metin (`--ink-muted` / `--ground`) | 7.48 | **8.88** |
| mercan · kakao (`--brand` / `--ground`) | 5.30 | **7.38** |
| mercan · kapsül (`--brand` / `--ground-2`) | **4.60** | **6.40** |
| mercan-2 · açık kapsül (`--brand-2` / `--ground-3`) | 5.23 | **6.67** |

### Neden eski tarif düştü — TUZAĞI YAZ, silme

Bu bölüm üç aday sunuyordu: A "Ocak Başı", B "Tavşan Kanı" (**seçilmişti**), C "Gece
Demi". B uygulandı ve founder canlı sayfayı tek cümlede reddetti:

> "claude'un yaptığı bütün arayüzlerde aynı font var, aynı renkler, aynı çizgisellik,
> aynı animasyonlar."

Reddedilen tek tek özellikler değil, **paketti**: display serif (Instrument Serif) + krem
kâğıt + kıl çizgi ayraç + scroll'da opacity fade-up. Dördü birlikte üretilmiş-arayüz
imzasıdır; biri değişip diğer üçü kalırsa sayfa hâlâ aynı görünür. Bu yüzden §8'in eski
tarifi **silinmiyor, çürütülüyor**: doküman o tarifi hâlâ önerseydi bir sonraki yüzey
aynı yere sürüklenirdi.

İkinci tur da yanlış eksende arandı — matbaa afişi, İsviçre ızgarası, brütalist — ve
founder'dan şunları aldı: *"devasa iğrenç arial bi font"*, *"köşeli bi tasarım
istemiyorum yumuşak olsun"*, *"haber sitesi gibi olmuş amk"*. Buradan çıkan kalıcı
kurallar:

- **Yasak:** iri/ağır grotesk display (700+ ağırlık), köşeli dil (keskin köşe, 0-2px
  radius, kalın çerçeve), editoryal/gazete dili (sütun ızgarası, manşet-altbaşlık kalıbı,
  kıl çizgi ayraç, serif manşet), mono-ağırlıklı yön, krem kâğıt, opacity fade-up reveal.
- **Metodoloji:** zevk kararında tek atış yapma (memory: *founder-taste-calibration*), ama
  **adayların hepsi doğru ailede olsun** — üç yanlış aile üç ayrı ıskadır, tek bir
  seçenek turu değil. Ailenin kendisi founder'a sorulur.
- Bu kuralların makine tarafı `apps/landing/test/` altında: `motion-contract` fade-up'ı ve
  sonsuz döngüyü, `color-contract` kırmızı disiplinini ve kontrastı, `touch-target` beş
  durumu kilitler. Bir sonraki yüzey bunları miras alır.

---

## 9. Bu dosyanın kullanımı

- `surface-brief`: her brief §1-6'ya bağlanır; imza hamleleri §6 varlıklarından türetilir.
- `copy-voice`: §2-5 birebir uygulanır; yeni kalıcı cümleler §6 defterine aday yazılır.
- `slop-check`: §5 yasakları + §6 dışı motif/maskot üretimini FAIL sayar.
- Founder kararları: hero başlığı (§7) ve görsel yön (§8) **kapandı** — sırasıyla "Çayını
  al, gel." ve AKŞAM. Açık kalan tek şey, seçilen işaretin `assets/brand/` altındaki 47
  dosyalık ikon setine yayılması; o ayrı bir dalga ve Director planlar.
