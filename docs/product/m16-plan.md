# M16 — Tüm platformlarda arayüz yenileme + arama/ses hataları

- **Durum:** Taslak — founder onayı bekleniyor (onay gelmeden kod yazılmaz)
- **Tarih:** 2026-10-19
- **Kaynak:** founder saha raporu (masaüstü Windows ↔ Android, 1-1 görüntülü özel arama) + salt-okuma
  inceleme iş akışı `wf_addb26c3-6f4` (37 ajan; her hata kök nedeni 2 bağımsız denetçiyle çürütülmeye
  çalışıldı). Bulgu ayrıntıları en alttaki ekte.

## 1. Amaç

1. Arama/ses deneyimini bozan üç saha hatasını kök nedeninden düzeltmek. Davranış **özel aramada,
   sunucu sesli kanalında ve grup aramasında birebir aynı** olacak.
2. Web, masaüstü, Android (ve onaylanırsa iOS) arayüzünü landing'in "Koyu Masa" diline taşımak:
   yalnız renk değil; hareket, geçiş, his. Avatar yüklemeden profil kartına kadar her parça
   cilalı ve animasyonlu.
3. Kod kalitesi ve hata taraması; bulunanları dalgalara dağıtmak.

## 2. Konteks — ölçülen gerçekler

### 2.1 Hataların kök nedenleri (kanıtlı)

**H1 — Karşı taraf kendi sesini duydu (masaüstü, sistem sesiyle paylaşım).**
Kurucu makinesindeki kayıtlar zaman çizelgesini veriyor: 23:55–23:56Z arası **tüm ekran**
paylaşıldı. Bu yol film sesi için ya Electron'un tüm cihaz loopback'ini ya da adı
`/voicemeeter out|cable output|stereo mix|loopback/i` kalıbına uyan bir "sistem karışımı"
girişini (`Loopback 1 L/R (SSL 2+ MKII)`) yayınlıyor. İkisi de **Demli'nin çaldığı karşı taraf
sesini içeriyor** → karşı taraf kendini duyuyor. 23:59Z'de **tarayıcı penceresi** paylaşılınca
pencere-süreci yakalama devreye girdi (yalnız tarayıcının sesi) → "kendiliğinden düzeldi".
- `apps/desktop/src/main/capture.ts:198-200` — ses isteği her zaman `audio: 'loopback'`.
- `apps/desktop/src/renderer/src/lib/screen-share.ts:938` — süreç yakalama yalnız pencerelerde;
  ekranlar loopback/karışım merdivenine düşüyor (`:326-375`, `:808-822`).
- Paketlenen `ApplicationLoopback.exe` disassembly ile doğrulandı: mod sabit
  `INCLUDE_TARGET_PROCESS_TREE`. **"Demli hariç her şey" (exclude) modu hiç yazılmamış**
  (ADR 0006'nın önerdiği adım).
- Ek yankı yolları: (a) pencere yakalama düşerse yine loopback/karışım; (b) 8 sn sessiz kalan
  paylaşım sesini sistem karışımıyla **sessizce değiştiren** denetleyici
  (`screen-share.ts:1165-1188`) — temiz pencere sesini bile değiştirebilir; (c) karışım taraması
  varsayılan girişi önce deniyor, Voicemeeter kurulumunda bu **kullanıcının mikrofon yolu** —
  mikrofon "film sesi" diye yayınlanabiliyor; seçilen kaynak localStorage'da hatırlanıyor
  (zehirli hafıza temizlenmeli).
- Arayüz copy'si filmler için tam da yankılı yolu öneriyor (`desktop.json:802`).

**H2 — Masaüstü kullanıcı kendi sesini duydu (yayın kapalıyken de).**
En güçlü açıklama Android tarafı: her mobil oturum **hoparlöre** yönleniyor
(`AudioSwitchManager` tercih sırası BT > kablolu > hoparlör > ahize; Demli değiştirmiyor) ve
Android 10+'da yalnız telefonun **donanım yankı engelleyicisi** çalışıyor
(`LiveKitReactNative.kt:81-85`); hoparlörde birçok cihazda zayıf. Uygulama içindeki "yankı
engelleme / gürültü engelleme" zaten açıktı → açmak hiçbir şey değiştiremezdi. "Kendiliğinden
düzelme" büyük ihtimalle ses yolu/hoparlör seviyesi değişimi (cihazda doğrulanacak). Masaüstü
tarafında da kurucunun mikrofonunda AEC/AGC/NS **kapalı** kayıtlıydı (kendi ayarı); bu ayar
uyarısız kapatılabiliyor. Ayrıca Electron 33'te `applyConstraints` ses işlemeyi canlı
değiştirmiyor → masaüstünde açma/kapama yeniden katılmaya kadar sahte olabilir (ölçülecek).

**H3 — Web'den ekran paylaşınca ses gitmiyor.**
Web kodu sesi istiyor (`systemAudio: 'include'`), ama ses tamamen tarayıcının seçicisine bağlı:
Chrome'da **sekme** paylaşımında ses kutusu işaretli gelir; **pencere** ve **tüm ekran**
panellerinde ses kutusu işaretsiz/yok. Kurucunun masaüstü alışkanlığı (pencere seç) web'de sessiz
paylaşım veriyor; uygulama hangi yüzeyin seçildiğini okumuyor, dürüst uyarı vermiyor.
Ek kusurlar: web'de de 8 sn denetleyicisi çalışıyor (doğru sekme sesini bir Voicemeeter girişiyle
değiştirip orijinali kalıcı durduruyor); web'de `restrictOwnAudio` yok (tüm ekran + sistem sesinde
H1'in aynısı); özel aramadaki çağrı çubuğu (CallDock) ses durumu/hata **hiç göstermiyor** — yalnız
sunucu sesli panelinde var.

**Sunucu bu hatalara sebep değil**: medya token'larında kaynak kısıtı yok; ekran sesi her üç
arama türünde serbest. Ama sunucu taramasında ayrı ciddi bulgular çıktı (§3 Dalga 1C).

### 2.2 Arayüz envanteri

| Yüzey | Kod | Not |
| --- | --- | --- |
| Masaüstü + web | **tek renderer** (web, masaüstü renderer'ını shim'le bağlar) | 132 bileşen / 27k LOC + app-ui 21 / 6.6k + ui 12 / 1k. Gerçek token katmanı `globals.css @theme` (1.796 semantik sınıf kullanımı). `packages/app-ui/tokens.css` masaüstü/web'e **hiç import edilmiyor** → tasarım dokümanının entegrasyon adım 1'i yanlış hedefe bakıyor; düzeltilecek. |
| Android | Expo 57 / RN 0.86 | 41 rota, 112 bileşen, ~32k LOC; tamamen token'lı ama eski sıcak palet; animasyon yalnız RN `Animated` (12 dosya), 22 modal sheet yaysız/sürüklemesiz. Reanimated/gesture-handler bağımlılık olarak bildirilmemiş (dolaylı geliyor). |
| iOS | yapılandırma var, build hattı yok | Apple Developer hesabı, EAS iOS build, ekran paylaşımı için Broadcast Upload Extension, APNs, TR izin metinleri gerekiyor. |
| Landing tasarım dili | `apps/landing/src/design/*` | **Referans, taşınabilir kod değil** (React 19/Tailwind 3 vs ürün React 18/Tailwind 4; `motion.*` ürünün `LazyMotion strict`'inde beyaz ekran verir; inline hex, ARIA yok). Reçeteler `packages/ui`'da cva ile yeniden yazılacak. |

### 2.3 Discord tersine mühendislik — fizibilite

Discord masaüstü bir **Electron** kabuğu; arayüz discord.com'dan gelen JS. Ghidra/x64dbg/dnSpy
arayüz için işe yaramaz (native değil). Ayrıca Discord ToS §6 kopyalama/tersine mühendisliği
yasaklıyor; Demli **public AGPL** repo — Discord kodu/CSS'i/ikonu/sesi/animasyon ayarı repoya
girerse DMCA ile repo kapatılabilir. **Öneri — temiz oda:** bir "gözlemci" ajan çalışan Discord'u
izleyip ölçer (zamanlama, yumuşatma, yerleşim, akış), yalnız **davranış tarifi** yazar; kodu başka
bir ajan Demli'nin kendi tasarım diliyle yazar. Kod/asset asla kopyalanmaz. (Appzen'de geçerli
"kaynaktan birebir al" kuralı lisans satın alındığı içindi; Discord'a uygulanmaz.)

### 2.4 Merge engeli — landing dalı

`feat/landing-appzen` dalında (push edilmemiş) `apps/landing/public` altında **91 şablon
dosyası commit'li**: 59 font (Stack Sans dahil), 17 görsel, 3 video, 12 ikon. Repo public;
şablon lisansı yeniden dağıtıma izin vermiyor. Dal dev'e girmeden bu dosyalar **geçmişten
çıkarılmalı** (dal hiç push edilmediği için güvenli).

### 2.5 Sağlık

`pnpm -r typecheck` yeşil (17 proje). `pnpm -r test`: 3.280 geçti / 0 kaldı / **714 atlandı** —
atlananlar DB/Redis entegrasyon testleri ("DATABASE unreachable"); `apps/web`'in tek test dosyası
hiç koşmuyor. Yani "testler yeşil" sunucu ve web için zayıf kanıt → Dalga 6'da düzeltilecek.

## 3. Plan — dalgalar

Her dalga kendi dalında/worktree'sinde, dosya sahipliği ayrık. Her dalga merge'den sonra ve
yayından önce **işi yapmayan bir ajanla hasmane denetim** (CLAUDE.md §22.0).

### Dalga 0 — Hazırlık (½ gün)
- Landing dalının geçmişinden şablon varlıklarını çıkar → yerelde gitignore'lu klasörde dursun;
  canlıya çıkmadan kurucunun üreteceği Demli görselleriyle değiştirilecek. Inter (OFL) lisans
  notuyla kalabilir, Stack Sans tamamen çıkar.
- Landing dalını dev'e al; bu plan dosyasını commit'le; `feature-parity.md`'ye M16 başlığı.

### Dalga 1 — P0 arama/ses hataları (8–12 ajan-günü)

**1A · Masaüstü paylaşım sesi (H1)**
- `ApplicationLoopback` yardımcısını MS örneğinden (MIT) **include | exclude** modlu yeniden derle.
- Paylaşım seçicide tek "Sesi paylaş" düğmesi yerine üç seçenek:
  **Ses yok · Yalnız bu uygulamanın sesi** (pencere süreci, include) **· Sistem sesi — Demli
  hariç** (exclude, Demli'nin kendi süreci). Ekran paylaşımı varsayılanı: sistem sesi (Demli hariç).
- Tüm-cihaz loopback ve karışım-girişi taramasını kaldır; düşüş yolu her zaman exclude modu.
- 8 sn denetleyicisi: kaynağı asla sessizce değiştirme; yalnız "ses henüz gelmiyor" durumunu
  bildir. Mikrofon cihazı hiçbir koşulda film sesi seçilmez. Zehirli localStorage hafızasını göç
  ettir.
- Copy (TR/EN, copy-voice): filmler için önerilen yol artık yankısız yol.
- **Kanıt:** otomatik sayısal test — karşı taraf kanalından bilinen bir test tonu çalınırken
  yayınlanan `screen_share_audio` izinde o ton **ölçülebilir seviyede olmamalı** (her iki modda);
  film sesi ise geçmeli. Kurucu makinesinde (Voicemeeter + SSL) ve düz Windows kurulumunda.

**1B · Web paylaşım sesi (H3)**
- `getDisplayMedia`: `displaySurface: 'browser'` (sekme paneliyle açılır, ses kutusu işaretli),
  `restrictOwnAudio: true`, `windowAudio` ipucu, `surfaceSwitching`, `selfBrowserSurface: 'exclude'`.
- Seçilen yüzeyi oku → yüzeye özel dürüst uyarı ("pencerede ses gelmez — sekmeyi paylaş" / "tüm
  ekranda 'sistem sesini paylaş' kutusunu işaretle").
- Web'de denetleyici yalnız izler, kaynak değiştirmez. Yanlış "loopback" etiketleri düzelir.
- **Kanıt:** Playwright + gerçek Chrome ile sekme/ekran/pencere senaryoları; yayınlanan iz
  var/yok + doğru uyarı metni.

**1C · Üç arama türünde aynı davranış + ortak kusurlar**
- CallDock (özel arama) ve mobil arama ekranı da ses durumu/hata/uyarı gösterir — VoicePanel ile
  aynı bileşen.
- Masaüstü voice-store "mirror" yarışı ("izleyiciler bir şey duymuyor" uyarısını siliyor).
- Kişi başı ses %100 üstü masaüstü/web'de çalışmıyor (arayüz yalan söylüyor) → düzelt ya da
  sınırla.
- Masaüstü AEC: kapatmak yalnız "kulaklık kullanıyorum" onayıyla; canlı değişim gerçekten
  uygulanmıyorsa izi yeniden başlat.
- **Sunucu:** kick/ban/timeout kullanıcıyı LiveKit odasından **atmıyor** (atılan konuşmaya devam
  edebiliyor); başka kullanıcının avatar dosyası silinebiliyor (sahiplik kontrolü yok); özel
  aramadan gruba yükseltmede olay sırası yarışı; bağlantı başına doluluk sayımı; arama
  bildirimlerinde Android kanal/TTL.

**1D · Android yankı (H2)** — native değişiklik, **APK** gerektirir
- Donanım vs yazılım AEC: `setUseHardwareAcousticEchoCanceler` seçeneğini patch ile aç, cihazda
  A/B ölç; arama ekranına hoparlör/ahize/kulaklık geçişi.
- Arama sırasında hiçbir şey ses modunu ezmesin (`expo-audio setAudioModeAsync` kilidi).
- Etkisiz/yalan kontroller kaldırılır ya da "bir sonraki katılımda" diye dürüstleşir.
- **Kanıt:** AVD `demli-debug` + gerçek telefonla masaüstü↔Android görüntülü arama; kurucu
  kabul testi. Bu APK, Dalga 4'ün native bağımlılıklarıyla **aynı APK döngüsünde** çıkar.

### Dalga 2 — Tasarım sistemi temeli, tüm platformlar (5–7 ajan-günü)
- Token'lar: masaüstü/web `globals.css @theme` + mobil `theme.ts` + `tokens.css` **aynı anda**
  (parite testi kilitli). Mercan vurgu, nötr siyah, Onest başlık + Inter gövde (OFL, paketli).
- Kontrast: dokümandaki dim/faint metin tonları WCAG AA'yı geçmiyor → ayarla; masaüstü/web'e
  kontrast testi ekle.
- Hareket sistemi: ortak yay/süre sabitleri; masaüstü framer `LazyMotion` uyumlu `m.*`
  önayarları, mobil Reanimated önayarları; azaltılmış-hareket desteği.
- Atomlar `packages/ui`'da cva ile, erişilebilir (ARIA, klavye, focus-visible): Button,
  IconButton + Tooltip, Avatar (halka/konuşma/durum), Input + doğrulama, Switch, Checkbox, Radio,
  Slider, Select, Menu/ContextMenu, Dialog/Sheet, Toast, Skeleton, Badge, Kbd, Chip'ler.
- **Kapı (founder):** ürünün geliştirme build'inde temel parçalar + bir örnek ekran; onay
  gelmeden ekran taramasına geçilmez.

### Dalga 3 — Masaüstü + web ekran ekran (16–20 ajan-günü)
Sıra: kabuk (grup rayı, kanal kenar çubuğu, üyeler) → sohbet (liste, satır, composer, tepkiler,
ekler) → ses/sahne/özel arama/ekran paylaşım odağı/birlikte izleme → diyaloglar, ayarlar, profil
+ **yeni avatar kırpma editörü** + her yerde avatar gösterimi → açılış/giriş/toast/boş-yükleme-hata
durumları → web dar ekran kabuğu. Her alan: görsel karşılaştırma + mevcut P0 testleri yeşil.

### Dalga 4 — Android ekran ekran (17–26 ajan-günü)
Reanimated + gesture-handler + expo-blur açıkça bildirilir (**tek native APK döngüsü**, 1D ile
birlikte): sürüklenebilir yaylı sheet'ler, geçişler, bulanık yüzeyler. Sıra Dalga 3 ile aynı;
avatar kırpma, profil, arama ekranları dahil. Splash/ikon renkleri de APK'da değişir.

### Dalga 5 — iOS (onaylanırsa, 4–7 ajan-günü + Apple)
Apple Developer hesabı, EAS iOS profili, Broadcast Upload Extension (ekran paylaşımı), APNs,
TR izin metinleri, AASA dosyası, iPad yönlendirme kuralı.

### Dalga 6 — Kalite ve kapanış (sürekli)
- Atlanan 714 entegrasyon testini docker DB/Redis ile koştur; `apps/web` testini çalıştır.
- Dev dosyaları böl (ör. `gateway.ts` 2.406 LOC, büyük paylaşım/arama dosyaları).
- Her dalgada: typecheck · lint · test · build · i18n TR/EN parite · slop-check (ayrı ajan) ·
  hasmane denetim · `feature-parity.md` güncel.

### Discord gözlemi (paralel, isteğe bağlı, 6–8 gün)
Gözlemci ajan çalışan Discord'da 12–15 yüzeyi ölçer (avatar yükleme/kırpma, profil kartı, kanal
geçişi, mesaj hover/eylemleri, bağlam menüsü, modal/ayarlar, ses kutucukları ve konuşma halkası,
arama arayüzü, ekran paylaşım odağı, toast, mobil çekmece/sheet) → davranış tarifi (kod yok).
Uygulayıcı ajanlar Dalga 3/4'te bu tarifi Demli diliyle uygular.

## 4. Varılacak nokta

- Sistem sesiyle paylaşımda karşı taraf **hiçbir türde** (özel/kanal/grup) kendi sesini duymaz;
  "uygulama sesi" ve "sistem sesi (Demli hariç)" ayrı seçenektir.
- Web'den paylaşımda ses ya gider ya da kullanıcı neden gitmediğini ve ne yapacağını görür.
- Android'de hoparlörde yankı ölçülebilir şekilde azalır; kontroller dürüsttür.
- Masaüstü, web, Android (ve onaylanırsa iOS) aynı tasarım dili, aynı hareket hissi; her ekran,
  her durum (boş/yükleniyor/hata) yeni sistemde.

## 5. Başarı ölçütleri

| Alan | Kanıt |
| --- | --- |
| H1 | Test tonu ölçümü: karşı taraf sesi paylaşım izinde yok, film sesi var (iki mod, iki makine) |
| H3 | Chrome'da sekme/ekran/pencere senaryoları: iz var/yok + doğru uyarı |
| H2 | AVD + gerçek telefon görüntülü arama; kurucu kabul testi |
| Parite | Aynı senaryolar özel arama, sesli kanal, grup aramasında |
| Arayüz | Envanterdeki her yüzey işaretli; ekran görüntüsü karşılaştırma; kontrast testi; slop-check |
| Genel | typecheck · lint · test (entegrasyon dahil) · build yeşil; i18n parite; hasmane denetim temiz |

## 6. Takvim (dürüst tahmin)

Toplam ≈ **55–75 ajan-günü**. 3–4 paralel ajanla takvimde ≈ **4–6 hafta**. Kurucu gereken
kapılar: Dalga 1 cihaz testi, Dalga 2 görsel onayı, her platform dalgası sonunda deneme, her
yayın adımı.

## 7. Founder kararları

1. Sıra: hatalar önce (P0) + paralelde tasarım temeli — mı, yoksa önce tüm arayüz mü?
2. Discord: temiz oda gözlem yöntemi onayı.
3. iOS: bu programa dahil mi? Apple Developer hesabı var mı?
4. Landing şablon varlıklarının geçmişten çıkarılması onayı.

---

## Ek — inceleme bulguları (otomatik özet, İngilizce)

Önem dağılımı: critical 3 · high 17 · medium 36 · low 19 · info 11. Tam kayıt:
iş akışı `wf_addb26c3-6f4` journal'ı.

### call-path-parity
- **[critical] Echo: desktop endpoint loopback captures Demli's own remote-voice playback** — Screen (not window) shares with system audio arm Electron `audio: 'loopback'`. This is WASAPI loopback of the whole render endpoint, so it includes the <audio> elements livekit attaches for every remote mic. The other party's voice is re-published as screen_share_audio and they hear themselves, whic… _(apps/desktop/src/main/capture.ts:198-200 callback({ video: source, audio: 'loopback' }))_
- **[high] Echo / doubled voice: system-mix-input tier (Voicemeeter Out / Stereo Mix / CABLE Output) chosen automatically** — In the first scan, the loopback signal probe and the mix-input probe run together for 1.2s. At t=0 the film is normally not playing yet, so loopback looks silent, while a mix input carrying someone talking passes the 0.02 threshold and wins. Candidates are sorted 'default' first, which the code itse… _(apps/desktop/src/renderer/src/lib/screen-share.ts:326 MIX_INPUT_PATTERN = /voicemeeter out/cable output/stereo)_
- **[high] Film-audio supervisor hot-swaps away from correct sources; not platform-gated (runs on web)** — superviseFilmAudio rescans system-mix inputs every 8s, up to 6 times, while the published track is silent. It swaps to any input that has signal. The trigger includes a per-process capture that is merely waiting for the user to press play, which the code itself calls the 'definitionally-correct sour… _(apps/desktop/src/renderer/src/lib/screen-share.ts:1025-1028 RESCAN_DELAY_MS=8000, MAX_RESCANS=6)_
- **[high] DM-call surfaces never show voice errors or film-audio status (desktop + web + mobile)** — Desktop and web: the server-voice VoicePanel renders localizeVoiceError plus the film-audio live/searching/failed warning. CallDock, shown on the DM conversation during a 1-1 call, renders none of these. So a DM-call sharer whose stream is silent (web box unticked, window share, loopback dead), or w… _(apps/desktop/src/renderer/src/components/VoicePanel.tsx:215-222 voiceError alert; 234-290 film-audio status + )_
- **[high] Per-user voice / per-share volume boost above 100% is dead on desktop and web (UI lies)** — The range is 0..2. The web adapter does not enable webAudioMix (livekit default false), so RemoteAudioTrack.setVolume does `el.volume = v`, which throws for v > 1. The engine swallows the throw, leaves playback at the previous level, and still shows the stored level in the participant row. Mobile wo… _(packages/media/src/participant-volume.ts:21-23 MIN 0 / MAX 2)_
- **[medium] Web screen-share audio depends on a browser checkbox; picker is a single English placeholder** — Web acquisition is a single getDisplayMedia call. Audio arrives only if the user ticks Chrome's 'share audio' box and picks a tab or the entire screen; a window gives video only. Firefox and Safari give video only. The in-app picker shows one synthetic card with the hard-coded English label 'Screen … _(apps/desktop/src/renderer/src/lib/screen-share.ts:877-908 acquireWebScreenShare)_
- **[medium] Deafen badge attribute probably rejected by LiveKit (missing grant)** — Deafen is broadcast with localParticipant.setAttributes. Both token mints grant only roomJoin, canPublish and canSubscribe. The SDK documents that a participant is not allowed to update its own metadata by default (canUpdateOwnMetadata). The engine swallows the failure, so peers would never see the … _(apps/api/src/modules/media/index.ts:146-151 addGrant without canUpdateOwnMetadata)_
- **[medium] Android AEC / echo-toggle effectiveness** — Mobile has no in-place constraint path (no applyMicCaptureConstraints), so an AEC/NS toggle goes through restartAudioTrack and a new getUserMedia. RN-webrtc maps the toggle to legacy goog* MediaConstraints on a new AudioSource. The ADM is the default JavaAudioDeviceModule.builder(). Whether HW AEC b… _(apps/mobile/src/media/livekit-room.ts:568-573 restartAudioTrack only; no applyMicCaptureConstraints/applyNoise)_
- **[medium] Mobile ignores channel-configured mic bitrate** — The desktop store applies the channel bitrate floor before join (setAudioBitrateKbps). Mobile can edit the channel bitrate but never calls setAudioBitrateKbps, so a 128 kbps channel publishes at the user tier (48 kbps standard) on the phone. _(apps/desktop/src/renderer/src/stores/voice-store.ts:405 engine.setAudioBitrateKbps(options?.audioBitrateKbps ?)_
- **[medium] Duplicated / drifting DM-call glue** — client-core ships createCallEngineAdapter and watchCallMedia explicitly so the platforms cannot drift. Mobile uses them; desktop hand-rolls a copy (callEngine + waitForVoiceStatus) and its own subscription (it does use the shared decideCallMediaOutcome). Mobile does not pass getRemoteParticipantCoun… _(apps/desktop/src/renderer/src/stores/voice-store.ts:274-339 hand-rolled callEngine)_
- **[medium] Mobile has no voice-join consequences guard** — Desktop asks before a join would stop a live share or leave a call. Mobile VoiceRoomScreen auto-joins on mount, and the store leaves the current room first: a live DM call or screen share is torn down silently. How the call FSM ends up afterwards (report_failure vs a phantom active call, depending o… _(apps/desktop/src/renderer/src/stores/voice-join-decision.ts:44-60 decideVoiceJoin)_
- **[low] Engine error typing: wrong device in user-facing copy** — Three engine failures produce the wrong message: (1) a camera-device switch failure reads 'selected audio device unavailable'; (2) a screen publish failure lacks device:'screen' and gets the same audio-device copy; (3) an output-device failure is labelled microphone. _(packages/media/src/engine.ts:2694 { kind:'device_unavailable', deviceId } (no device))_
- **[low] Film-audio track death mid-share not surfaced** — The engine watches only the video track's ended event. If the film-audio source dies mid-share (process helper exits, mix device unplugged), the audio track is stopped locally (no ended event), but screenShareHasAudio stays true. The supervisor's watcher just stops, so the UI keeps saying searching/… _(packages/media/src/engine.ts:2847-2851 only video 'ended' listener)_
- **[low] Maintainability: duplicated store / adapter logic** — Desktop and mobile voice stores duplicate join, leave, sessionReplaced, voiceDisconnected, the toggles, applyMediaSettings, syncBandwidthPressure, isActive and reportVoiceError. The state mirror has drifted: mobile does not mirror selfMonitoring or screenShareAudioLive. Both adapters duplicate the l… _(apps/desktop/src/renderer/src/stores/voice-store.ts:249-255, 361-379, 389-481, 624-632, 646-700)_

### ui-inventory-desktop-web
- **[high] Token seam / integration premise** — The live token layer for BOTH desktop and web is globals.css @theme (26 colours plus radius, motion and font tokens). packages/app-ui/src/tokens.css is imported by no desktop or web stylesheet. Its header and the app-ui AppShell comment still describe a web Tailwind v3 config that no longer exists. … _(apps/web/src/styles/desktop-shell.css:13 @import "../../../desktop/src/renderer/src/styles/globals.css")_
- **[high] Landing reference is not portable code** — The design atoms and molecules are demo-grade: hardcoded hex via inline style, hover driven by onMouseEnter/useState, no ARIA/role/focus-visible (the only a11y attribute is one aria-hidden), hardcoded Turkish placeholders, static demo data (KanalListesi(), DosyaKarti() take no props), and mask-SVG i… _(apps/landing/package.json (react 19.2.3, tailwindcss ^3.4.14) vs apps/web/package.json (react ^18.3.1, tailwin)_
- **[medium] Gate that is green but not watching what it protects** — The mobile palette parity test compares RN theme.ts against tokens.css, not against globals.css. No test ties globals.css to tokens.css, so the desktop/web palette can drift while every test stays green. The two files match today only by hand-copy. _(apps/mobile/src/theme/__tests__/design-tokens.test.ts:26-47 (reads packages/app-ui/src/tokens.css only))_
- **[medium] Design doc gaps that block a clean token swap** — (a) The status is still pending founder approval and says 'no integration before approval'. (b) Its product mapping covers only 4 tokens ('--tc-rail→bg-page … vb.'); there is no target for sidebar, overlay, selected, hover, on-accent, danger-surface, idle, dnd or offline. The current ramp has 6 surf… _(docs/design-system/demli-design-system.md:4 'Durum: FOUNDER ONAYI BEKLİYOR', :10, :208)_
- **[medium] Contrast of the new text ramp (computed)** — WCAG ratios computed from the doc values: text-dim #737373 is 4.43:1 on #000 and 4.10:1 on #0d0d0d, below AA 4.5 for body text. text-faint #404040 is about 2.0:1 on #000 and fails even the 3:1 meta bar the mobile test enforces for fg-faint. Today fg-faint has 287 uses (timestamps, meta). Danger as a… _(docs/design-system/demli-design-system.md:39-43 (text ramp), :64 (danger #ff6fb5))_
- **[medium] Hardcoded colours outside the token layer (hand-edit list)** — These warm 'Demli Voice v2' literals and stale literals will NOT follow a token swap. They would leave warm flashes and warm gradients on a neutral-black UI. The role-colour palette (12) and the Google logo fills (4) are legitimate. The #95a5a6 role fallback is duplicated in 6 places. _(apps/desktop/src/main/index.ts:109 backgroundColor: "#0c0304" (window flash colour))_
- **[medium] Borderless / no-shadow language vs current UI** — The design rule is 'no borders, depth = surface tone + blur, no outer shadow'. The current UI uses 511 border utilities in 103 files, plus shadow-lg ×14, shadow-2xl ×12, shadow-elevated ×8 and 8 arbitrary shadows. Some borders are functional (focus, drop targets, video tile glow), so this needs a pe… _(grep '\bborder(-[trblxy])?' -> 511 uses, 103 files)_
- **[medium] Framer feature set limits Discord-like motion** — The `domAnimation` bundle used at the root excludes layout and drag animations, so `layoutId` shared-element indicators (sliding active pill on the rail, settings nav highlight, tab underline) silently will not animate. Each such place needs domMax or a CSS transform indicator. Framer-motion 11.18.2… _(node_modules/framer-motion/dist/es/render/dom/features-animation.mjs (domAnimation = animations + gestureAnima)_
- **[medium] Primitive leverage vs bypass** — High-leverage single files: DialogContent (29 uses in 27 files) and UserAvatar (36 uses in 33 files). The UserAvatar speaking ring is green `ring-online`; the design wants a 2px base ring, an accent speaking ring and a 30% presence dot. Input has 30 uses. Button has 175 uses in 65 files: secondary 6… _(packages/ui/src/components/button.tsx:18-24 (variants))_
- **[medium] Avatar upload / display gap (founder ask)** — Avatar and banner upload exist (FileReader to base64 draft, uploaded on Save, 2MB/5MB caps) but there is no crop/zoom/position editor (no match for crop/zoom). Discord-parity avatar upload needs a new crop dialog. The avatar lightbox and profile card exist. _(apps/desktop/src/renderer/src/components/ProfileSettings.tsx:90-118 (ImageDraft, fileToUpload), :249-270 (avat)_
- **[medium] Performance (§27) constraints for animation** — Only MessageList is virtualized (react-virtual; rows are positioned with transform translateY). New-row 'arrival' is a CSS transform + blur keyframe. Adding framer transform or layout motion to message rows would conflict with the virtualizer's transforms. Non-virtual lists rely on content-visibilit… _(packages/app-ui/src/components/MessageList.tsx:187-210 (useVirtualizer, overscan 12), :389-392 (measureElement)_
- **[low] Hover / motion ramp mismatch** — The product's base hover transition is 120ms ('instant'); the design wants a 200ms tone-only hover. The shared `pressable` preset applies whileHover scale 1.04, which breaks 'hover = tone only'. The design's positional spring {damping 60, stiffness 500, mass 1} is overdamped (computed damping ratio … _(globals.css:369 --motion-duration-instant:120ms; :417-430 base transition layer)_
- **[low] Radius / typography scale** — The product radius scale is one knob giving 6/8/10/12, plus 28 arbitrary rounded-[Npx] uses (13px ×11, 20px ×5 …). The design uses 8/10/12/16/18/24/32/44/50 with dialog 24, CTA 18 and input 12. Display font is used in only 11 places; there are 45 arbitrary text-[13px] uses (the design specifies a 13… _(globals.css:238-241, :365 (--radius:10px))_
- **[low] Toasts and notices are fragmented** — There are six bespoke toast/overlay components, each with its own framer AnimatePresence and positioning, and no shared Toast primitive. A redesign would otherwise restyle all six separately; consolidate them first. _(apps/desktop/src/renderer/src/components/{InAppNotificationToast,ImageActionToast,BlockedSendToast,OutboxChann)_
- **[low] i18n** — There are 1,399 t( calls in components, and a heuristic scan found no hardcoded JSX text. New empty/error/onboarding copy from the redesign needs TR+EN keys and must pass locale-parity.test.ts and the copy-voice gate. _(grep '\bt("' in desktop + app-ui components -> 1399)_
- **[low] Font license notices (unverified)** — OFL-InstrumentSans.txt and OFL-SpaceGrotesk.txt sit next to the woff2 files, but no build script references them and no OFL file appears in the existing apps/desktop/out or apps/web/dist builds (the woff2 files do). Unverified whether embedded woff2 metadata satisfies OFL. Adding Onest (and Inter) r… _(apps/desktop/src/renderer/src/assets/fonts/OFL-*.txt)_

### ui-inventory-mobile
- **[high] iOS readiness — config** — ios block: bundleIdentifier app.demli.mobile, supportsTablet:true while orientation is portrait (iPad multitasking/App Store orientation rules need a check, unverified), associatedDomains applinks:app.getdemli.com (the AASA file is not uploaded yet per deploy.md), and English-only NSMicrophone/NSCam… _(apps/mobile/app.json:70-85 (ios block), :9 orientation portrait, :122-128 (expo-notifications, no mode), :131-)_
- **[high] iOS screen share (LiveKit broadcast extension)** — JS calls mediaDevices.getDisplayMedia() and the header claims iOS presents the broadcast picker. In the installed @livekit/react-native-webrtc, iOS screen capture reads frames only over a socket from a Broadcast Upload Extension. startCapture returns early when the Info.plist key RTCAppGroupIdentifi… _(apps/mobile/src/media/screen-capture.ts:18-26 (claims iOS broadcast picker; video-only), :67-104)_
- **[medium] Koyu Masa token mapping (what changes)** — The doc maps rail→bg-page #000, app→bg-base #0d0d0d, surface→#171717, raised→#262626, and the accent becomes #ff8464 with strong #ffa48c / deep #e8624a / soft rgba(255,132,100,.12). Danger becomes #ff6fb5 and success/online #22c55e. Text ramp is #fff / #e5e5e5 / #a3a3a3 / #737373 / #404040. The rema… _(docs/design-system/demli-design-system.md:20-33 (surfaces + mapping), :37-43 (text), :47-54 (accent), :61-66 ()_
- **[medium] Animation libraries** — Declared deps contain no reanimated, moti, gesture-handler, skia, expo-blur or expo-linear-gradient. Present and usable today without a native build: RN core Animated (12 files), PanResponder (4 files), react-native-svg 15.15.4 (gradients exist in 2 files), expo-haptics (16 users) and RN 0.86 boxSha… _(apps/mobile/package.json:23-68 (dependency list, no reanimated/gesture-handler/worklets))_
- **[medium] Hardcoded colours / borders / type literals** — Outside src/theme and tests: 58 quoted hex literals in 20 files (top values #000 ×15, #fff ×14, #ffffff ×10, plus old accent #ff8c1a/#ffb65c) and 61 quoted rgba literals in 36 files (scrims, video overlays). roles.ts has 13 Discord-style role colours; that is data, so keep it. Old-accent literals si… _(grep quoted hex excl theme/tests = 58 in 20 files (src/lib/roles.ts 13, app/(app)/user/[userId].tsx 8 e.g. :14)_
- **[medium] Avatar upload / display** — Upload: expo-image-picker library pick with NO crop (no allowsEditing/aspect), then re-encode via expo-image-manipulator with EXIF strip, downscale to ≤2MB, base64 upload as a draft until Save. Banner allows animated GIF ≤5MB. Display: Avatar uses RN core Image (no cache or crossfade) over a determi… _(apps/mobile/src/lib/profile-image.ts:149-191 (launchImageLibraryAsync without allowsEditing/aspect), :69-70 ca)_
- **[medium] iOS readiness — native modules / plugins** — Local plugins are all Android-only: with-livekit-setup (withMainApplication, Kotlin), with-foreground-service (manifest), with-media-projection-notification (dangerous-mod android), with-short-cxx-dir (gradle). LiveKit iOS setup is handled by @livekit/react-native-expo-plugin's LiveKitExpoAppDelegat… _(apps/mobile/plugins/with-livekit-setup.js (withMainApplication, throws if not kt))_
- **[medium] iOS audio + sounds + push** — Room audio: AudioSession.configureAudio passes only the `android` key, so there is no iOS category/defaultOutput (speaker vs earpiece for video calls). iOS behaviour is unverified; LiveKit's iOS audio-management hooks are unused. UI cues are .ogg, which the code itself says won't decode on iOS, and … _(apps/mobile/src/media/livekit-room.ts:467-470 (configureAudio android only))_
- **[low] Fonts** — Six static TTFs (Instrument Sans 400/500/600, Space Grotesk 500/600/700), subset to latin + latin-ext for Turkish glyphs, are loaded via expo-font with a 2.5 s timeout fallback. The code states this is OTA-safe because expo-font is already part of the expo package. ui/Text.tsx maps fontWeight to a p… _(apps/mobile/src/theme/fonts.ts:13-16 (OTA-safe), :32-41 (FONT_ASSETS), :51 (2500ms timeout), :22-26 (key = Pos)_
- **[low] Current motion surface** — The only shared motion helpers are useReducedMotion and useArrivalStyle (opacity + scale 0.97, timing 500ms). Only MessageBubble uses them. The 22 files using <Modal> rely on animationType fade (12) or slide (8): no springs, and only ParticipantVolumeSheet has drag-to-dismiss. No LayoutAnimation any… _(apps/mobile/src/theme/motion.ts:26-42 (useReducedMotion), :54-92 (useArrivalStyle))_
- **[low] Navigation chrome** — Root Stack and (app) Stack are native stack headers themed with colors.surface + display.semibold and headerShadowVisible:false. Nested navigators re-declare styles because they do not inherit. 17 screens use presentation:'modal'. Tabs are JS expo-router Tabs (Home/Friends/You) with a lucide icon an… _(apps/mobile/app/_layout.tsx:202-224)_

### code-health-client
- **[critical] screen-share film audio / echo (desktop + web)** — Whole-system film-audio sources include Demli's own output, so remote participants hear themselves. Screen (non-window) shares use Electron endpoint loopback. The fallback 'mix input' devices are by definition the full system mix. Demli plays every remote voice through <audio> elements in the same r… _(apps/desktop/src/main/capture.ts:198-200 (callback({ video: source, audio: "loopback" })))_
- **[critical] screen-share film audio source selection (desktop + web)** — The mix-input scan explicitly ranks the system DEFAULT input first. Its own comment says this is 'what VoIP apps hear', i.e. the MIC bus on a Voicemeeter setup. It is opened with echoCancellation/noiseSuppression/AGC off. Scenario A: at share start (screen source) the film is not playing yet, so the… _(apps/desktop/src/renderer/src/lib/screen-share.ts:334-338 (sort: deviceId === "default" first))_
- **[high] web screen-share audio** — Web takes a correct single-call path (getDisplayMedia with audio + systemAudio:'include'). But the voice store then starts superviseFilmAudio unconditionally, and its rescan calls the desktop-only captureSystemMixInput through navigator.mediaDevices. Mic permission is already granted in a call, so d… _(apps/desktop/src/renderer/src/lib/screen-share.ts:877-908 (acquireWebScreenShare, filmAudioSource 'loopback'))_
- **[high] desktop voice-store mirror race** — engine.subscribe runs on EVERY engine notify. Whenever s.screenShareEnabled is false it clears the self-preview track, stops the supervisor and resets screenShareSystemAudioFailed / screenShareAudioSource. But during startScreenShare, onAudioReconciled sets those flags and the preview track BEFORE t… _(apps/desktop/src/renderer/src/stores/voice-store.ts:503-506 (flags set in onAudioReconciled))_
- **[high] DM call UI (CallDock) parity** — The DM-call dock reads only status, cameraEnabled and screenShareEnabled. It never renders screenShareAudioStatus, screenShareAudioSource or screenShareSystemAudioFailed. Those are consumed only by VoicePanel, which is mounted only in the server ChannelSidebar, and AppShell renders HomeSidebar (Call… _(apps/desktop/src/renderer/src/components/CallDock.tsx:96-101)_
- **[medium] Android echo (remote test phone)** — The founder heard his own voice echoing even with the stream off. That is consistent with the phone feeding its loudspeaker back into its mic. Two user-reachable code paths disable AEC. First, the mobile UI exposes an echo-cancellation toggle, and effectiveAudioProcessing returns settings.processing… _(packages/media/src/audio-settings.ts:218-234 (comment says AEC absolute; code returns settings.processing))_
- **[medium] media engine: replaceScreenShareAudio race** — After `await unpublishTrack(previous)` the function publishes the new track without re-checking localScreenShare/status. If Stop (or the OS stop) lands during that await, the new ScreenShareAudio is still published. The post-publish check then only stopTrack()s it and never unpublishes it. MediaStre… _(packages/media/src/engine.ts:2887-2913 (unpublish await, then publish with no guard))_
- **[medium] desktop mic DSP live-apply** — applyMicCaptureConstraints reports success as soon as MediaStreamTrack.applyConstraints resolves, and the engine then skips the restart path. It never checks track.getSettings() for the requested echoCancellation/noiseSuppression/autoGainControl. If Chromium resolves audio-DSP applyConstraints witho… _(packages/media/src/livekit.ts:470-491)_
- **[medium] film-audio probe robustness** — probeAudioSignal returns TRUE on ANY exception ('assume signal'). captureSystemMixInput probes every matching device concurrently, opening one getUserMedia plus one AudioContext each; Voicemeeter exposes 8+ strips. Any AudioContext/graph failure therefore crowns a device as audible. The default/mic … _(apps/desktop/src/renderer/src/lib/screen-share.ts:1001-1003)_
- **[medium] test gate** — apps/web has a test file (it guards the retired-domain regression) but no `test` script and no vitest dependency. `pnpm -r --if-present test` silently skips it (0 occurrences in the run log). Separately, 714 integration tests skip with exit 0 whenever DB/Redis are down, so a green `pnpm test` says n… _(apps/web/package.json:8-13 (scripts: dev/build/preview/typecheck only))_
- **[medium] product gap: system vs window audio** — The founder wants system audio and window audio as separate choices. The picker exposes ONE toggle. The audio source is implicitly decided by the surface: window gives process audio, screen gives endpoint loopback including Demli itself, and either can fall back to mix inputs. There is no 'window/ap… _(apps/desktop/src/renderer/src/components/SourcePicker.tsx:142-145, 218-225, 278-283)_
- **[low] desktop realtime liveness** — The desktop WS client reconnects only on close. There is no `online`/resume listener and no client-side liveness check. Mobile does reconnect on AppState. After sleep or a Wi-Fi change, a half-open socket could keep the desktop 'online' while missing call invites until TCP times out. Unverified in p… _(packages/client-core/src/realtime-client.ts:198-230)_
- **[low] mobile screen-share audio parity** — Mobile can now host a screen share (toggleScreenShare), but acquisition is video-only, so a phone-hosted share never carries audio. sound-manager still documents that 'mobile cannot publish a screen share', which is stale. _(apps/mobile/src/stores/voice-store.ts:348-360)_
- **[low] duplication desktop vs mobile** — Large parallel 'mirror' copies drift independently. Unique non-trivial lines shared (desktop count as denominator): realtime/connection.ts 436/980, chat-store.ts 186/456, chat-queries.ts 146/408, voice-store.ts 141/439. embed-fold, pin-fold, outbox, voice-occupancy-store and watch-party-store are ne… _(apps/mobile/src/realtime/connection.ts:1-15 ('Mobile mirror of the desktop renderer's src/realtime/connection.)_

### code-health-server
- **[high] moderation / LiveKit media teardown** — Kick and ban only publish member.left / member.kicked over realtime. They never call removeParticipant. The gateway's 'voice teardown' on member.left is bookkeeping only: leaveVoice() edits the in-memory occupancy map. The kicked user's SFU session keeps running, and their token stays valid for 6h, … _(apps/api/src/modules/moderation/index.ts:158-168 (kick: removeMember + publishMemberRemoved only))_
- **[high] avatars / banners storage ownership** — PATCH /users/me accepts any absolute http(s) URL for avatarUrl and bannerUrl (mediaUrlField), including URLs inside our own public bucket that belong to someone else. The next upload's 'purge previous object' step trusts the stored URL: ownedObjectPath only checks the bucket prefix, not that the key… _(apps/api/src/modules/users/index.ts:93,96 (avatarUrl/bannerUrl: mediaUrlField — arbitrary https))_
- **[medium] dm-call upgrade -> gateway event ordering** — The API publishes member.joined x3 and then call.upgraded, and dm-calls/index.ts:1014-1016 claims 'Wave 3 relies on order'. The gateway does not keep that order. Group mutations run fire-and-forget, and handleMemberJoined awaits two DB queries (listForGroup, visibleChannelIdsForUser) before it adds … _(apps/api/src/modules/dm-calls/index.ts:1014-1033 (member.joined then call.upgraded))_
- **[medium] voice occupancy resync for upgraded group calls** — The LiveKit occupancy reader asks for rooms by channel id (listRooms(voiceChannelIds)). An upgraded group's voice channel lives in room dmcall:<id> (channels.livekit_room), so it never appears in the result. The gateway's voice.resync (sent on every connect) and GET /voice/occupancy (pulled on app f… _(apps/api/src/modules/voice/occupancy.ts:25-31 (documented gap))_
- **[medium] gateway voice occupancy: per-user set vs per-connection join** — voiceOccupants is a Map<channelId, Set<userId>>, but join and leave are tracked per connection. leaveVoice() removes the userId from the set without checking whether another connection of the same user is still in that channel, then broadcasts voice.participant_left. Scenario A (network blip): the c… _(apps/realtime/src/gateway.ts:722-727 (removeVoiceOccupant deletes userId unconditionally))_
- **[medium] call push payload (notifications)** — Every Expo push is built with no channelId and no ttl/expiration. The mobile app posts its notifications on 'messages-v2', deletes the legacy 'default' channel on startup, and says remote push routing is 'NOT verified'. Expo sends a push with no channelId to the 'default' channel and recreates it. A… _(packages/notifications/src/push.ts:97-110 (no channelId, no ttl))_
- **[medium] call ring retraction across devices** — The 'Missed call' push that replaces the ring (same collapseKey) is only sent when the caller cancels. When the callee accepts or declines on desktop, or the sweeper, the disconnect reaper or an inline reap closes the ring, no retraction push goes out. The callee's backgrounded phone keeps showing '… _(apps/api/src/modules/dm-calls/index.ts:893-913 (retraction only in cancel; note at 897-899))_
- **[medium] avatar URL origin vs CSP (cross-platform avatar display + privacy)** — avatarUrl and bannerUrl can point at any https host. The PATCH comment itself names IP logging as the threat, but the scheme-only check does not stop https://attacker/pixel.png. Mobile has no CSP, so viewers' IPs leak there. The web CSP and the pinned desktop CSP only allow the storage origin in img… _(apps/api/src/modules/users/index.ts:76-83,93 (comment cites IP-leak; only http(s) enforced))_
- **[low] dm-calls inline ring reaps** — POST /dm-calls and GET /dm-calls/active close expired rings to 'missed' inline, but send no call.ended and write no 'missed call' DM history line. The sweeper does both for the same transition. When the inline reap beats the 60s sweeper, the missed call never appears in the DM history and the callee… _(apps/api/src/modules/dm-calls/index.ts:514-516)_
- **[low] dm-call upgrade concurrency** — Both originals press 'add person' at the same time. The second request gets past the API pre-check (status === active), then loses the FOR UPDATE lock, and upgradeDmToGroup throws a plain Error('not live'). The handler does not catch it, so the user sees a generic 500 instead of a 409 'already upgra… _(packages/db/src/repositories/call-upgrade.ts:52-61)_
- **[low] single-session registry** — recordAndEvict does a non-atomic GET then SET, fire-and-forget. Two fast joins can interleave and leave the key pointing at the wrong room. The key is never cleared on leave, so every later join from that user publishes voice.session_replaced for a stale room; harmless only thanks to the client's ro… _(apps/api/src/modules/media/voice-session.ts:88-92)_
- **[low] occupancy mute flags** — Gateway join/leave deltas and the auth.succeeded snapshot hard-code muted:false for every occupant. Sidebar mute icons are wrong until the next LiveKit-backed resync or focus pull. _(apps/realtime/src/gateway.ts:746)_
- **[low] push copy localization** — Call push strings are hard-coded English in a Turkish-first product: 'is calling you.', 'Missed call', 'added you to a call.' _(apps/api/src/modules/dm-calls/index.ts:604-605)_
