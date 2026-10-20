# Platform Eşitlik Matrisi (Feature Parity)

> **Kural (Director-zorunlu):** Kullanıcıya görünen HER özellik bu matriste yer alır.
> Bir özellik tek platforma gelecekse bu BİLİNÇLİ bir karar olmalı, satırında
> takip görevi numarasıyla görünmeli ve founder'a raporlanmalıdır. Bir dalga
> merge edilirken bu dosya güncellenmeden `/ship` ve release-check GEÇMEZ.
> UI'da işlevsiz buton/giriş SERGİLENMEZ — ya çalışır ya görünmez (CLAUDE.md §35
> "sahte demo yok").

Durumlar: ✅ çalışıyor · 🚧 yapım aşamasında · ⛔ yok (görev no zorunlu) · ◑ kısmi · — anlamsız

> **Nasıl okunur (2026-07-30 doğruluk denetiminden sonra):** aşağıdaki ilk tablo YAŞAYAN
> matristir — bugünkü durumu gösterir. Onun altındaki tarihli bölümler dalga KAYITLARIdır:
> o dalganın ne getirdiğini anlatırlar, ama durum sütunları yine de **bugünkü** koda göre
> tutulur. Bir dalga kaydı "o gün eksikti" demek istiyorsa bunu düz yazıyla söyler, ⛔ ile
> değil. Sebep: 2026-07-30'da bir ajan bayat bir ⛔ bloğuna bakıp inmiş bir özelliği
> yapılmamış sandı. **Parite AÇIĞI (dürüst ⛔) sorun değil; YANLIŞ BEYAN sorundur.**
>
> Denetimde bu dosyada 40'tan fazla yanlış durum hücresi/cümlesi düzeltildi (mobil ekran
> paylaşımı yayınlama, arka planda konuşma, mobil push, mobil Watch Party bloğunun tamamı,
> M18 masaüstü+mobil arayüz bloğu, M20 sesli-kanal sohbeti bloğu, landing satırları).
> Kanıtlanamayan hiçbir hücre ✅ yapılmadı.

| Özellik | Masaüstü | Mobil | Not / Görev |
|---|---|---|---|
| Metin sohbet + typing + presence | ✅ | ✅ | |
| Presence platform göstergesi (mobil=telefon ikonu) | ✅ | ✅ | masaüstü baskın kural: iki cihaz da bağlıysa masaüstü kazanır |
| Sesli kanal (konuşma/dinleme) | ✅ | ✅ | mobil crash fix (LiveKit native setup) — emülatörde doğrulandı, APK 1.2.0 |
| Konuşma göstergesi — kendi halkan ANLIK (lokal ölçüm) | ✅ | ⛔ | #45 (M12, RN audio-level adaptörü; mobil sunucu yolundan ~0.5s ile çalışmaya devam eder) |
| Ekran paylaşımı — YAYINLAMA | ✅ | ✅ | #45 KAPANDI (native APK dalgası). Mobil: `apps/mobile/src/media/screen-capture.ts` → `mediaDevices.getDisplayMedia()` MediaProjection onay diyaloğunu açar, `MediaProjectionService` foreground service'ini `LiveKitReactNative.setup()` başlatır (`plugins/with-livekit-setup.js`, bildirim rebrand'ı `plugins/with-media-projection-notification.js`); izin `app.json:57` `FOREGROUND_SERVICE_MEDIA_PROJECTION`. Yayınlamayı ortak motor sürüyor (`engine.startScreenShare(acquire, { quality })` — `stores/voice-store.ts:347`), UI girişleri `VoiceRoomScreen.tsx:650` + `call/InCallView.tsx:478`. SİSTEM SESİ dahil DEĞİL (ayrı satır). **Founder bulgusu (2026-07-30): "açtığı yayın bayağı grenleniyor, bulanık, net değil — 1080p 30hz seçmişti." Yayın tarafı düzeltildi (2026-07-31).** Kök neden ENCODER bütçesinin çarçur edilmesiydi: mobil `RoomOptions`'ta `publishDefaults` HİÇ yoktu, dolayısıyla livekit'in varsayılan `simulcast: true`'su ekran track'ine de uygulanıyor ve `computeDefaultScreenShareSimulcastPresets` yarı-çözünürlüklü bir KOPYA katman ekliyordu. Founder'ın 1080p30'unda (tavan 4,5 Mbps) 1080×2400 panelde gerçekte istenen: `q` 540×1200 @ 1,125 Mbps + `h` 1080×2400 @ 4,5 Mbps = **5,625 Mbps**, yani tier'ın kendi tavanının **%25 üstü**, üstelik kimsenin izlemediği bir katman için — ve kare başına ~%25 fazla encoder yükü (3,24 MP yerine 2,59 MP olması gerekirken). Sıkışmada GCC önce taban katmanı besleyip üst katmanı aç bırakıyor; CPU sıkışmasında da motorun `maintain-framerate` tercihi ÇÖZÜNÜRLÜK feda ediyor — "akıcı ama grenli" tam olarak bu ikisinin imzası. Düzeltme tek anahtar: `publishDefaults: { screenShareSimulcastLayers: [] }` (`livekit-room.ts`), tek encoding + tam tier bitrate. livekit'in KENDİ birim testi bu davranışı pinliyor ("returns one encoding if an empty array is provided for custom screen share layers") ve `sortPresets([])`'in `undefined` değil `[]` döndürmesine dayanıyor. `publishDefaults` Room kurucusunda SDK varsayılanlarının üzerine spread-MERGE edildiği için mik ayarları (audioPreset music, dtx, red, `stopMicTrackOnMute: false`) ve KAMERA simulcast'i dokunulmadan kalıyor. Koruma: `src/media/__tests__/screen-share-encoding.test.ts` — seçenekleri sahte `Room` kurucusuyla YAKALAR, sonra kurulu livekit-client'ın GERÇEK `computeVideoEncodings`'ini çağırıp encoding sayısını/bitrate'i ölçer (kendi literal'imizi tekrar okumaz); 5,625 Mbps → 4,5 Mbps ve 3,24 MP → 2,59 MP sayıları testte pinli, 2 mutasyonla kırmızıya döndüğü doğrulandı. **YAKALAMA (capture) hâlâ kısıtlanamıyor — JS'ten İMKÂNSIZ, kurulu pakette doğrulandı:** `@livekit/react-native-webrtc`'nin `getDisplayMedia()`'sı ARGÜMAN ALMIYOR ve native'e hiçbir şey geçirmiyor (`src/getDisplayMedia.ts`), Android'de yakalama boyutu `GetUserMediaImpl.createScreenTrack()` içinde `DisplayMetrics`'e, kare hızı `ScreenCaptureController.DEFAULT_FPS = 30`'a SABİT, ve `ScreenCaptureController` `applyConstraints`'i override etmediği için taban sınıf `UnsupportedOperationException` ile reddediyor. Sonuç: mobilde kullanıcının seçtiği kademe yalnız ENCODER'a ulaşır, capturer'a asla — telefon her zaman tüm fiziksel panelini (~2,6 MP) kodlar ve **60fps kademeleri mobilde onurlandırılamaz** (capture 30'a sabit). Bunu gerçekten çözmek capture controller'ın native patch/fork'unu gerektirir → ayrı iş. Gerekçe `screen-capture.ts` başlığında yazılı. **60 FPS kademesi mobilden KALDIRILDI (2026-07-31, §35):** capture 30'a sabit olduğu için 60 seçmek fazladan kare üretmiyor, yalnız encoder'ın bitrate tavanını yükseltiyordu (1080p'de 4,5 → 6,5 Mbps) — kullanıcı var olmayan kareler için uplink ödüyordu ve seçici çalışıyormuş gibi görünüyordu. `ANDROID_SCREEN_CAPTURE_MAX_FPS` + `screenShareFrameRatesUpTo()` (`packages/media/src/quality.ts`) iki mobil seçiciyi de filtreliyor; kalıcı kaydedilmiş bir `…60` değeri store'un merge'ünde `clampScreenShareQualityToFps` ile aşağı çekiliyor (yoksa hiçbir çip seçili görünmezken yayın 60'ın tavanına göre yapılırdı). 15 kalıyor — encoder'ı capture hızının ALTINA kapamak gerçek bir azaltma; yalnız capture'ın ÜSTÜNDEKİ kademe kurguydu. Masaüstü etkilenmedi (Electron `desktopCapturer` istenen hızı uyguluyor), 15/30/60 orada duruyor. Koruma: `packages/media/src/__tests__/capture-limited-tiers.test.ts` + `apps/mobile/src/components/__tests__/screen-share-fps-offer.test.ts` (kaynak-değişmez: seçiciler filtrelenmemiş listeye dönerse kırmızı; mutasyonla doğrulandı). |
| Ekran paylaşımı — İZLEME | ✅ | ✅ | mobil: karesine dokun → tam ekran + landscape doldurma (OTA-safe) |
| Paylaşım sesi: Ses yok / Yalnız bu uygulama / Sistem sesi (Demli hariç) | ◑ (aramada uçtan uca ton kontrolü yapılmadı) | ⛔ | **M16 Dalga 1A/1B (2026-10-19) — eski tek "Sesi paylaş" düğmesinin yerini aldı.** Masaüstü: yalnız süreç yakalama (`demli-audio-capture.exe`: pencere için include-ağaç, sistem için Demli'nin ana PID ağacı HARİÇ); tüm-cihaz loopback ve Stereo Mix/Voicemeeter/CABLE karışım girişleri SİLİNDİ → Demli'nin kendi çaldığı sesler paylaşıma girmez, mikrofon paylaşım sesi olarak yayınlanamaz. Sınır: Demli'nin çıkışını kendi sürecinden yeniden çalan bir mikser (Voicemeeter MME/WDM çıkışı, Sonar, "Bu cihazı dinle") o kopyayı sistem sesine geri sokabilir; Demli bunu algılamıyor, seçici metni söylüyor. "Yalnız bu uygulama" ayrılamazsa ses gitmez, panel tek tıkla "Sistem sesini gönder (Demli hariç)" sunar (kendiliğinden genişlemez). UWP/Store pencereleri ApplicationFrameHost yerine asıl uygulamaya çözülür. Windows build < 19041 → ses yok + dürüst not; 19041–20347 (Windows 10 2004–22H2) deneniyor, gerçek Windows 10 makinesinde doğrulanmadı. Web: Chromium `getDisplayMedia` (sekme paneliyle açılır, Demli sekmesi listede yok, `restrictOwnAudio`), seçilen yüzeye göre dürüst rehber (sekme / tüm ekran kutusu / pencere ses vermez). Mobil yayın hâlâ yalnız görüntü (#45 ses ayrı iş). Ayrıntı: aşağıdaki "M16 — paylaşım sesi" bölümü. |
| Paylaşım kalite preset'leri | ✅ | ✅ | Mobil yayınlama inince birlikte geldi: `apps/mobile/src/components/voice/ScreenShareQualitySheet.tsx` (480p→2K × 15/30/60), `VoiceControls.tsx:264` ve `call/InCallView.tsx:496` üzerinden açılır, seçim `voice-store.ts:358`'de publish'e geçer. |
| Kamera — YAYINLAMA | ✅ | ✅ | #18 yayında (mobil OTA preview 1.3.0). Mobil emülatörde doğrulandı: aç→izin→WebRTC Camera2 yakalama→kapat→ayrıl, çökme yok. 2-cihaz karşı-görüntü founder gerçek-cihaz testinde. **MOBİL-WEB P0 fix:** önizleme diyaloğu "Aç"a basıldığında kamerayı hâlâ TUTUYORDU (React effect temizliği `open=false` render'ından SONRA çalışır), livekit ikinci kez `getUserMedia` yapıyordu; masaüstü Chromium buna izin verir, mobil tarayıcılarda kamera exclusive → `NotReadableError` → eski catch-all `device_unavailable` → "Seçili SES aygıtı kullanılamıyor" mesajı. Artık önizleme publish'ten ÖNCE bırakılıyor; ayrıca `OverconstrainedError`/`NotReadableError`/`AbortError` kendi tipli hatalarını alıyor ve kısıt hatasında kamera **kısıtsız bir kez daha** denenir (telefon 1080p60 desteklemiyorsa yine açılır). Founder gerçek-cihaz doğrulaması bekliyor. |
| Kamera — İZLEME (tile render) | ✅ | ✅ | #18; kamera+ekran aynı anda açılabilir. Karşı-kamera görüntüsü 2-cihaz founder testinde. |
| Video düzeni — ekranı dolduran eşit tile grid (#9) | ✅ | ✅ | #60; her katılımcı eşit tile, kamerasız = renkli-zemin+ortada avatar+isim çipi; responsive (1/2/3-4/5+) + landscape; odak/filmstrip; kırpma/ayna YOK (`object-contain`, `-scale-x` kaldırıldı). Avatar-renk algoritması iki platform bit-bit aynı. Canlı çok-katılımcılı göz doğrulaması founder gerçek-cihaz/2-cihaz testinde. |
| Ses kalitesi — canlı uygulama (konuşma ortasında) | ✅ | ✅ | Standart/Yüksek/Müzik 48/96/256 stereo + RED/DTX; ayar değişince mic track anında republish (eskiden sonraki oturumda uygulanıyordu). |
| Gürültü engelleme — kademe (Yüksek/Standart/Kapalı) | ✅ | ◑ | Tek aç/kapa değil, üç kademe. Masaüstü Yüksek = RNNoise WASM worklet (`@sapphi-red/web-noise-suppressor`), `applyNoiseFilter`/setProcessor ile canlı mic'e. Mobil yalnız Standart/Kapalı (Yüksek native iş gerektiriyor, ölü buton yok §35); mobilde 'high' → standard'a clamp. Worklet başarısızsa Standart'a düşer (asla sessiz). Masaüstü Yüksek çalışması için CSP `'wasm-unsafe-eval'` gerekir (devops/security handoff) — o gelene dek runtime'da Standart'a düşer. **2026-07-28 — KESİNTİSİZ uygulama:** kademe değişimi artık republish ETMİYOR. `configureAudio` değişimi üç eksene ayırıyor (publish=bitrate/RED/DTX/stereo → republish · capture=DSP → `applyMicCaptureConstraints` yani `applyConstraints`, aynı track, sıfır boşluk · tier → yalnız setProcessor/stopProcessor). Worklet önce sökülür, sonra constraint değişir (processor takılıyken `mediaStreamTrack` worklet ÇIKIŞIdır). Yüksek→Kapalı hiç track'e dokunmaz. Eski davranış her ayar değişiminde unpublish+republish yapıyordu → dinleyicilerde ses kesintisi + gecikme. Ayrıca gizli hata düzeldi: `restartAudioTrack` yolunda `noiseFilterActive` zorla false'lanıyordu, dolayısıyla `stopProcessor` hiç çağrılmıyor, kullanıcı Standart'ı seçse de worklet çalışmaya devam ediyordu. **2026-10-19 düzeltme (M16 1C):** "capture=DSP → applyConstraints, sıfır boşluk" masaüstünde DOĞRU DEĞİLDİ. Electron 33.4.11 / Chromium 130'da ölçüldü (gerçek Voicemeeter girişi + sahte cihaz): `applyConstraints` AEC/NS/AGC için çözülüyor ama `getSettings()` eski değerleri gösteriyor, yani DSP değişmiyor. Adaptör artık `getSettings()` okuyarak doğruluyor; değişmediyse track yeniden alınıyor (`restartTrack` — aynı yayın, mikrofon kısa bir an yeniden açılır), bu yol ölçümde yeni değerleri raporladı. |
| Yankı engelleme — kapatmak yalnız kulaklık onayıyla | ✅ | ✅ | **M16 1C (2026-10-19).** Founder kuralı: hoparlörden çıkan hiçbir şey odaya geri gitmez. Eskiden AEC tek tıkla, uyarısız kapanıyordu (founder'ın masaüstünde AEC/AGC/NS kapalı kayıtlıydı). Artık anahtar yalnız satır içi uyarıyı açar; AEC'yi kapatan tek yol "Kulaklık takılı, kapat" düğmesi ve onay `headphonesConfirmed` olarak kalıcı. Onaysız `echoCancellation:false` her katmanda AÇIK sayılır (`effectiveAudioProcessing`, `normalizeAudioSettings`). Tek seferlik göç: `demli.media-settings` sürüm 2 — eski kayıtlarda AEC yeniden açılır, AGC/NS seçimi korunur. Müzik Modu AEC'yi her zaman açık tutar (metin artık "tüm ses işlemeyi kapatır" demiyor). İki platform aynı `@demli/media` kuralını ve aynı onay akışını kullanır. Android'de AEC'yi zayıflatan ikinci yol, Ses profili → Medya: donanım yankı engelleyicisi `inCommunication`'a bağlı. Medya artık aynı kulaklık onayından geçmeden seçilemiyor (`setAudioProfile("media_headphones")`); sürüm 2 göçü önceden seçilmiş Medya'yı bir kez Görüşme'ye çeviriyor; Medya açıkken Yankı Engelleme satırı "donanım yankı engelleyicisi çalışmayabilir" uyarısını gösteriyor. Medya profilinde donanım AEC'sinin gerçekten devre dışı kalıp kalmadığı cihazda ölçülmedi (Dalga 1D). |
| Ses işleme değişikliği arama sırasında | ✅ | ◑ | **M16 1C.** Masaüstü/web: değişiklik canlı track'e hemen uygulanır (yukarıdaki doğrulama + yeniden alma). Mikrofon kapalıyken yapılan değişiklik artık mikrofon açıldığı anda uygulanıyor — livekit'in unmute'u var olan track'i yalnız yeniden açıyor, eskiden değişiklik yeniden katılıma kadar bekliyordu. Mikrofon işlemleri (aç/kapa, canlı ayar) motorda sıraya alınıyor ve her yeniden yayından sonra livekit motorun niyetine eşitleniyor: bas-konuş bırakma ya da sağırlaştırma bir yeniden yayının ortasına düşse de mikrofon kapalı biter (eskiden yeni track açık kalıyor, düğme kapalı gösteriyordu). Motorun kendi yeniden yayını artık "mikrofon kayboldu" sayılmıyor; yeniden yayın mikrofonu geri getiremezse hata gösteriliyor. Mikrofon kapalıyken yapılıp geri alınan değişiklikten sonra Yüksek kademenin RNNoise worklet'i açılışta yeniden takılıyor. Yeniden alma artık seçili mikrofonu koruyor (livekit eksik `deviceId`'yi sistem varsayılanıyla dolduruyordu — ölçüldü). Mobil ◑: motor track'i yeniden alıyor, ama Android'in donanım yankı/gürültü engelleyicisinin kayıt sürerken değişip değişmediği cihazda doğrulanmadı; bu yüzden ekran "bir sonraki katılımda kesin olarak geçerli olur" diyor. Cihaz ölçümü Dalga 1D'de (APK döngüsü). |
| Kişi başı ses / yayın sesi tavanı | ◑ %100 | ✅ %200 | **M16 1C.** Masaüstü/web'de uzak sesler `<audio>` öğesinden çalıyor; `volume` 1'in üstünü kabul etmiyor (livekit `webAudioMix` kapalı). Eskiden kaydırıcı %200'e gidiyor, %100 üstü sessizce uygulanmıyor ama arayüz o değeri gösteriyordu. WebAudio yolu (webAudioMix ya da kişi başı GainNode) SEÇİLMEDİ: Chromium yankı engelleyicisinin WebAudio'dan çalan sesi referans aldığına dair kanıt yok (livekit kendisi Chrome AEC sorunu için öğe sink'lerini ayrıca ayarlıyor; Chrome-wide AEC bir özellik bayrağı varsayılanı, garanti değil). Kanıtlanamadığı için masaüstü/web kaydırıcısı %100'de bitiyor ve motor `maxParticipantVolume` ile her değeri oraya kırpıyor; kayıtlı %150 yüklenirken %100 olur. Mobilde aralık %200 kalıyor (RN yerel kazancı 1'in üstünü kabul ediyor; bu dalgada cihazda yeniden ölçülmedi). Parite açığı bilinçli: %100 üstü masaüstünde ancak AEC'yi bozmadığı ölçülen bir yolla gelir. |
| Sağırlaştırma (karşı taraf tam susar + oto-mic-kapat + çizgili kulaklık ikonu) | ✅ | ✅ | mobil `setRemoteAudioMuted` + geç-katılan hook; kendini sağırlaştırınca mic de kapanır. |
| Ses profili — Görüşme / Medya (gelen sesin Android akışı) | — | ✅ | #121; Android'e özel `AudioSession` kavramı, masaüstünde (Chromium) karşılığı yok. Varsayılan Görüşme = bugünkü davranış; Medya opt-in (film sesi medya seviyesinde, DSP'siz, A2DP) ve UI riski açıkça yazar (hoparlörde yankı + BT mikrofon). M16 1C: Medya'ya geçiş kulaklık onayı ister (yukarıdaki yankı satırı). `configureAudio` yalnız connect ÖNCESİ geçerli → seçim bir sonraki katılışta uygulanır, canlı oturum bozulmaz. Medya profilinde `forceHandleAudioRouting` açık, yoksa çıkış seçici ölü buton olurdu (§35). |
| Yankı engelleyici seçimi — telefonun kendi / WebRTC yazılımı (Android) | — (Chromium AEC3, seçim yok) | 🚧 | M16 1D (founder H2). Kod dev’de, **APK runtime 2.1.0 yayınlanmadı**. `@livekit/react-native` yaması ADM'yi SharedPreferences'taki seçimle kuruyor (`setUseHardwareAcousticEchoCanceler/NoiseSuppressor`); ADM uygulama açılışında kurulduğu için seçim yeniden açılışta geçerli, ekran bunu çalışan modülden okuyup dürüstçe söylüyor. Varsayılan **telefonun kendi** (bugünkü davranış). Donanım AEC'si olmayan telefonda ve Android <10'da seçim yok, yalnız bilgi satırı. "Donanım AEC'si var" kararı libwebrtc'nin KENDİ kontrolü (`JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported`): libwebrtc AOSP AEC'sini (UUID `bb392ec0-…`) kara listeye alıp yerine yazılımı çalıştırıyor — ham `AcousticEchoCanceler.isAvailable()` o telefonlarda hiçbir şey değiştirmeyen bir seçim ve "donanım çalışıyor" yalanı gösteriyordu (denetim bulgusu, dex'ten doğrulandı). Mikrofon ayarlarındaki Yankı Engelleme kapalıysa bölüm "şu an yankıyı hiçbir engelleyici temizlemiyor" der (libwebrtc aynı seçeneği iki engelleyiciye de geçiriyor). **H2 bu APK ile KAPANMIYOR:** varsayılan bugünkü ADM'yi kuruyor; bu APK founder A/B'sinin aracı (aşağıdaki M16 1D bölümü). |
| Sistem mesajları | ✅ | ✅ | |
| Slowmode (gösterge + geri sayım) | ✅ | ✅ | |
| Kanal ayarları (ad/konu/max/bitrate) | ✅ | ✅ | Bit hızı 2026-07-28'de serbest sayı kutusundan **üç hazır seçeneğe** geçti: Düşük 8 / Normal 64 / Yüksek 128 kbps + "Varsayılan" (founder isteği). Değerler tek kaynak: `AUDIO_BITRATE_PRESETS_KBPS` (`packages/config`) — UI, protokol ve API aynı modülü okur (API'deki yerel kopya kaldırıldı). Doğrulama penceresi bilerek GENİŞ kaldı (8–510): preset dışı ayarlanmış mevcut kanallar kırılmıyor, UI onları "Özel: N kbps" olarak dürüstçe gösterip değeri koruyor (en yakına yuvarlama YOK). Değişiklik canlı odaya anında yansımaz — `setAudioBitrateKbps` yalnız join'de okunuyor, yani herkese **bir sonraki katılışında** uygulanır; UI metni bunu açıkça söylüyor. **Mobil parite KAPANDI (2026-07-28):** `apps/mobile/app/(app)/channel-settings.tsx` serbest sayı kutusundan aynı `ChipSelect` preset satırına geçti ve aynı `AUDIO_BITRATE_PRESETS_KBPS` sabitini okuyor. Mobildeki **yerel 8/510 kopyası silindi** — o pencere API'nin GENİŞ kabul aralığıydı, elle yeniden yazıldığı için sunucudan sessizce ayrışabiliyordu; artık chip'ler yalnız geçerli değer üretebildiği için ekranda ayrı bir aralık doğrulaması da kalmadı. Preset dışı mevcut değerler masaüstündeki gibi salt-okunur "Özel · N" chip'i olarak korunuyor (en yakına yuvarlama YOK). Kullanılmayan `bitratePlaceholder`/`validationBitrate` anahtarları iki katalogdan da kaldırıldı. |
| Roller — YÖNETİM (oluştur/ata/izin) | ✅ | ✅ | |
| Roller — görünürlük etkisi + renkler | ✅ | ✅ | |
| Kanal görünürlüğü düzenleme | ✅ | ✅ | |
| Kanal OLUŞTURURKEN görünürlük seçimi | ✅ | ✅ | |
| Medya yükleme (foto/video/ses) | ✅ | ✅ | mobil attachment UI stringleri EN — #57 i18n takibi |
| Medya görüntüleme | ✅ | ✅ | |
| Görseli kaydet (dizin seçerek) + görseli panoya kopyala | ✅ | ✅ | Founder isteği. Görsel ekinde sağ-tık/uzun-basma menüsü (`ActionMenu`) + büyütülmüş görüntüleyicide görünür indir/kopyala düğmeleri. Masaüstü: main'de `dialog.showSaveDialog` (kullanıcı dizini seçer, iptal SESSİZ) + `clipboard.writeImage` — renderer'a fs/shell AÇILMADI; yeni `demli:images:*` IPC zod ile doğrulanıyor, URL build'de sabitlenen depolama origin'ine kilitli (`DEMLI_STORAGE_ORIGIN`/`DEMLI_DOMAIN`), 10 MB sınırı + magic-byte kontrolü, baytlar renderer'a GERİ DÖNMÜYOR. Web (aynı renderer): dizin seçimi yalnız `showSaveFilePicker` varsa (Chromium), yoksa tarayıcının indirme klasörü — tarayıcı kısıtı, gizlenmiyor; kopyalama `ClipboardItem`+`clipboard.write` yoksa madde HİÇ gösterilmiyor (§35). WebP/GIF panoya kopyalanamaz (nativeImage çözemiyor) → dürüst hata satırı. **Mobil (parite kapandı):** görsele uzun-bas → paylaşılan `ActionSheet` + tam ekran görüntüleyicide 44dp indir/kopyala düğmeleri. Android'de KAYDET gerçek dizin seçtirir (`StorageAccessFramework.requestDirectoryPermissionsAsync` → `createFileAsync` → base64 yazımı); picker'dan geri çıkmak SESSİZ iptal. iOS'ta dizin verme yok → sistem paylaşım sayfası (Fotoğraflar / Dosyalar'a kaydet) — fark gizlenmiyor. KOPYALA `expo-clipboard.setImageAsync` (base64 PNG/JPEG); WebP/GIF için madde HİÇ gösterilmiyor + baytlar beyan edilen MIME'dan farklı çıkarsa dürüst "bu biçim kopyalanamıyor" satırı. Aynı sınırlar masaüstüyle bit-bit ortak (`ATTACHMENT_LIMITS.image` 10 MB, magic-byte sniff, https-only + özel/loopback host reddi, dosya adı temizleme); kural dosyası `apps/mobile/src/lib/image-actions/policy.ts` (saf, 40+ test). **Mobile-özel vaka:** gönderenin kendi taze mesajında resolver signed URL değil kendi cache'imizdeki `file://` URI'yi servis eder (`setLocalUrl`) — bu yüzden allow-list "kendi sandbox'ımızdaki dosya" dalını da tanır (traversal reddi + yalnız cache/documents kökleri); emülatörde yakalandı. YENİ NATIVE BAĞIMLILIK YOK → OTA-güvenli (runtimeVersion değişmiyor). |
| Dil (TR/EN, cihaz dili, ayar) | ✅ | ✅ | mobil istisna: mikrofon izin diyaloğu + engine ses hataları EN (media-webrtc takip işi) |
| Sesten düşmeden gezinme + mini bar | — (pencere tek) | ✅ | |
| Arka planda dinleme | ✅ | ✅ | |
| Ping/bağlantı kalitesi göstergesi (3 bar + RTT) | ✅ | ✅ | |
| Arka planda KONUŞMA (+ KAMERA) | ✅ | ✅ | #45 KAPANDI (native APK dalgası). Politika `apps/mobile/src/media/foreground-service.ts` `resolveVoiceForegroundServiceType`, sürücü `components/voice/ForegroundServiceController.tsx` (uygulama kökünde `app/_layout.tsx`'te mount), native `<service>` bildirimi `plugins/with-foreground-service.js`. **Founder cihaz bulgusu (2026-07-30) kapandı — arka planda ses VE kamera ölüyordu, yayın yaşamaya devam ediyordu.** İkisi mobilde DM aramasındaydı, iki kamera açık, biri tüm ekranını paylaşıyor; uygulamayı alta alınca (Android PiP penceresi) her şey ÇALIŞIYOR, ama PiP penceresi KAPATILINCA mikrofon susuyor ve kamera donuyordu. Kök neden: `RECORD_AUDIO`/`CAMERA` Android'in **while-in-use** izinleri — uygulama görünür olmayı bıraktığı anda OS kaynağı keser; PiP'teki activity "paused ama GÖRÜNÜR" olduğu için 3. adımda sorun çıkmıyordu. Foreground-service tipleri **çapraz yetki vermez** ([service-types](https://developer.android.com/develop/background-work/services/fgs/service-types)): ekran paylaşımının `mediaProjection` servisi yalnız yayını ayakta tutar. Eski politika tam da `screenShareEnabled` iken servisi KAPATIYORDU ("MediaProjection mikrofonu da tutar" varsayımı — yanlış) ve `camera` tipi hiç yoktu. İmza kanıt niteliğinde: track'ler yayında kaldığı için karşı taraf **sessizlik + DONMUŞ kare** gördü, mute rozeti/avatar değil — yani OS kaynak kesmesi, bizim teardown'ımız değil (sahne/PiP bileşenleri `setCamera/setMic/unpublish/stop` çağırmıyor, doğrulandı). Düzeltme: servis artık **ekran paylaşımı dahil tüm oturum boyunca** çalışır ve kamera açıkken tipi `microphone|camera`'ya genişler; `screenShareEnabled` politika imzasından tamamen ÇIKARILDI (bağ yeniden kurulamasın diye). Kütüphane (`@supersami/rn-foreground-service`) tek tip adı eşliyor ve tanımadığını sessizce `location`'a düşürüyordu → birleşik tipi OR'layan pnpm patch'i (`patches/@supersami__rn-foreground-service@2.2.5.patch`). Ayrıca while-in-use servisi **arka plandan başlatılamaz**, o yüzden start/genişletme `AppState==="active"` kapısına bağlı (push'tan cevaplanan arama sonraki ön plana çıkışta toparlanır). Korumalar: `src/media/foreground-service.test.ts` — saf politika + **kaynak-değişmez** testler (manifest tipi, izin listesi, çalışma-zamanı tipinin manifest tavanının içinde kalması, patch kaydı); 5 mutasyonla kırmızıya döndüğü doğrulandı. ⚠️ **Cihaz doğrulaması AÇIK** (founder kuralı: mobil medya değişikliği akıl yürütmeyle yayınlanmaz) — iki kişilik senaryo emülatörde üretilemez. |
| Bildirimler | ✅ (masaüstü OS toast + WEB tarayıcı bildirimi) | ✅ | **Kapı düzeltildi (founder P0):** eski kural `document.hasFocus() → bildirim YOK` idi; uygulama açıkken hiçbir bildirim gelmiyordu, kullanıcı başka bir sohbete bakıyor olsa bile. Yeni kural (tek kaynak `renderer/src/notifications/notify-policy.ts`, 21 birim testi): bildirim yalnız kullanıcı **o konuşmaya bakıyorken** bastırılır — odakta ama başka kanalda/DM'de, ayarlar açıkken, video sahnesi sohbeti kapatmışken, arka planda, tepside veya sekme gizliyken bildirim GELİR. "Ne görünüyor" sorusu türetilmez, çizen bileşen bildirir (`visible-conversation.ts`) — `activeChannelId` Arkadaşlar sekmesine geçince temizlenmediği ve sahne sohbeti kapattığında da değişmediği için mağazadan türetmek yanlış cevap veriyordu. Mesaj SESİ de aynı fonksiyona bağlandı, artık ikisi ayrışamaz. Değişmeyen kapılar: DND, ana anahtar, kanal/sunucu susturma, engelleme, kendi mesajın, sistem mesajı, kanal başına 5 sn kısma. **Web artık gerçekten bildirim veriyor:** izin hiç istenmiyordu (`Notification.permission` sonsuza dek "default"), şimdi Ayarlar'da kullanıcı jestine bağlı "Bildirimleri aç" düğmesi + dürüst izin durumu (verildi/reddedildi/desteklenmiyor); web köprüsündeki ikinci "yalnız arka planda" kapısı kaldırıldı (politikayı ikinci kez yiyordu) ve toast etiketi konuşma başına ayrıldı (tek etiket bildirimleri üst üste eziyordu). İzin yoksa/desteklenmiyorsa alarm SESSİZCE DÜŞMÜYOR: uygulama-içi toast'a (`InAppNotificationToast`) iniyor — her uyarı için tek yüzey seçilir, çift bildirim yok. **Mobil push CANLI** (#46 kapandı): FCM V1 service account Expo'ya bağlı (bu belgede DM-aramaları bölümü de aynısını söylüyor), istemci tarafı `apps/mobile/src/push/PushController.tsx` (uygulama kökünde mount) + `push/push-manager.ts` (token/kanal/dokunma yönlendirmesi), sunucu tarafı `packages/notifications/src/push.ts` (expo-server-sdk) + `channel-message-push.ts`, cihaz kaydı `apps/api/src/modules/devices/`. Kilitli telefonda tek-ekran-görüntüsü founder doğrulaması hâlâ açık, ama bu bir DOĞRULAMA maddesi — kod ve sunucu yolu canlı. **Mobil parite KAPANDI (2026-07-28) — ama teşhis farklı çıktı.** Kural artık `packages/client-core/src/notify-policy.ts`'te (masaüstündeki dosya zaten saf/sıfır-import'tu, client-core'a TAŞINDI; mobil onu tüketiyor, kopya yok — 13 birim testi). ⚠️ Beklenen hata YOKTU: mobilin üç kapısı da (`push-manager` ön plan handler'ı, in-app banner, ses ipucu) zaten `activeChannelId`'yi kontrol ediyordu, yani "ön planda ama başka sohbette" durumu bildirim ÜRETİYORDU. **Gerçek boşluk şu:** `activeChannelId` "thread MOUNT edilmiş mi" sorusunun cevabı, "kullanıcı ona BAKIYOR mu" sorusunun değil. expo-router yığınında sohbetin ÜSTÜNE bir ekran itmek (sesli oda, kanal ayarları, profil, pin panosu) thread'i unmount etmiyor, dolayısıyla iddia ayakta kalıyor ve o sohbetin bütün uyarıları — OS banner'ı, in-app banner, ses — kullanıcı bambaşka bir ekrana bakarken sessizce düşüyordu. Bu, masaüstündeki "üstü kapanmış pencere" durumunun telefon ikizi ve aynı sınıf founder-görünür hata: haberdar olmadığın mesaj. Görünürlük artık `useFocusEffect` ile talep ediliyor (`apps/mobile/src/notifications/visible-context.ts`; `focused` = `AppState==="active"`, `hidden` = false); `activeChannelId` kendi işini (okunmadı bastırma, okundu işaretleme) sürdürüyor — ikisi bilerek AYRI değerler, çünkü kapanmış bir thread mesajı geri dönünce yine gösterir ama uyarıyı hak eder. Oturum kapanışında (`stopRealtime`) talep sıfırlanıyor. **Masaüstü dedup açık iş:** `apps/desktop/.../notifications/notify-policy.ts` hâlâ kendi kopyasını tutuyor; tek satırlık re-export'a indirilmeli (bu dal `apps/desktop`'a dokunmuyor). |
| Bildirim/arayüz sesleri — ses ailesi seçimi | ✅ Kece Tahta (`felt`) | ✅ aynı setten besleniyor | Founder mevcut sesleri "dandik" buldu (2. tur). Ölçümle teşhis (kulakla değil): kare başına 1-4 spektral tepe (saf sinüs), 3 kHz üstü enerji %0.0-1.3, <300 Hz gövde %0.1, vuruş transiyenti yok, tüm spektrum için tek üstel sönüm, dokuz kuyruğun hepsinde crest 9.8-11.0 dB (hepsi aynı TÜR ses), tepe-normalizasyon yüzünden `message` `screen-start`'ın yalnız 2 dB altında, "reverb" 17/29/41/57 ms dört slapback (metalik tarak filtresi). `scripts/gen-sounds.mjs` modal sentezle yeniden yazıldı (vuruş gürültüsü + inharmonik parsiyel yığını + parsiyel-başına sönüm + gövde + Schroeder oda + **gürlük** tabanlı seviye) ve **3 ayırt edilebilir aile** üretiyor: `marimba` (Sıcak Marimba), `glass` (Yumuşak Cam), `felt` (Keçe Tahta). Dördüncü aile `legacy` şu an yayında olan seti **örnek-örnek aynı** üretiyor (0.0 fark doğrulandı), `ACTIVE_FAMILY` orada duruyor → bu tur hiçbir yayın baytı değişmedi. Founder dinleyip seçecek: `node scripts/gen-sounds.mjs --preview` → `build/sound-previews/index.html`. Seçim tek satır (`--family=<id>`) ve **iki istemciye birden** yazar, yani mobil ses varlıkları da o turda güncellenir. |
| Sistem tepsisi ikonu — durum göstergesi (mic/sağır + okunmamış noktası) | ✅ | — | Founder isteği. Tepsi ikonu artık DURUM gösteriyor: mikrofon susturulduğunda çizgili mikrofon, sağırlaştırıldığında çizgili kulaklık, okunmamış bildirim varken üstte kırmızı nokta. **Öncelik:** taban ikon = ses durumu (kalıcı, kullanıcının kendi açtığı durum), kırmızı nokta = üstüne bindirilen geçici katman; sağır susturulmuşu EZER (motorda sağırlaştırma zaten mic'i kapatıyor, `packages/media` `setDeafened` → `micEnabled:false`, iki ikonu birden göstermek aynı olguyu iki kez söylemek olurdu). Sesli oturum yokken hep normal ikon: mic/sağır tercihleri oturumlar arası korunuyor, oturum dışında "susturulmuş" çizmek girmediği bir aramada susturulmuş olduğunu iddia etmek olurdu. Kural saf fonksiyon (`main/tray-icon-variant.ts`, 25 test); okunmamış kaynağı grup rayının kendi rozet toplamı (`useShellData` homeUnread + groups[].unread) — ikinci bir okunmamış kuralı türetilmedi, susturma semantiği hazır geliyor. **Kırmızı nokta bugüne dek hiç çalışmıyordu:** `setUnreadBadge` IPC'si + kırmızı noktalı ikon varlığı vardı ama renderer HİÇ çağırmıyordu (yarım kalmış özellik); `app-ui` PlatformBridge aynası da bu metodu hiç içermemişti — ikisi de kapatıldı. Yeni `setVoiceStatus` IPC'si zod `.strict()` ile doğrulanıyor. İkonlar `gen-icons.mjs`+`brand-manifest.json` üzerinden üretiliyor (elle base64 yok, `check-brand-icons` 47 varlığı doğruluyor); 16px ve 32px AYRI optik ızgarada çiziliyor ve `nativeImage.addRepresentation` ile 1x/2x veriliyor — 32px'i küçültmek çizgiyi tam da okunması gereken yerde eziyordu. Mobilde sistem tepsisi kavramı yok (Android bildirim çekmecesi ayrı satır: "Bildirimler"). |
| Oto-güncelleme | ✅ (installer, sessiz tek-tık) | ✅ (OTA) | masaüstü: setup sihirbazı yok, sessizce kurar + yeniden açar (0.0.9) |
| Masaüstü dağıtımı — Windows | ✅ | — | `package:win` → NSIS + portable + latest.yml; canlı yayın yolu |
| Masaüstü dağıtımı — macOS | 🚧 | — | M19. electron-builder mac hedefi (dmg+zip, x64+arm64) + `.github/workflows/desktop-mac.yml` (macos-latest) yazıldı ama **HİÇ ÇALIŞTIRILMADI** — ilk CI koşusu doğrulama adımı. İmzasız (Gatekeeper uyarısı); imzalama Apple Developer $99/yıl → founder kararı, tek env anahtarıyla açılır. |
| Hata izleme (Sentry) | 🚧 varsayılan KAPALI | ⛔ | M19. Masaüstü main+renderer hataları Sentry'ye gider; DSN build-time env (`SENTRY_DSN`), boşsa hiçbir ağ isteği yok. Founder'ın Sentry hesabı/DSN'i yok → şu an kapalı. PII temizliği + ADR 0018. Mobil Sentry ayrı native dalgada. |
| Sunucudan ayrılma / gruptan ayrılma | ✅ | ✅ | |
| Sunucu/grup silme (owner, onaylı) + boş kalınca oto-silme + canlı düşürme | ✅ | ✅ | |
| Profil (ad/avatar/bio) | ✅ | ✅ | |
| Reply / emoji reaksiyon | ✅ | ✅ | |
| UI ses efektleri | ✅ | ✅ | mobil: expo-audio (Android ogg) |
| Arkadaşlık + DM + profil (bio/roller) | ✅ | ✅ | |
| Grup-DM (flat group chat) oluştur + üye ekle → EKLENEN üyeye ANLIK görünürlük + bildirim | ✅ | ✅ | BUG fix: `group_chat.added` user-scoped event (dm.created ikizi). Backend fan-out eksikti — üye ekleyince EKLENEN üyeye hiçbir event gitmiyordu (ne liste ne bildirim). Şimdi API `POST /group-chats/:id/members` → user-scoped publish → gateway eklenen üyenin soketlerini stream'e abone eder → istemci grubu listeye düşürür + toast/in-app banner. **Backend SUNUCUYA DEPLOY EDİLDİ (2026-07-24, realtime taze restart)**; runtime founder doğrulaması bekliyor. |
| Demli Voice v2 teması (sıcak palet + accent + Instrument Sans/Space Grotesk fontları) | ✅ | ✅ | **Mobil NATIVE parite (Director kararı: WebView-shell YOK).** `apps/mobile/src/theme/theme.ts` masaüstü `tokens.css` değerlerini birebir taşır; `src/theme/__tests__/design-tokens.test.ts` tokens.css'i okuyup 26 rengi karşılaştırır + WCAG kontrastı sayısal doğrular (drift artık build'i kırar). Fontlar: latin+latin-ext birleşik statik .ttf (TR ı/ğ/ş tam), expo-font ile yükleniyor — expo-font zaten `expo` paketinin bağımlılığı, YENİ NATIVE MODÜL YOK → OTA-safe. `ui/Text.tsx` fontWeight→aile eşlemesi yapar (RN özel fontta fontWeight'i yok sayar). |
| Sesli oda Design v2 sahnesi (avatar-tile grid + konuşma pulse-ring + ODAKTA odak + cam VoicePanel) | ✅ | ◑ | Masaüstü+web tek renderer; `packages/media`'ya dokunulmadı (saf görsel); avatarlar tam daire. **Mobilde sahnenin gövdesi VAR** (bu yüzden ⛔ değil ◑): avatar-tile ızgarası `components/voice/ParticipantTile.tsx:80` (kullanıcı-başına gradyan + ortada avatar + isim çipi), odak/konuşma kenarlığı `:121`, ızgara `components/voice/CameraGrid.tsx`, sahne `VoiceRoomScreen.tsx` — 24. satır bu sahneyi zaten M=✅ sayıyor. Mobilde gerçekten eksik olan iki katman: **animasyonlu pulse-ring** (mobil halka statik renk, `Animated`/`withRepeat` yok) ve **cam/blur VoicePanel** (native arka plan bulanıklığı native dalgaya bırakıldı — `components/voice/CameraPreviewSheet.tsx:53`). |
| "Sunucu" terminolojisi (grup→Sunucu) + DM listesinde hover-kapat (✕) | ✅ | ✅ | Mobil TR/EN katalogları sunucu-terminolojisine geçti (teknik id'ler sabit: `friend_group`/`groupId`); grup-DM (flat group chat) kasten "grup" kaldı — masaüstüyle aynı ayrım. DM ✕ mobilde **uzun basma → ActionSheet** (hover yok; swipe için gesture-handler gerekir = yeni native modül, OTA'yı bozar). Aynı server-side hide-for-self ucu, onaylı. |
| Sesli kanal geçişinde onay diyaloğu (ekran/arama/oda kesintisi) | ✅ | ⛔ | Mobil parite AÇIK (aynı karar). FSM'e dokunmadan join-öncesi guard; boş durumdan girişte diyalog yok. |
| Video alanı ÜZERİNDE yüzen çağrı kontrolleri (kamera/ekran/mikrofon/kapat + tam ekran) | ✅ | ✅ | Mobil karşılığı `apps/mobile/src/components/voice/StageControlBar.tsx`. **W3'te (2026-07-30) `components/call/CallStageControls.tsx`'ten TAŞINDI**: eski yerinde yalnız `InCallView` mount ediyordu, yani sunucu sesli odasında sahne-üstü kontrol HİÇ YOKTU — founder'ın "sunucudaki sesli ile özel arasında fark olmamalıydı" şikâyetinin kalemlerinden biri. Artık ortak `VoiceStage` kabuğu mount ediyor, dolayısıyla iki yüzey barı **yapısal olarak** paylaşıyor (birine eklenip diğerinde unutulması mümkün değil). **Dokunmatik farkı:** hover yok → sahneye dokunma çubuğu AÇAR/KAPATIR (`useAutoHideControls`, boşta solar); solukken `pointerEvents="none"`, yani gizli çubuk kendini geri getirecek dokunuşu yutamaz. Sahne sarmalayıcısı `onTouchStart` kullanır — RN'de dokunma olayları KABARIR, dolayısıyla tile odaklama / PiP sürükleme / odaktan çıkma gestleri aynen çalışır (çubuk dokunuşu gözlemler, almaz). Kamera ve ekran düğmeleri alt bardaki AYNI ön-yayın akışını çalıştırır (önizleme sheet'i / kalite sheet'i), iki bar aynı voice store'u sürer. **Tam ekran düğmesi mobilde yalnız YAYIN varken** çıkar: kameranın tam ekranı kendi odaklanmış tile'ındaki genişlet düğmesinde yaşıyor; üç kamera açıkken bir bar düğmesinin "hangi kamera" sorusuna rastgele cevap vermesi ölü/yanıltıcı kontrol olurdu (§35). Alt `VoiceControls` barı AYNEN duruyor. Saf RN UI → OTA-safe. Masaüstü+web `VideoStage` içinde `StageControlBar`; sol-alt CallDock/VoicePanel/UserFooter **aynen duruyor** (founder: "sol altı da kullanabilir"), ikinci kontrol mantığı yok — hepsi aynı voice store → aynı `@demli/media` FSM. Fare: `useAutoHideOverlay` ile solar; dokunmatik: `pointer-coarse:` ile KALICI (telefondan web'e giriliyor, hover yok); klavye: solukken de tab-edilebilir + `focus-within` sabitler. Tam ekran düğmesi yalnız gerçekten izlenecek video varken (yayın veya açık kamera) görünür — üstteki toolbar düğmesi de aynı kurala bağlandı (ölü buton yok, §35). Mobil karşılığı native değil, saf RN UI (`InCallView`) → OTA ile gidebilir. |
| Sahne düzeni — konuşana göre filmstrip (pin'liyken) | ✅ | ✅ | **W2 (K3); mobil parite W3'te kapandı (2026-07-30).** Founder: "bi kameraya odaklanıp pinlersem diğer kişilerin kamerası sadece o kişiler konuştukça görünmeli". Pin/odak varken yan panel = **her zaman** kendin + tüm ekran paylaşımları/watch, **koşullu** diğerleri: yalnız `ActiveSpeakerTracker`'ın `recent` listesindeyken (300 ms attack / 5 sn release, recency sıralı, tavan 5). Görünmeyen tile **unmount** edilir (gizlenmez) — yerel SFU ölçümü: tile mount'luyken **142 469 bps**, unmount'ta **0 bps**, remount'ta **152 925 bps** (`apps/web/src/harness/livekit-probe.ts`, gerçek `livekit-server` + `adaptiveStream`), yani açık `setSubscribed(false)` bu ölçekte gerekmiyor (K3 abonelik politikası kanıtlandı). Küçük çağrıda kural KAPALI: 3'ten az koşullu kişi varken herkes görünür (`SPEAKER_FILMSTRIP_MIN_OTHERS`) — bir kişilik odada tek karşındakini susunca gizlemek yönsüz kalırdı. Gizlenenler "N kişi daha — konuşunca görünür" çipiyle sayılır (gizli ≠ yok). Otomatik "konuşana sahneyi ver" bilinçli olarak YOK (plan reddetti: sahne cümle ortasında el değiştirir). Saf model `packages/media/src/stage.ts` (RN-safe). **Mobil W3'te aynı modeli TÜKETİYOR, kopyalamıyor:** `CameraStage` artık `resolveStage(..., { speakerFilmstrip })` çağırıyor ve `recent` listesini ortak `useActiveSpeakers()` trackerından alıyor — yani histerezis sabitleri, tavan ve küçük-oda muafiyeti (`SPEAKER_FILMSTRIP_MIN_OTHERS`) tek yerde tanımlı ve iki platform aynı anda değişiyor. Gizlenenler mobilde "+N" çipi (`voice.filmstripHidden`) + a11y cümlesiyle sayılıyor. Odak anahtarı elle string birleştirilmiyor, ortak `participantKey()` ile türetiliyor (§23). Mobil ekran-paylaşımı ve watch party sahneleri KASITLI olarak ızgaraya girmiyor (telefonda tam-bleed ayrı sahneler) — model bunu `shares`/`watchChannelId` boş geçilerek tüketiyor, tile anahtarları yine de hizalı kalıyor. |
| Self-view — odak/tam ekranda sağ-altta kendi kameran (sürüklenebilir, kamera kapalıyken de) | ✅ | ✅ | **W2 (K4); mobil parite W3'te kapandı (2026-07-30).** Founder birebir: "tam büyüttüğümde sağ altta benim kameram gözükmeli, kameram açık değilse de kamera gözükmediği haliyle bir dikdörtgen belirsin ki kameramın açık olmadığını anlayayım, kendimi sürükleyebilmeliyim". Odak/tam ekranda varsayılan AÇIK, sağ-alt; sürüklenir + köşeye yapışır; köşe + açık/kapalı `localStorage`'da (`demli.stage-overlay`) — reload sonrası aynı köşede doğrulandı. Kamera KAPALIYKEN kaybolmaz: avatar + "Kameran kapalı" dikdörtgeni (`data-testid=self-view-camera-off`). Izgara modunda PiP YOK (zaten kendi tile'ınsın). **Tek kutu:** eski "herhangi kamerayı katmana sabitle" özelliği aynı overlay'in KONUSU oldu (`pipSourceKey===null` → self), ikinci sürüklenebilir kutu yok. **Mobil (W3):** `SelfViewPip` → `DraggableCameraPip`'in self varyantı; odak sahnesinde ve KAMERA tam ekranında mount (ızgarada YOK — zaten kendi tile'ınsın). Varsayılan AÇIK, sürüklenir + köşeye yapışır, köşe + açık/kapalı `expo-secure-store`'da (`demli.selfView.v1`, `self-view-store`) — SecureStore mevcut bağımlılık olduğu için **OTA-safe**, native rebuild gerekmez. Kamera kapalıyken kaybolmaz: avatar + "Kameran kapalı" dikdörtgeni (`PipCameraOff`, `voice.selfView.cameraOff`). Self-view açıkken kendi tile'ın filmstripten düşürülür → iki kez çizilmezsin. Ekran-paylaşımı tam ekranında self-view KASITLI olarak yok: oradaki tek kutu aktif konuşana ayrılmış (founder: "iki ayrı sürüklenebilir kutu yapma"). |
| Kişi-bazlı ses (uzun-bas → "User Volume" sheet) DM ARAMASINDA | ✅ | ✅ | **ÖLÜ KONTROL kapandı (W3, 2026-07-30).** Hata: `ParticipantTile` uzun-basınca modül-seviyesi `openParticipantVolumeSheet(identity)` çağrılıyor, controller store güncelleniyor — ama `<ParticipantVolumeSheet>` host'u YALNIZ `VoiceRoomScreen`'de mount ediliyordu. Sunucu seslisinde çalışıyor, DM aramasında basıyorsun hiçbir şey olmuyordu: §35'in tam tanımı, ve founder'ın hissettiği farkın en somut kalemi. Tetikleyici de host da doğruydu; eksik olan MOUNT'tu — bu yüzden tile'ı render eden hiçbir test hatayı yakalayamazdı. Düzeltme kalıcı olsun diye host artık ortak `VoiceStage` kabuğunda ve **tam bir kez** mount ediliyor (iki mount tek controller'a iki modal bağlardı); `VoiceRoomScreen`'deki eski mount kaldırıldı. Koruma: `apps/mobile/src/components/voice/stage-shell.test.ts` — kaynak-değişmez, çünkü doğrulanması gereken şey bir WIRING gerçeği; mount silinerek mutasyon testi yapıldı ve gate gerçekten kırmızıya döndü (2/15 fail), sonra geri alındı (`gates-that-lie`). ⚠️ Cihazda iki-kişilik canlı aramada göz doğrulaması AÇIK (aşağıya bakın). |
| Ses çıkış rotası (hoparlör/kulaklık/bluetooth) aramada | — (masaüstü cihaz seçimi ayarlarda) | ✅ | W3 (2026-07-30). `AudioOutputControl` D1 denetiminden beri sesli odanın durum şeridindeydi ama DM aramasında HİÇ yoktu — telefonda kulaklığa/hoparlöre geçemiyordun. Aynı bileşen artık çağrı başlığında da; oturum canlı değilken kendini gizliyor, dolayısıyla bağlanırken bedeli yok. **M16 1D:** hap artık audioswitch'in GERÇEKTE çaldığı rotayı gösteriyor (yamalı `getSelectedAudioOutput` + `LK_AUDIO_OUTPUT_CHANGED` olayı) — eskiden kullanıcı seçene kadar genel "Ses çıkışı" yazıyordu, oysa oturum hoparlörde başlıyordu. Kulaklık/BT çağrı ortasında gelince güncellenir. Hoparlördeyken ve ahize/kulaklık varken sheet'te yankı ipucu. Kamera açılınca rota ahizedeyse hoparlöre alınır (görüntülü arama = hoparlör) — yalnız ahize önceki aramadan taşındıysa; kullanıcı ahizeyi BU aramada elle seçtiyse dokunulmaz. Kulaklık/BT'ye hiç dokunulmaz. Aynı bileşen DM araması, grup araması ve sunucu sesli odasında. |
| Uygulama arkadayken sürüklenebilir video penceresi (Android OS PiP) | — (masaüstü pencere zaten açık kalır) | ✅ | **Founder cihaz bulgusu (2026-07-30) kapandı — pencere yatay duruyordu ve karşıdaki kişi "yarım bi şey" görünüyordu.** Üç ayrı hata: (1) `setPictureInPictureParams` 16:9'a sabitti → dikey telefon kamerası yatay kutuya giriyordu; artık oran içeriğe göre (kamera → 9:16, ekran paylaşımı → 16:9) ve Android'in `setAspectRatio` sınırlarına (`[1/2.39, 2.39]`) **clamp'lenir** — aralık dışı bir değer OS'ta istisna atar ve pencere ESKİ (yanlış) oranında kalır, yani clamp sessiz bir başarısızlığı önlüyor. (2) `objectFit="cover"` portre kareyi kırpıyordu (= "yarım yüz"); artık **her zaman `contain`** — oran zaten doğruysa ikisi matematiksel olarak aynı, yanlışsa küçük gösterir ama asla yarım göstermez, boşluğu marka zemini (`colors.rail`) doldurur. (3) Konuşan seçimi `remoteCameras[0]`a düşüyordu; artık tek ortak `ActiveSpeakerTracker` (`packages/media/src/active-speaker.ts`, 300 ms attack / 5 sn release + son-konuşan hafızası) — hece başına el değiştirmiyor, sessizlikte listenin başına atlamıyor. Öncelik: uzak ekran paylaşımı > konuşanın kamerası > son konuşanın kamerası > herhangi uzak kamera > **kendi kameran** (yalnız kendi kameran açıkken de pencere kurulur). **AVD `demli-debug` doğrulaması (2026-07-30):** kameranı açıp ana ekrana bas → pencere `mBounds=Rect(702,1234-1038,1831)` = 336×597 = **0,5628 ≈ 9:16** (eskiden 16:9); içerik kırpılmamış; PiP'ten dönüşte siyah örtü takılı kalmıyor. (4) **Ek bulgu, aynı seansta yakalandı:** tam ekran video açıkken ana ekrana basınca pencere kameranın SOL ÜST köşesinin büyütülmüş bir dilimini gösteriyordu — RN `<Modal>` ayrı bir native Dialog penceresi ve Android onu pinlenmiş PiP sınırlarına yeniden yapılandırmıyor, dolayısıyla tam ekran (1080×2400) ölçüsünde kalıp 336×597 pencereye kırpılıyor. Bu, founder'ın "yarım bi şey" tarifinin ikinci mekanizması. Otomatik-kapatma DEVRE DIŞI bırakılarak da aynen tekrarlandı → hata mevcut koddan geliyor, bu dalganın getirdiği bir şey değil. Düzeltme: modal artık PiP'e girerken **yerel olarak** kapanır (`visible && !inPipWindow`), yani Dialog penceresi PiP geçişiyle aynı commit'te düşer, sahibinin state'inin geri dönmesini beklemez; sahibi de `onClose` ile haberdar edilir (dönüşte bayat tam ekran açık kalmaz — doğrulandı). ⚠️ Bu son düzeltmenin PiP penceresi içindeki sonucu emülatörde DOĞRULANAMADI (AVD'nin sanal kamerası ilk oturumdan sonra kare üretmeyi bıraktı) — founder cihaz testi maddesi. **Bilinen sınır:** kameranın gerçek yönü JS'ten ÖLÇÜLEMİYOR — Android portre kamerayı yatay tamponda + rotasyon metadata'sıyla yollar, `RTCView.onDimensionsChange` rotasyonu düşürür, uzak track'te `getSettings()` yok, publisher'ın `TrackInfo` boyutu da capture formatı (yatay). Bu yüzden kamera için portre VARSAYILAN; masaüstü webcam'i (16:9) dikey pencerede letterbox olur — `contain` sayesinde tam görünür, sadece küçük. Kesin çözüm sender'ın oranını katılımcı ATTRIBUTE'u olarak yayınlaması (engine.ts gerektirir → ayrı dalga). Saf RN + runtime parametre → **OTA-safe**, native rebuild gerekmez. |
| Arama yüzeylerinde ses hatası / bildirimi | ✅ (VoicePanel; CallDock M16 1C masaüstü dalı) | ✅ | M16 1C mobil yarısı: tek `VoiceNotices` bileşeni (yalnız-kalma geri sayımı + §26 `localizeVoiceError`) hem `InCallView` (DM + gruba yükseltilmiş arama) hem `VoiceRoomScreen`'de. Eskiden DM aramasında mikrofon/kamera/yeniden bağlanma hatası hiç görünmüyordu. |
| Kendini dinle (mic monitoring — filtrelenmiş sesi duy) | ✅ | ⛔ | Mobil parite AÇIK — Director kuyruğu. Ayarlar → Mikrofon → "Kendini dinle": mikrofonu **yayınla AYNI zincirden** çalar (`audioCaptureOptionsForSettings` + aynı RNNoise worklet fabrikası), böylece Gürültü Engelleme kademesi kulakla yargılanabilir. Odadayken önce **otomatik mute + deafen** (yankı koruması, founder isteği), kapatınca önceki mic/deafen durumu **birebir** geri yüklenir (zaten susturulmuş kullanıcı açılmaz) — karar saf `monitorSuppressionPlan`/`monitorRestorePlan` fonksiyonlarında, FSM'de `VoiceState.selfMonitoring`. Ayrılma/disconnect/dispose + cihaz/ayar değişiminde monitor temizlenir (canlı capture sızıntısı yok). Mobilde `createMicMonitor` enjekte edilmediği için sessizce yok değil — `monitor_unavailable` tipli hata. Mobil karşılığı **native**: RN'de ne AudioWorklet ne `<audio>` sink var, kendini-dinleme için native ses yolu gerekir (`expo-av`/native modül) → OTA ile GİTMEZ. **Mobil dalga kararı (2026-07-27):** yüzen çağrı kontrol çubuğuna kendini-dinle düğmesi KOYULMADI — motor isteği zaten `monitor_unavailable` ile reddediyor, düğme her basışta hata verirdi (§35). Native ses yolu gelene kadar madde mobilde yok. |
| Video codec VP9 (+ VP8 fallback) + adaptif uplink tier (yayında ping/bufferbloat) | ✅ | ✅ izle | Masaüstü+web `publishDefaults` VP9 + `backupCodec` (Safari12/eski→VP8, siyah kutu yok); adaptif tier ekran-paylaşım tavanını uplink kötüyse histerezisli düşürür (720p30 taban, kullanıcı seçimine dokunmaz). Mobil izleyici VP9 decode eder (libwebrtc). **Mobil YAYINLAMA artık var (#45 kapandı) ve bilerek VP8 kalıyor (2026-07-31):** çoğu Android SoC'de VP9 **encode** donanımı yok, dolayısıyla VP9'a geçmek ~2,6 MP'lik bir YAZILIM kodlaması demek; motorun ekran-paylaşımı `degradationPreference`'ı `maintain-framerate` olduğu için bu CPU baskısı doğrudan ÇÖZÜNÜRLÜK feda edilerek ödenir — yani düzeltmeye çalıştığımız grenin DAHA FAZLASI. Karar ölçüme bağlandı: gerçek cihazda `getStats` (`qualityLimitationReason`, `encoderImplementation`, tutulan `frameWidth`/`framesPerSecond`) VP9'u kaldırdığını gösterene kadar mobil VP8'de kalır. Bitrate tablosu VP9 için kalibre olduğundan mobil aynı tavanda VP8'in ~%30-50 daha düşük verimini yer — bu bilinen bir açık, capture kısıtı native patch'le çözülünce yeniden değerlendirilecek. Mobilin VP9'a itilmediği testle pinli (`screen-share-encoding.test.ts`: `publishDefaults.videoCodec` tanımsız kalmalı); masaüstünün VP9'da kaldığı da ayrıca pinli (`packages/media/src/__tests__/desktop-publish-shape.test.ts`). |
| NSFW kanal sistemi (kanal tipi + 18+ yaş kapısı + medya upload gating) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120 mobil parite. channels.nsfw (mig 0018); kanal oluştur/ayarlar toggle + liste 18+ işareti; 18 altına sert blok, 18+ ilk-giriş onayı (per-kanal). Kapı akışı 2026-07-27'de yerinde doğrulamaya geçti — alttaki "Yaş doğrulama akışı" satırı. Otomatik içerik taraması pluggable seam + tek env flag (MEDIA_MODERATION_MODE=off, fail-open) — founder kararı: güçlü sunucuya geçince açılır. |
| Doğum tarihi + isAdult (kayıtta + ayarlarda set-once) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120. users.birthdate (mig 0018); register alanı + ayarlarda set-once (409 BIRTHDATE_LOCKED); isAdult me-only türev, NSFW kapısını sürer. Pre-M15 hesaplar ayarlardan bir kez set eder. |
| Yaş doğrulama akışı: kapıda YERİNDE doğrulama + tek seferlik hatırlatma | ✅ | ✅ | Founder (2026-07-27): "nsfw görüntülemeden önce doğrulasınlar" — prod'da 23 kullanıcının 21'inde doğum tarihi yok. **Kapı artık ayarlara göndermiyor**: `NsfwChannelGate` üç aşamayı `nsfwGateStage` (client-core, saf + 16 test) ile türetiyor — `verifyAge` (tarih yok → yerinde giriş), `minorBlocked` (tarih VAR + 18 altı → kalıcı red, GİRİŞ ALANI YOK; set-once olduğu için çalışmayacak kontrol gösterilmez, §35), `confirmAdult` (18+ ilk-giriş onayı). Kaydetme `me` cache'ini tazelediği için kanal **yeniden yükleme olmadan** açılır. **Yanlış tarih koruması:** tek tık yerine iki adım — `BirthdateVerification` girilen tarihi VE ürettiği yaşı geri okutur ("07.03.2000 — 26 yaşındasın, doğru mu?"), 18 altı çıkarsa sonucu YAZMADAN ÖNCE söyler; aynı bileşen ayarlar panelinde de kullanılıyor (artık profil Save'ine binmiyor). 409 `BIRTHDATE_LOCKED` tipli koda alındı → her iki istemcide bespoke kopya (`errors.birthdateLocked`), "tekrar dene" izlenimi yok. **Proaktif hatırlatma bloklamaz:** masaüstü/web'de sol-alt kapatılabilir pill (`AgeVerifyPrompt`, indirme pill'iyle aynı fixed yığın → sohbeti hiç itmez), mobilde Home panelinde ince şerit (`AgeVerifyBanner`, ConnectionBanner'ın yanı); bir kez kapatılınca HESAP BAZINDA kalıcı olarak gider (`age-prompt-store`, desktop localStorage / mobil SecureStore). Mobil saf RN + mevcut `expo-secure-store` → **OTA-safe**. |
| Profil banner (gif/foto upload + yükseltilmiş height) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120. users.banner_url (mig 0018); POST /users/me/banner (base64, ≤5MB, gif+statik, "avatars" bucket, bucket yoksa 503). ProfileCard banner 76→120px + hover→kalem→ayarlar. |
| Hesap silme (kalıcı: 14 gün dondur → otomatik purge/anonymize) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120 (backend ortak, hazır). softDelete deleted_at/purge_at (mig 0018); login `ACCOUNT_FROZEN`→reactivate; saatlik purge job PII'yi anonimleştirir (FK bütünlüğü için tombstone, fiziksel satır silme değil — founder'a not). Masaüstü Danger Zone onaylı UI. |
| Google ile giriş butonu (bayrak kapalıyken YOK) | ✅ | ✅ | #120. VITE_GOOGLE_AUTH_ENABLED / EXPO_PUBLIC_GOOGLE_AUTH_ENABLED (default false). **M16:** bayrak kapalıyken buton HİÇ çizilmiyor (eskiden gri + "yakında" — ölü kontrol, §35); masaüstü M16 kabuk dalı ve mobil `feat/m16-mobile-shell` aynı kural. Mobilde istemci OAuth akışı YOK (`GoogleButton` `onPress` almadan çizilmez) → bayrak o akış gelmeden açılmamalı. |
| Ayarlar: birleşik profil + web responsive full-page + z-index fix | ✅ | — | Web dar viewport'ta (≤899px) modal yerine full-page master/detail; Hesabım+Profil tek panel; çıkış footer'a; sidebar z-index düzeltildi. Mobil native ayarlar ayrı (mobil zaten full-screen). |
| Offline presence rengi (dolu) + otomatik idle (inaktivite→boşta) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120. Offline/invisible rozet dolu (eskiden saydam→avatar sızıyordu). Otomatik idle: ~5dk hareketsiz→boşta, manuel dnd/invisible/idle'ı ezmez; reconnect'te effective status. Eşik TEK sabit: `stores/idle-auto.ts` → `IDLE_THRESHOLD_MS`. |
| Otomatik idle — ölçüm kaynağı: SİSTEM GENELİ hareketsizlik | ✅ | ◑ | Founder P0 fix: eşik `window` olaylarıyla ölçülüyordu, yani yalnız Demli penceresi odaktayken. Başka uygulamada (tarayıcı/oyun/editör) çalışan kullanıcı 5dk'da yanlışlıkla "boşta" oluyor, dönünce Demli'ye tıklamadan geri gelemiyordu. Artık main process ölçüyor: `powerMonitor.getSystemIdleTime()` + `lock-screen`/`suspend` (anında boşta) ve `unlock-screen`/`resume` (saati yeniden okur — kimsenin olmadığı bir uyanma boşta kalır). Renderer'a yalnız `{idle, reason}` gider (`window.demli.systemIdle`, zod+sınırlı `thresholdMs`); ham süre main'de kalır. WEB'de `powerMonitor` yok → mevcut DOM tabanlı yol **fallback** olarak korunur (yüzeyin gerçek sınırı), masaüstünde watcher kurulamazsa da aynı yola düşer. Mobil karşılığı **AppState** (background/inactive) — kavramsal olarak "cihaz-geneli hareketsizlik" değil, uygulama-geneli; RN'de OS idle saati yok, gerçek parite native modül ister → ayrı takip. |
| Otomatik idle sesli odada da geçerli | ✅ | ✅ | Bilinçli karar: rozet "klavyenin başında değil" demek ve bu doğru; işlevsel hiçbir şeyi sürmüyor (yalnız `dnd` bildirim/çağrı geçitler). Odada kimin gerçekten orada olduğunu ses paneli (mic/konuşma göstergesi) söyler. Bastırmak `idle-auto`'yu voice-store'a (ve LiveKit modül grafiğine) bağlardı — boot yolundaki bir store için kötü takas (§23/§27). |
| Avatar foto upload (link→dosya, "avatars" bucket) | ✅ | ✅ | mobil OTA yayınlandı (emülatör runtime bekliyor) · #120. SUPABASE_AVATAR_BUCKET=avatars canlı; POST /users/me/avatar (base64, ≤2MB, NSFW seam her zaman tarar ama flag-off=fail-open). |
| Profil değişikliğinin CANLI yayılması (`user.updated`) | ✅ | ✅ | Founder P0: avatar değişince karşı tarafın üye listesinde eskisi kalıyordu. Yeni tipli olay `user.updated` (payload = PUBLIC `User` DTO; `userSchema` me-only alanları — friendCode/birthdate/isAdult — şerit üstünde SİLER). PATCH /users/me + POST /users/me/avatar + /banner yayınlar; gateway kullanıcı-kapsamlı mutasyonu `presenceAudience` (ortak grup üyeleri ∪ kabul edilmiş arkadaşlar) + kendi oturumlarına genişletir, ilgisiz kullanıcı ALMAZ (int test). İki platform da kullanıcı dizinini + sunucu/grup rosterını + arkadaş/DM cache'ini yerinde yamalar (setQueryData, §27) ve profil kartını invalidate eder; kendi hesabımızın olayı auth-store'a MERGE edilir (me-only alanlar düşmesin). Mobil: `apps/mobile/src/realtime/connection.ts` → `applyUserUpdate`; `upsertUsers` artık bio/bannerUrl değişimini de görüyor (yoksa profil kartı bayat kalırdı). |
| Üye listesi / mesaj satırı avatar FOTOĞRAFI | ✅ | ✅ | Masaüstünde ayrı bir hata olarak bulundu: `MemberSidebar`/`MessageRow` `UserAvatar`'a `src` HİÇ geçirmiyordu ve `ShellMember`'da `avatarUrl` alanı yoktu → roster herkesi baş harflerle çiziyordu. `ShellMember.avatarUrl` + `MessageRowServices.useAvatarUrl` eklendi. **Mobilde bu boşluk yoktu** (denetlendi): üye listesi (`ServerChannelList`), mesaj satırı (`MessageBubble`), DM satırı (`DmRow`), grup-sohbet rosterı, `PersonRow` ve `member-roles` zaten `uri={…avatarUrl}` geçiyor — tek eksik canlı tazelemeydi, o da üstteki satırla kapandı. |
| Avatar FOTOĞRAFI her yüzeyde (sesli oda + çağrı dahil) | ✅ | ✅ | Founder P0: "sesli odada avatar gelmiyor". 76. satırdaki düzeltme yalnız iki bileşeni yamamıştı; tarama 35 `<UserAvatar>` çağrısının **20'sinin** `src` geçmediğini gösterdi (sesli oda satırı, sahne tile'ı, kamera tile'ları, tüm çağrı yüzeyleri, hesap değiştirici, DM listesi, pin/arama). Kök sebep tek tek unutkanlık değil, **opsiyonel prop**: geçilmeyince sessizce baş harf çiziliyor, hata hiçbir yerde görünmüyordu (aynı sınıf üçüncü kez bildirildi). `UserAvatarProps.src` artık **zorunlu** (tipi `string \| null \| undefined` kalıyor, ama `?` yok → TS varlığını şart koşuyor), yani unutmak derleme hatası. 18'i gerçek avatara bağlandı; eksik alanı olan iki DTO'ya alan eklendi (`ShellDmRow.participantAvatarUrl`, `MentionCandidate.avatarUrl` + `ComposerDirectoryUser.avatarUrl`). Kalan 2'si gerçekten avatarsız dal (`UserFooter` oturum-kapalı, `AvatarLightbox` `url==null`) ve `src={null}` gerekçesiyle `avatar-src-coverage.test.ts`'te sabitlendi. **Mobil ikizi de KAPANDI (2026-07-28, aynı yapısal düzeltme):** `Avatar.uri` de opsiyoneldi; 32 çağrının 28'i doğruydu, eksik 4'ü tam da founder'ın şikâyet ettiği yüzeylerdi — `voice/ParticipantTile.tsx` (sesli oda + çağrı ızgarası, ekran-paylaşımı filmstribi, tam ekran), `voice/VoiceParticipant.tsx` (oda satırı + paylaşım çipi), `voice/DraggableCameraPip.tsx` (aktif konuşmacı PiP), `Composer.tsx` (bahsetme listesi). `uri` artık **zorunlu** (`string \| null \| undefined`, `?` yok). Sesli yüzeylerde avatar `nameFor` ile **birebir aynı** çözümleme merdiveninden geçen yeni `avatarFor` ile bulunuyor (grup rosteri → DM peer → kullanıcı dizini), yani adı görünebilen bir katılımcının fotoğrafı da her zaman görünür; DM aramada peer çoğu kez kullanıcı dizininde OLMADIĞI için ızgara boş baş harf çiziyordu — asıl kök neden buydu. `ParticipantTileData.avatarUrl` + `PipSubject.avatarUrl` alanları eklendi (ara bileşenler prop'u açıkça geçiyor). Tek gerekçeli `uri={null}`: `member/AvatarLightbox.tsx` (fotoğrafı olmayan dal). Kalıcı koruma: `apps/mobile/src/components/avatar-uri-coverage.test.ts` (masaüstündeki `avatar-src-coverage.test.ts` deseni — mutasyon testiyle gerçekten kırmızıya döndüğü doğrulandı). |
| Konuşma parıltısının kırpılmaması (ızgara + Watch Party filmstribi) | ✅ | — | Founder: "gradyanlı parlayan borderlar kırpılıyor". Kaydıran kap `overflow-y-auto` idi; CSS `overflow-x`'i de `auto` yapar, yani kap **dört yandan** kırpar → konuşan tile'ın turuncu halosu ızgaranın üst kenarında ve en dış sütunlarda düz kesiliyordu. Kaba padding vermek çözüm DEĞİL (padding scrollport'un içi: tile'lar kırpılmak yerine araç çubuğunun üstüne taşardı). Parıltı artık tile'ın **içine** çiziliyor (`inset` box-shadow + `ring-inset`), dolayısıyla kırpılacak bir şey kalmıyor — her tile sayısında, her kapta, her pencere genişliğinde. Dışarıda kalan tek katman siyah yükseklik gölgesi (koyu sahnede kırpılması görünmez). 4 tile: `AvatarTile`/`CameraTile`/`LocalCameraTile`/`ScreenShareTile`; koruma `tile-glow-inset.test.ts`. Playwright ile üç yerleşimde (sabit ızgara, kaydıran ızgara, filmstrip) 1400px ve 900px'te, pulse'ın en geniş karesi donduruldu: 22 tile'ın tamamında renkli katmanlar `inset`, kaydırma çalışıyor. Mobil ayrı renderer (bu CSS yok). |
| Profil ayarlarında "kaydet'e basmadan kaydedilmez" taslak akışı | ✅ | ✅ | Founder kuralı: avatar/banner seçimi artık ANINDA yüklenmiyor; taslak olarak yerel önizlenir (`data:` URI, sıfır istek), tek "Profili kaydet" ile (görseller → ad/bio → set-once doğum tarihi, ayrı istekler) uygulanır — 409 BIRTHDATE_LOCKED ad/bio kaydını düşürmez. Kısmi başarısızlık dürüst raporlanır (başarılı adımın taslağı temizlenir, başarısız olan retry için durur). "Vazgeç" butonu + kaydedilmemiş-değişiklik uyarısı: masaüstünde Esc/backdrop/bölüm-değiştirme (ui-store `settingsDirty`/`pendingSettingsNav`), mobilde `beforeRemove` (başlık oku + Android geri tuşu + geri hareketi). Hesap silme guard'ı iki platformda da bilerek atlar. Mobilde ölü "Doğum tarihini kaydet" butonu kaldırıldı (§35). |
| Mesaj listesinde gün ayraçları (Bugün / Dün / tarih) | ✅ | ✅ | M16 Dalga 3 sohbet. Ortak `buildRows` `dateDividers` seçeneği (yerel gün; geriye düşen iyimser gönderi ikinci ayraç/çift anahtar üretmez; yok sayılan kişi katlaması gece yarısında bölünür). Etiket uygulama dilinde (`Intl`, `i18n.language`). |
| Boş composer'da ↑ = son mesajını düzenle; düzenleyici kapanınca odak composer'a döner | ✅ | — (dokunmatikte ↑ yok; mobilde uzun bas → Düzenle) | Modül yayıcılarıyla (`data/edit-request.ts`), sanallaştırılmış listede satır pencere dışındaysa önce kaydırır. |
| DM'de engellediğin kişiye composer yerine dürüst durum + "Engeli kaldır" | ✅ | ✅ | Yalnız GÖRÜNENİN kendi engeli bilinir (karşı tarafın engeli asla gösterilmez). "Engeli kaldır" profil kartıyla aynı tek onay diyaloğunu açar (tek akış kuralı). DM listesi önbellekten okunur (aynı sorgu tanımıyla devre dışı bir gözlemci — `skipToken` paylaşılan sorgunun fn'ini silip her DM-listesi invalidasyonunu bozuyordu; ek istek yok); engel listesi yalnız DM açıkken çekilir. |
| Görsel görüntüleyici: yakınlaştır/kaydır, mesajdaki görseller arasında gezin, klavye | ✅ | ✅ | Tekerlek (imleç altında), çift tık, −/+/sığdır, + − 0 ve ok tuşları, sürükleyerek kaydırma, "2 / 3" sayacı; kaydet/kopyala düğmeleri korunur. |
| Çoklu görsel = eşit kare ızgara (2/4 → 2 sütun, diğerleri 3) | ✅ | ✅ | Hücre boyu yalnız sayıdan hesaplanır → satır yüksekliği bayt yüklenmeden kesin (§27). |
| Composer: karakter sayacı (son 200), yükleme yüzdesi çubuğu (`progressbar`), bahsetme listesi `aria-activedescendant` | ✅ | ✅ |  |
| Boş DM / grup sohbeti karşı tarafla açılır (avatar + ad, "#" yok) | ✅ | ◑ | M16 Dalga 3 denetim düzeltmesi. DM ve grup sohbeti kişinin/grubun adını taşıyan gizli akış kanalı üzerinde çalıştığı için eskiden "#Can kanalına hoş geldin" yazıyordu. `ChatData.intro` (`dm` / `groupChat`); sunucu kanalı değişmedi. Mobil eksik: grup sohbetinin boş durumu hâlâ genel metin. |
| Görselin baytları gelmezse dürüst hata + yeniden imzalayan "Yeniden dene" | ✅ | ✅ | İmzalı URL çözülüp baytlar düşerse (süresi dolmuş imza, 403/404, kopan bağlantı) karo sonsuza kadar nabız atıyordu. Artık hata karosu; yeniden deneme önbellekteki URL'yi atıp yeniden imzalatır. |
| Kendi gönderdiğin mesaj tek satırda onaylanır (varış hareketi bir kez) | ✅ | ✅ | Onaylanan mesaj iyimser satırın anahtarını (`renderKey`) korur; yankı ile önbellek güncellemesi arasındaki tek karede satır kaybolmaz. |
| Eski sayfa yüklenirken ekrandaki mesajlar yerinden oynamaz | ✅ | ✅ | Sabit yükseklikli yükleme satırı eklenirken telafi edilir; sayfa gelince en üstteki mesaj satırına göre, boyamadan önce (layout effect) yeniden çapalanır. |
| Avatar + banner KIRPMA editörü (daire / 8:3 maske, sürükle + tekerlek/pinch + kaydırıcı + klavye, sıfırla, canlı kart + mesaj önizlemesi) | ✅ (YAYINLANMADI, dal `feat/m16-ui-profile`) | ✅ | Masaüstü+web tek renderer. Dışa aktarım 512² / 1200×450 WebP (küçük kaynak büyütülmez), sunucu sınırları altında; EXIF kanvas turunda düşer. Hareketli banner: "hareketli kalsın" (özgün bayt, kırpmasız) ya da "kırp, hareketsiz olsun". GIF avatar: ilk kare, editör bunu söyler. Mobil şu an kırpmasız seçiyor (`expo-image-picker`). |
| Profil ayarları: canlı kart önizlemesi + yapışkan "kaydedilmemiş değişiklik" çubuğu (adımlı kayıt, yalnız kalanı tekrar dene, Ctrl/⌘+S) | ✅ (YAYINLANMADI) | ✅ | Adım sayacı GERÇEK istek sayısıdır (avatar → banner → profil); bayt bazlı yükleme yüzdesi YOK — yükleme `client-core` `fetch` ile gidiyor, ilerleme olayı vermiyor. |
| Avatar / banner KALDIRMA | ✅ (YAYINLANMADI) | ✅ | Kaydet'e kadar taslak ("Kaldırmaktan vazgeç" aynı düğmede). `PATCH /users/me {avatarUrl / bannerUrl: null}` — API zaten kabul ediyordu. |
| Moderasyon onayları: at / yasakla / zaman aşımı (sonuç listesi, tehlike işareti; saf onaylarda odak İptal'de) | ✅ (YAYINLANMADI) | ◑ | Zaman aşımı artık alt menüden ANINDA değil; süre + bitiş saati + isteğe bağlı sebep soran diyalogla. Mobil süreyi zaten sheet'te soruyor (`MemberActionSheet` timeout modu); sonuç listesi Dalga 4. Mobil eksik: sonuç listesi yok; zaman aşımı hazır süresi onaysız uygulanıyor; yasaklama sebebi alanı yok. |

## Süreç

1. **Delegasyon anında**: Kullanıcıya görünen iş içeren her ajan brief'i "platform kapsamı"
   satırı taşır (yalnız masaüstü / yalnız mobil / ikisi). Tek platformsa Director aynı anda
   diğer platform görevini açar ya da satıra ⛔+görev yazar.
2. **Merge anında**: Director bu dosyayı günceller (ajan raporundaki kapsamla karşılaştırır).
3. **Yayın anında**: release-check bu matristen "yeni ⛔ var mı, görevi açık mı,
   founder biliyor mu" kontrolü yapar.

## DM Aramaları (ADR 0012 — 2026-07-17, 8 dalga)

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| DM 1-1 sesli/görüntülü arama | ✅ | ✅ | header sesli+görüntülü buton; mutual-friend gate |
| Gelen arama (zil + kabul/görüntülü/reddet) | ✅ | ✅ | global overlay her ekranda; masaüstü native bildirim+pencere-raise; mobil in-app zil + push deep-link |
| Arama-içi sahne (kamera odak/tam-ekran/PiP/ekran-paylaşım) | ✅ | ✅ | video-layout sahnesini yeniden kullanır (call room = voice room). **W3 (2026-07-30) bunu iddiadan gerçeğe çevirdi:** mobilde iki ekran aynı BİLEŞENİ değil, yalnız aynı yapı taşlarını paylaşıyordu — tile kurucu `InCallView`'da ve `VoiceRoomScreen`'de 18 satır kopyala-yapıştırdı, kabuk ayrı kuruluyordu, bu yüzden sahne barı yalnız çağrıda / ses rotası ve volume sheet yalnız odada vardı. Artık tek kabuk `components/voice/VoiceStage.tsx` (iki ekran da onu render ediyor) + tek tile kurucu `use-stage-tiles.ts` (o da `@demli/media`'nın `buildTiles`'ını tüketiyor). Ekranlarda yalnız gerçekten kendilerine ait olan kalıyor: çağrının küçült/kişi-ekle başlığı, odanın kanal başlığı + sohbet görünümü + watch party (slot olarak geçiliyor). |
| 3. kişi → kesintisiz grup yükseltme | ✅ | ✅ | oda-rebind (channels.livekit_room=call room) → sıfır reconnect; DM geçmişi gizli kalır |
| Single-session (tek aktif oturum) | ✅ | ✅ | recordAndEvict aynı Redis key; call room da dahil |
| DM sistem mesajları (@sys:call_*) | ✅ | ✅ | dil-nötr token → istemci mm:ss/reddedildi/iptal çevirir |
| **Arama bir ODADIR: koltuk modeli (ADR 0023 W1+W2+W4)** | ✅ | ✅ | Founder model beyanı: "sesli arama … sunucudaki sesli oda gibi çalışmalı … mobilde ayrıl butonuna basıp bu süre içerisinde masaüstünden o call'a katılabilmeliyim". **SUNUCU (W1) iki platforma da hizmet ediyor:** `GET /dm-calls/active` artık `inRoom: boolean \| null` döndürüyor — LiveKit'ten okunan, YALNIZ kendi identity'n; ulaşılamayan medya düzlemi `null` ("bilinmiyor"), asla `false` (yanlış `false` telefonu odadan attırır, yanlış `null` bir tık'a mal olur). `call.ended` artık `hangup`/`reject`/`cancel`'da **iki tarafın TÜM oturumlarına** gidiyor (süpürücü zaten öyleydi). **İSTEMCİ (W2) yalnız masaüstü+web:** `CallState.seat: "here" \| "elsewhere" \| "vacant"`; resync `inRoom !== false` iken **join ETMEZ** (LiveKit çift-kimlik kuralı yüzünden kabul eden telefonu düşürüyordu — canlı hata, yayınlanmadan kapandı); Ayrıl artık yalnız `engine.leave()` (satır yaşar, karşıya `call.ended` gitmez), **son çıkan** `/hangup` çağırır; `voice.session_replaced` artık terminal değil, `seat:"elsewhere"`. Geri-katılma penceresi = süpürücünün `DEFAULT_ALONE_GRACE_MS` (3 dk), süpürücüye dokunulmadı. Yeni endpoint YOK, yeni realtime olayı YOK. **MOBİL (W4) KAPANDI (2026-07-31).** Teşhis doğruydu: paylaşılan `client-core` FSM'ini mobil de tükettiği için `inRoom` kapısı ve `seat` alanı mobilde ZATEN aktifti — eksik olan yalnız arayüzdü, ve client-core'a tek satır eklenmedi (üç madde de tüketim). **(1) Ayrıl≠Bitir:** `InCallView`'in kırmızı düğmesi `controller.hangup()` çağırıyordu — yani telefonda "ayrıl"a basmak karşı tarafın aramasını BİTİRİYORDU ve founder'ın geri-katılma penceresini yok ediyordu. Artık `controller.leaveRoom()`; son-çıkan mantığı bilerek KOPYALANMADI (controller'ın içinde, ikinci kopya iki platformu "satırı kim kapatır"da ayrıştırır). Etiket de düzeldi: çalarken `call.cancel`, odadayken `call.leaveRoom`. **(2) `session_replaced` regresyonu:** artık terminal değil `seat:"elsewhere"` (W2), ama mobilde bandı çizecek yüzey yoktu → `phase==="active"` doğrudan `InCallView`'e gidiyor, kullanıcı **medyasız arama ekranında** ölü kontrollerle kalıyordu (§35) ve ne olduğunu anlamıyordu. `/call` rotası artık `seat !== "here"` iken yeni `SeatAwayView`'i çiziyor. **(3) Band + `joinHere()`:** `elsewhere` → "Başka cihazda aramadasın / Buraya al", `vacant` → "Aramadan ayrıldın / Geri katıl", ikisinde de "Aramayı bitir" erişilebilir; otomatik join YOK (LiveKit çift-kimlik kuralı — konuşan cihazı düşürürdü), yalnız kasıtlı kullanıcı eylemi. Global `CallMiniBar` de artık fazı değil KOLTUĞU raporluyor + kısayol Katıl düğmesi taşıyor (kullanıcı `/call` rotasında değilken koltuk-uzak aramayı gösteren tek yüzey o; "Aramada" demek bu telefon hakkında yalan olurdu). **Metinler masaüstüyle BİREBİR aynı** (`packages/i18n` mobile.json TR+EN; kullanıcı tam da bu anda İKİ cihaza birden bakıyor, farklı kelimeler ürün hatası olurdu) ve bu bir testle sabitlendi — mobil değer desktop değerinden saparsa kırmızı. Koruma: `apps/mobile/src/components/call/seat-model.test.ts` (14 kaynak-değişmez test); **3 mutasyonla kırmızıya döndüğü doğrulandı** — `leaveRoom`→`hangup` (2 fail), koltuk kapısının silinmesi (1 fail), i18n metninin masaüstünden sapması (1 fail). ⚠️ **Cihaz doğrulaması AÇIK:** başka bir ajanın emülatörü çalışıyordu, dokunulmadı — iki-cihaz devir senaryosu (telefonda kabul → masaüstü bandı; telefonda Ayrıl → masaüstünden Katıl) zaten emülatörde tek başına üretilemez. |

**Durum (2026-07-17):** kod tam + client YAYINDA (mobil OTA `19a53af4` + masaüstü 0.0.22) +
**SUNUCU DEPLOY EDİLDİ** (`/dm-calls` prod'da canlı — 401 auth-gate doğrulandı; migration 0011
uygulandı). FCM V1 service account Expo'ya bağlandı. 2-cihaz canlı arama + upgrade doğrulaması
founder testinde. Native CallKit ertelendi.

O tarihte üç boşluk yazılmıştı — **üçü de sonraki düzeltme dalgasında kapandı** (2026-07-30
denetimi): mobil sesli zil `apps/mobile/src/sounds/call-ringtone.ts` + `sounds/ringtone.ts`
(`startRingtone("incoming"/"outgoing")`), busy-overlay `components/call/BusyCallBanner.tsx`
(`IncomingCallOverlay.tsx`'ten sürülüyor), arama geçmişi ekranı `app/(app)/recent-calls.tsx`
(+ `useRecentCalls`, `RecentCallRow`).

## 2026-07-19 — M15 + M17 dalgası

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| Çoklu hesap / hesap değiştirici (ADR 0013 switch-reset) | ✅ | ✅ |
| Aktif Oturumlar ekranı (uzaktan çıkış, hepsini kapat) | ✅ | ✅ |
| Composer taslakları + kalem göstergesi | ✅ | ✅ |
| Fullscreen render-storm fix / kamera katman merdiveni | ✅ (engine ortak) | ◑ | **2026-07-28 düzeltme — "ızgarada kamera bulanık, odaklanınca düzeliyor".** Kök neden katman merdiveni DEĞİLdi: kamera VP9 olduğu için livekit `scalabilityMode: 'L3T3_KEY'` uyguluyor, yani zaten **3 uzamsal katman** (tam / 1-2 / 1-4) var ve `CAMERA_LOW_SIMULCAST_LAYER` yalnız VP8 yedek akışına etki ediyor (docstring buna göre düzeltildi). Asıl sebep ÖLÇÜM: adaptiveStream katmanı `element.clientWidth` (CSS px) × `pixelDensity` ile istiyor; `adaptiveStream: true` bırakıldığında livekit `devicePixelRatio > 2` değilse çarpanı **1** yapıyor — Windows %125/%150, 4K %200, tüm Retina (oran 1.25–2) bu kovaya düşüyor, yani tile'ın gerçek fizikselinin YARISI isteniyor, SFU dürüstçe alt katmanı veriyor, tarayıcı büyütüyor. Odakta tile eşiği aştığı için netleşiyordu — bildirilen belirtinin tam imzası. Düzeltme: `adaptiveStream: { pixelDensity: "screen" }` (masaüstü+web). **Yayıncı uplink'i DEĞİŞMEZ** — SVC tek encode, üç katmanı her hâlükârda üretiyor; değişen yalnız her aboneye hangi katmanın iletildiği. **Mobil parite ÖLÇÜLDÜ, UYGULANMADI (2026-07-28) — cihaz doğrulaması bekliyor.** Ölçüm kesin ve hata mobilde DAHA KÖTÜ: adaptiveStream RN'de de tamamen canlı (`@livekit/react-native` → `VideoTrackElementInfo.onLayout` → `observeElementInfo`), ölçü birimi DP (CSS px'in RN karşılığı) ve çarpan `getPixelDensity()`. livekit'in `getDevicePixelRatio()`'sunun açık bir React Native dalı var (`global.LiveKitReactNativeGlobal.devicePixelRatio` = `PixelRatio.get()`, `registerGlobals()` yazıyor). `adaptiveStream: true` bırakıldığında oran `> 2` değilse çarpan **1**: dPR 2.0 (çok yaygın Android) tam da bu kovaya düşüyor → tile'ın doğrusal YARISI, alanının ÇEYREĞİ isteniyor. dPR 3.0 bile sabit 2'ye takılıyor. `demli-debug` AVD'de ölçüldü: density 240 → dPR 1.5 → 1'e çöküyor (1.5x doğrusal eksik istek). Düzeltme tek satır (`adaptiveStream: { pixelDensity: "screen" }`) ve masaüstüyle birebir aynı; **bilerek uygulanmadı** çünkü founder kuralı mobil medya değişikliğini cihaz/emülatör doğrulaması olmadan yayına sokmuyor. (2026-07-30 notu: gerekçenin ikinci yarısı — "`apps/mobile/android/` yok, çalışır APK kurulamadı" — artık geçersiz; `scripts/build-mobile-apk.sh` (`pnpm package:android`) yerel APK build'ini §32'nin VARSAYILAN yolu yaptı, `android/` yalnız prebuild üretimi olduğu için git'te durmuyor. Kalan tek engel cihaz doğrulaması.) Gerekçe ve ölçüm `livekit-room.ts`'te satır başında yorumda duruyor; cihaz testi yapabilen bir turda tek satır açılacak. **(2026-07-31: UYGULANDI.** Mobil artık `adaptiveStream: { pixelDensity: "screen" }` — masaüstüyle birebir aynı. Ölçüm zaten kesindi ve bekleme gerekçesi cihaz doğrulamasıydı; bu tur ekran-paylaşımı gren düzeltmesiyle aynı native dalgaya bindiği için birlikte gidiyor. Bunun ABONE tarafı olduğuna dikkat: bu değişiklik telefonun NE YAYINLADIĞINI değil, telefonda İZLERKEN hangi katmanı istediğini düzeltir — founder masaüstünde izliyorsa gren şikâyetine etkisi yoktur, o kısım `screenShareSimulcastLayers` düzeltmesidir. Koruma: `src/media/__tests__/screen-share-encoding.test.ts` seçeneği sahte `Room` kurucusundan yakalayıp doğrular, mutasyonla kırmızıya döndüğü görüldü.**) |
| Kamera önizleme akışı (#101: önizle→kamera seç→onayla→yayınla) | ✅ 0.0.37 | ✅ OTA 5c625004 |
| Gömülü DM-arama sahnesi + dock (#104) | ✅ 0.0.38 | — (mobil tam-ekran InCallView aynı işi zaten yapıyor) |
| DM okunmamış rozetleri + Home pill + mute=ses/toast sustur | ✅ 0.0.35 | ✅ (zaten vardı) |
| Arka plandaki cihaza arama zili push'u (notifyAlways + collapseKey geri çekme) | — (masaüstü WS her zaman açık) | ✅ (server-side) |
| M17 link önizleme kartları (embeds_updated fold + §28 düz-metin) | ✅ 0.0.39 | ✅ OTA af770c13 |
| Motor saturasyon fix'i (100Hz VolumeProcessor köprü fırtınası kapalı) | — (etkilenmedi) | ✅ OTA 4ce34e45 |
| M17 mesaj sabitleme (pin) — backend + realtime fold | ✅ | ✅ | Masaüstü PinnedMessagesPanel, mobil PinnedMessagesSheet bağlı (envanter 2026-07-27). |
| M17 offline gönderim kuyruğu (kalıcı, sıralı, 3 deneme) | ✅ | ✅ | İki yüzeyde de outbox store'a bağlı (envanter 2026-07-27). |
| M17 custom emoji (`:isim:`) — backend + tokenizer | ✅ | ✅ | Masaüstü tam (EmojiTab yükleme + picker + render). **Mobil YÖNETİM ekranı da indi** (eski not "yok" diyordu): `apps/mobile/app/(app)/server-emoji.tsx` — `ImagePicker` ile yükleme + `useCreateCustomEmoji`, satır başına yetki-kapılı silme + onay, `INVALID_EMOJI`/`EMOJI_TOO_LARGE`/`EMOJI_NAME_TAKEN` tipli hata çevirisi; giriş `app/(app)/server-settings.tsx`. |

**Sunucu (2026-07-22, M17 kalanı — `feat/m17-rest`):** migration 0016
(`message_pins`, `custom_emojis`); pin uçları (`/channels/:id/pins*`, yetki matrisi:
sunucularda yazar ∨ MANAGE_MESSAGES, DM/grup-sohbetinde her üye — DM'de iki taraf da
`role="member"` olduğu için MANAGE_MESSAGES kontrolü ikisini de reddederdi); emoji
uçları (`/groups/:id/emojis*`, satır-içi base64 + depolama ÖNCESİ sihirli-bayt
doğrulaması). Yeni tipli event'ler: `message.pinned`/`unpinned` (kanal kapsamlı),
`emoji.created`/`deleted` (grup kapsamlı, görünürlük resync'i YOK). O dalgada iki platformun
görsel UI katmanı henüz bağlanmamıştı — parite ikisinde de eşit şekilde eksikti, tek
platforma kayma yoktu. **İkisi de sonradan bağlandı** (bu belgede pin/outbox/custom-emoji
satırları ✅/✅; mobil emoji yönetimi `apps/mobile/app/(app)/server-emoji.tsx`).

**Sunucu (2026-07-19):** unfurl backend (migration 0015 `message_embeds`,
`message.embeds_updated`) + **hotfix 703d6e3** — IP-pinleme lookup shim'i Node≥20
autoSelectFamily sözleşmesi (bu fix'ten önce prod'da hiçbir link kartı üretilemiyordu);
call.invite push `notifyAlways`. Mobil arama matrisi S9-S10 emülatörde kapandı.

## 2026-07-20 — UI Overhaul + Mobil rail+panel kabuğu (masaüstü 0.0.40 · OTA 6b7da115)

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| Yeni tasarım token'ları (GPT mockup: navy rampa + #7379F7 accent, radius 6/9/12) | ✅ @theme | ✅ theme.ts (birebir) |
| Yoğunluk dili (44px satır, 64px başlıklar, 18px mesaj ritmi, 40px avatar) | ✅ | ✅ (kabukta) |
| Global soft geçişler (140ms, reduced-motion korumalı) | ✅ | — (RN'de native nav animasyonları) |
| **Kabuk: rail + panel tek yüzey, sohbet üste push** | zaten böyleydi | ✅ (Sunucular sekmesi kalktı, Arkadaşlar sekmeye terfi) |
| Klavye composer'ı örtmüyor (edge-to-edge ölçülen-yükseklik fix'i) | — | ✅ emülatör-kanıtlı |
| Emoji seçince panel kapanır + modern ek-ekleme bottom-sheet | — (masaüstü zaten sorunsuz) | ✅ |
| VoicePanel'deki gereksiz ses-ayar butonu kaldırıldı | ✅ | — (mobilde yoktu) |
| Unread noktaları: rail sunucu avatarı + DM satırları | ✅ (zaten) | ✅ (yeni) |

## 2026-07-20 gece — P0 gece vardiyası (masaüstü 0.0.48 · OTA bekliyor)

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| **Süreç-başına film sesi** (process-loopback, pencere→PID; kaynak hafızası+anında başlangıç) — M16'da kendi yardımcımız + include/exclude ile değişti, kaynak hafızası kaldırıldı | ✅ 0.0.47 (tarayıcı-ağacı kanıtlı) | — (mobil dinleyici native çalar; #113 açık) |
| Film-sesi teşhis etiketi (panelde süreç/loopback/karışım) + process-audio.log — M16: etiket artık "yalnız uygulama / sistem sesi, Demli hariç / sekme" | ✅ 0.0.48 | — |
| Yayın kalite matrisi 480p→2K × 15/30/60 + bitrate tavanları + motion-hint (ping-spike fix) | ✅ SourcePicker | ✅ ScreenShareQualitySheet |
| Bildirim WhatsApp modeli (arka plan=push, ön plan=bastır) + AppState emisyonu | ✅ (focus/blur) | ✅ (AppState) — sunucu DEPLOY EDİLDİ |
| Ön planda üstten mesaj banner'ı (mute-filtreli, dokun→sohbet) | — (native toast zaten var) | ✅ |
| (N) okunmamış sayaçları + rozetler (dürüst 1+/99+; rail/kanal/DM/Home) | ✅ | ✅ |
| Arkadaş kodu KALKTI → yalnız username (~~tek-tip yanıt~~ → aşağıdaki satır) | ✅ | ✅ (arkadas/[code] zarif düşüş) |

## 2026-07-28 — Arkadaş ekleme: "kullanıcı bulunamadı" + input validasyonu (founder)

| Özellik | Masaüstü/Web | Mobil | Not / Görev |
|---|---|---|---|
| **Olmayan kullanıcı adı → "Kullanıcı bulunamadı"** (`404 USER_NOT_FOUND`) | ✅ | ✅ mesaj çıkıyor | Founder direktifi: tek-tip `200 { ok: true }` (enumeration koruması) TERSİNE ÇEVRİLDİ — yanlış yazan kişi hiç gelmeyecek isteği bekliyordu, gerçek kullanıcılarla bu doğrudan destek yükü. Gerekçe ADR 0010 §6'da (SUPERSEDED bloğu) ve rota yorumunda yazılı. **Artık tek enumeration kontrolü hız sınırı: oturum başına 10 / 5 dk — KALDIRMA, GEVŞETME** (int testi bunu kilitliyor). İlişki durumu hâlâ gizli (`already_pending`/`already_friends` = aynı 200); **blok ve silinmiş hesap da aynı 404** → yoksa "beni engelledi mi" oracle'ı açılırdı (ADR 0017 güncellendi). Mobil kodu değişmedi: `localizeError` zaten paylaşılan `errors.userNotFound` anahtarına düşüyor. |
| **Arkadaş ekle input validasyonu** (uzunluk + grameri, alan altında hata, `aria-invalid`/`aria-describedby`) | ✅ | ✅ (`ca84bf1`) | Founder duran kuralı ("her form element form ile sarılıp valide edilecek"). Kural TEK KAYNAK: `@demli/config` (`USERNAME_MIN/MAX_LENGTH`, `USERNAME_PATTERN`) → `@demli/protocol`'ün `sendFriendRequestByUsernameBodySchema`'sı → sunucu ve form AYNI şemayı çalıştırır, elle yeniden yazılmaz. Bu, "form V1" (config→protocol→client-core `validateForm`→`validation.*` i18n) katmanının **ilk tüketicisi**; react-hook-form/FormProvider deposunda YOK, yeni form sistemi kurulmadı. Baştaki `@` hoş görülür. **Mobil parite KAPANDI (2026-07-28):** `AddTab` artık `apps/mobile/src/lib/add-friend.ts` üzerinden AYNI şemayı çalıştırıyor (kopya değil — iki platform da paylaşılan `sendFriendRequestByUsernameBodySchema` + client-core `validateForm` bağlıyor, yalnız iki app-namespace'li kopya anahtarı farklı). Hata artık form-V1 `FieldError` (anahtar+param) olarak state'te duruyor ve alanın ALTINDA render ediliyor (`TextField.error` prop'u eklendi: kırmızı kenarlık + `aria-invalid` + `accessibilityRole="alert"`), yani dil canlı değişince mesaj da çevriliyor — eskiden çözülmüş string saklandığı için donuyordu. Gönderilen değer şemanın ÜRETTİĞİ normalize handle (trim + baştaki `@` + küçük harf). Testler: `apps/mobile/src/lib/__tests__/add-friend.test.ts`. |

## 2026-07-27 — Film sesi kök-neden turu (3. bildirim; masaüstü yayıncı)

| Özellik | Masaüstü | Mobil |
|---|---|---|
| **Film-sesi kaynağı yayın SÜRERKEN doğrulanır + sıcak takas** (`superviseFilmAudio` + `engine.replaceScreenShareAudio`) — **M16'da sıcak takas KALDIRILDI** (takas edilen karışım girişi aramanın seslerini taşıyordu); denetleyici artık yalnız izler | ✅ | — (mobil yayınlamıyor, #45) |
| "Sesli paylaşıyorsun" iddiası artık ölçülmüş sinyale bağlı; ara durum "ses bekleniyor" (`screenShareAudioLive`) | ✅ | — |
| Process-loopback: "henüz oynatılmadı" (0 bayt) artık ölü kabul EDİLMİYOR; yalnız helper çıkarsa düşülür | ✅ | — |
| Otomatik-oynatma engeli kurtarma (`startAudio` + tek seferlik jest) — web dinleyici sessizliği | ✅ (web build; Electron'da no-op) | — |

Kök neden (kanıtlı, founder makinesinde ölçüldü): film-sesi merdiveni YALNIZ paylaşım
başlarken çözülüyordu, ama kullanıcı önce paylaşımı başlatıp SONRA oynat'a basıyor — o anda
hiçbir kaynak duyulabilir değil. Vendored `ApplicationLoopback.exe` hedef süreç ses akıtmıyorken
sıfır bayt üretiyor (sessizlik dolgusu bile değil: `explorer.exe` → 0 bayt; 5s sonra çalmaya
başlayan oynatıcı → 0 bayt, sonra 5.6s'de tam sinyal). Eski kod bunu "ölü yakalama" sayıp tek
doğru kaynağı atıyor, Voicemeeter uç-noktasına düşüyor (o kutuda kalıcı sessiz), yayınlayıp
"sistem sesiyle paylaşıyorsun" diyordu. Seçim bir daha gözden geçirilmiyordu.

Bilinen boşluklar: #113 mobil film-sesi dinleyici kontrolü (0.0.47 sonrası 2-cihaz testiyle),
2K60'ta izleyici decode uyarısı (değerlendirildi, ertelendi), tek-uygulama ses
İZOLASYONU zaten process-capture ile geldi. **(M16 düzeltmesi: bu cümle eksikti — tüm ekran
paylaşımı ve pencere düşüşleri hâlâ yankılı loopback/karışım girişine gidiyordu; M16 bölümü.)**

## 2026-07-22 — Tasarım Sistemi Derinliği (renk DIŞINDAKİ katmanlar; yayınlanmadı)
Referans block/buzz'ın tasarım dili (Apache-2.0 — **kod kopyalanmadı**, yalnız desen ve
sayısal değerler kendi mimarimize uyarlandı). Renk paleti (Catppuccin Macchiato) 2026-07-21'de
zaten gelmişti; bu dalga onun ALTINDAKİ sistemi kuruyor.

| Katman | Masaüstü | Web | Mobil |
|---|---|---|---|
| Motion rampası (instant 120 / fast 180 / standard 240 / arrival 500 + 2 eğri) | ✅ `--motion-*` + `motion-instant/fast/standard` utility | ✅ `motion` (theme.ts) + `theme/motion.ts` (Easing) |
| Tek düz 140ms'in kalkması (61 `duration-75/100/150/200/300` → rampa) | ✅ | — (RN'de sınıf yok; süreler zaten token'dan okunuyor) |
| Mikro-tipografi rampası 11/10/8 (text-xs altı) | ✅ `text-2xs/badge/3xs` (99 literal) | ✅ `typography.size` (47 literal) |
| Radius tek kaynaktan türetme (10 → sm/md/lg/xl) | ✅ `--radius` | ✅ `RADIUS_BASE` |
| Ara spacing adımı 18px | ✅ `mt-4.5` (Tailwind v4 dinamik ölçeği) | ✅ `space["4.5"]` |
| Yana bakan gölge/kenar sistemi | ✅ `shadow-content-edge`, `shadow-panel-left` | ✅ `elevation.panel/raised` (RN elevation+shadow) |
| Sidebar kenar solması (0.5rem mask) | ✅ `edge-fade-y` (kanal/DM/üye/pin/arama) | — (RN'de CSS mask yok) |
| Kaybolan scrollbar (hover'da beliren thumb) | ✅ | — (Android scrollbar zaten kendiliğinden kaybolur) |
| `content-visibility` (yalnız SANALLAŞTIRILMAMIŞ listeler) | ✅ üye/DM/pin/arama satırları | — (FlatList zaten sanal) |
| Yeni mesaj "arrival" animasyonu | ✅ blur+translateY+opacity | ✅ opacity+scale (ters FlatList Y eksenini çevirdiği için translate yok) |
| reduced-motion saygısı | ✅ global `@media` koruması | ✅ `useReducedMotion()` (AccessibilityInfo) |

Bilinen boşluklar: mobil arrival animasyonu **cihaz/emülatör doğrulaması bekliyor** (yerel APK
Windows MAX_PATH nedeniyle derlenmedi; mobil typecheck + 188 unit test + `expo export` temiz).
`edge-fade-y` masaüstünde derlenmiş CSS'te doğrulandı ama founder'ın mevcut verisiyle hiçbir
sidebar listesi 560px'te (pencerenin min yüksekliği) taşmadığı için ekran görüntüsüyle
gösterilemedi. ChannelItem bilerek `content-visibility` DIŞINDA: okunmamış pip'i satır
kutusunun DIŞINDA (-left-2) duruyor, paint containment onu kırpardı.
## 2026-07-27 — Açılış ekranı (logo + GERÇEK progress bar)

Masaüstü ve web **tek kaynak**: `apps/desktop/src/renderer/src/AppRoot.tsx` artık her iki
`main.tsx` tarafından mount ediliyor, bu yüzden iki yüzey aynı anda geldi.

| Katman | Masaüstü | Web | Mobil |
|---|---|---|---|
| Splash: Demli logosu + progress bar + durum metni | ✅ | ✅ (aynı bileşen) | ✅ `src/components/BootSplash.tsx` (RN portu; eski `BrandSplash` logo+spinner SİLİNDİ — tek splash) |
| İlerleme GERÇEK fazlardan (fontlar → i18n → oturum → sunucular → realtime) | ✅ | ✅ | ✅ `src/stores/boot-store.ts` + `BootPhaseBinder`; fazlar `useAppFonts` / `createI18n` / `auth-store.initialize` / `useGroups` settle / `connectionStatus === "online"` tarafından kapatılır |
| Takılma koruması (4sn "hâlâ deniyor…", 13sn hata + Tekrar dene / Yeniden başlat) | ✅ | ✅ | ✅ aynı eşikler; "Yeniden başlat" = `Updates.reloadAsync()`. Opsiyonel fazlar kendi grace timer'larıyla degrade olur (data 8sn, realtime 4sn), oturum bilindikten 10sn sonra `finishBoot()` her hâlükârda kapatır |
| İlk boyada marka zemini (beyaz flaş yok) | ✅ `BrowserWindow.backgroundColor` + renderer `index.html` inline stil | ✅ `#boot-skeleton` (JS bundle inmeden logo + track) | — (native splash zaten kapsıyor) |

Kural: progress **uydurulmuyor** (CLAUDE.md §35). Çubuk yalnız `stores/boot-store.ts` fazları
gerçekten bittikçe ilerler; oturum açılmamış bir açılışta `data`/`realtime` fazları **düşürülür**
(paydadan çıkar) — %100'e sahte tamamlamayla değil, yapılacak iş kalmadığı için ulaşır.

O tarihte bilinen boşluk: mobilde fazlı progress yok, native splash statik. **Kapandı** —
faz modeli (`BootPhase`) platformdan bağımsız tutulmuştu ve RN'e taşındı:
`apps/mobile/src/components/BootSplash.tsx` + `stores/boot-store.ts` + `BootPhaseBinder`,
hepsi `apps/mobile/app/_layout.tsx`'te mount. (Aynı bölümün tablo satırları zaten M=✅ diyor;
bu cümle onları yalanlıyordu.)

## 2026-07-27 — M18 sunucu yapısı & moderasyon (BACKEND dalgası; UI ayrı dalga)

Bu dalga yalnız **sunucu tarafı** idi: şema (migration 0019), endpoint'ler, tipli protocol
olayları ve testler; o gün iki istemcide de kullanıcıya görünen hiçbir şey yoktu — bilinçli
bir sıralama (kontrat önce, UI sonra).

> **GÜNCEL DURUM (2026-07-30 denetimi):** UI dalgaları O ZAMANDAN BERİ İNDİ. Aşağıdaki
> tablo artık bugünkü durumu gösteriyor; hücreler ⛔'den ✅'e çekildi ve her satırda UI'ı
> taşıyan dosya yazılı. Bu tablo bayat ⛔ tuttuğu için 2026-07-30'da bir ajan M18
> masaüstü arayüzünü "yapılmamış" sandı — kayıt olarak dalganın backend içeriği duruyor,
> ama durum sütunu YALAN SÖYLEMEYECEK.

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| Kanal kategorileri (oluştur/adlandır/sil + kenar çubuğu sıralaması) | ✅ | ✅ | Backend ✅ (mig 0019 `channel_categories` + `channels.category_id`, owner ∨ MANAGE_CHANNELS, `category.created/updated/deleted/reordered`). UI indi — masaüstü/web `renderer/src/components/CategoryDialogs.tsx` + `ChannelItem.tsx`; mobil `app/(app)/category-editor.tsx`, `components/home/CategoryActionSheet.tsx`, `ServerChannelList.tsx` (`renderCategoryHeader`), `stores/collapsed-categories-store.ts`. |
| Kullanıcı engelleme (block/unblock/liste) | ✅ | ✅ | Backend ✅ (ADR 0017, `user_blocks`). Kestiği yüzeyler tam: DM (iki yön, REST+WS), arkadaşlık isteği, mention+kanal push, mesaj arama, ortak sunucu geçmişi (SUNUCU tarafı gizleme), kullanıcı adıyla ekleme, DM çağrısı, grup-DM davet linki. UI indi — masaüstü/web `BlockUserDialog.tsx` + `BlockedUsersSettings.tsx` (SettingsShell'de); mobil `app/(app)/blocked-users.tsx`, `src/lib/block-sync.ts`, `components/member/MemberActionSheet.tsx`. |
| Özel durum (custom status + süre sonu) | ✅ | ✅ | Backend ✅ (`users.custom_status(_expires_at)`, `PUT`/`DELETE /users/me/custom-status`). `User` DTO'da PUBLIC + presence payload'ında canlı delta. UI indi — masaüstü/web `CustomStatusDialog.tsx` + `StatusPicker.tsx` + `ProfileCard.tsx`; mobil `app/(app)/custom-status.tsx`, `app/(app)/(tabs)/you.tsx`. |
| Moderasyon denetim kaydı (kick/ban/unban/voice-disconnect geçmişi) | ✅ | ✅ | Backend ✅ (`moderation_actions`, her aksiyonda yazılır, `GET /groups/:id/moderation-log`, owner ∨ KICK_MEMBERS, sayfalı). UI indi — masaüstü/web `server-settings/ModerationLogTab.tsx` (ServerSettingsDialog sekmesi); mobil `app/(app)/moderation-log.tsx` + `src/lib/moderation-log.ts`. |
| Grup-DM davet linki (üret/listele/iptal + link ile katılma) | ✅ | ✅ | Backend ✅ (mevcut `invites` tablosu ve **aynı** `POST /invites/:code/redeem` yeniden kullanıldı — tek deep-link biçimi). Engellenmiş kullanıcı linkle giremez. UI indi — masaüstü/web `GroupChatInviteDialog.tsx`; mobil `app/(app)/group-chat-invite.tsx` + `group-chat-details.tsx`. |
| **Kanala davet** (davet bir kanalı hedefler; link → sunucuya katıl + o kanala düş; sesli kanalsa sonraki basış odaya girer) | ✅ | ⛔ | Masaüstü/web UI indi (`ChannelInviteDialog.tsx`, `AppShell.tsx`'te mount + `InviteEmbedCard.tsx`); **mobilde hâlâ yok** — mobil davet üretimi `targetChannel` geçmiyor (görev açık). Backend ✅ (mig 0021 `invites.target_channel_id`, `ON DELETE SET NULL`). Link biçimi DEĞİŞMEDİ — hedef satırda taşınıyor, tek deep-link. Yetki: mevcut `invite_policy` kapısı + hedef kanal bu gruba ait olmalı ve **daveti üreten onu görebilmeli** (ADR 0007), ikisi de aynı 400 (kısıtlı kanal varlığını sızdırmaz, §28). Dürüstlük: hedef rol-kısıtlıysa redeem yine başarılı ama `targetChannel: null` — ölü yönlendirme yok (§35). Kanal silinince davet YAŞAR, yalnız hedefsiz kalır. UI dalgası: davet diyaloğunda kanal seçici + kart/redeem sonrası o kanala yönlenme. |
| Moderasyon aksiyonları (kick/ban/unban/voice-disconnect) | ✅ | ✅ | M18 öncesi vardı; davranış değişmedi, yalnız her aksiyon artık denetim kaydına yazılıyor. |

## 2026-07-27 — Rail: sunucu ekle + uygulamayı indir (masaüstü/web dalgası)

Sol rail'in altına iki buton ve üç modal. Masaüstü ve web **aynı** renderer'ı çalıştırdığı
için tek uygulama iki yüzeyi birden kapsıyor; mobil karşılığı **ayrı dalga** (Director
kuyruğunda) — RN rail'i ve modal kabuğu farklı.

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Rail "Bir sunucu ekle" (+) → 3 adımlı Sunucu Ekle modalı (seç → oluştur → katıl) | ✅ | ✅ | ◑ — YETENEK var, kabuk yok: `components/home/ServerRail.tsx` sonundaki "+" → `app/(app)/new-group.tsx`, tek ekranda oluştur **ve** katıl. Eksik olan yalnız 3 adımlı modal akışı. |
| "Bir sunucuya katıl" adımı: davet kodu **ve** `demli://join/<kod>` linki, kabul edilen biçimler ekranda, "Geri" ile seçime dönüş | ✅ | ✅ | ◑ — kod ve link girişi çalışıyor (`new-group.tsx` → `parseInviteCode`, `src/lib/deep-links.ts`: çıplak kod, `/invite/`, `/kat/`, `demli://join/` hepsi geçer). Eksik olan yalnız kabul edilen biçimlerin ekranda LİSTELENMESİ. |
| Katılma hataları dostu (geçersiz kod, süresi dolmuş, hakkı bitmiş, engellenmiş, zaten üye) | ✅ | ✅ | ◑ Mobilde tipli hata çevirisi VAR (`app/(app)/new-group.tsx` → `localizeError`, eşlemeler `src/lib/errors.ts`: `INVITE_EXPIRED`/`INVITE_EXHAUSTED`/`GROUP_BANNED`); eksik olan masaüstündeki 3 adımlı modal kabuğu, hata metinleri değil. |
| Rail "Uygulamayı indir" → platform modalı (Masaüstü / Veya hareket halindeyken) | ✅ | ✅ | ⛔ — mobilde anlamsıza yakın; uygulama-içi güncelleyici zaten var, ayrı dalgada değerlendirilecek |
| İndirme linkleri tek kaynaktan (`lib/download-links.ts`, `VITE_DOWNLOAD_URL_*` ile ezilebilir) | ✅ | ✅ | — |

Dürüstlük (§35): modalda **Windows** ve **Android** gerçek link + aktif buton;
**macOS** derleme hattı yazıldı ama hiç çalıştırılmadı → "Yakında" rozeti + **pasif** buton;
**Linux ve iOS hiç listelenmiyor** (yapılmış bir söz yok), yerine tek satır dipnot açıklıyor.
Matris `apps/desktop/src/renderer/src/lib/download-links.test.ts` ile kilitli:
`availability === "available"` ⇔ gerçek https link.

Şablon kararı: sunucu şablonu ızgarası **konmadı**. Sunucu oluşturma API'si `{ name }`
alıyor, kanal seti üretmiyor; "şablon" adı altında yalnız ad ön-dolduran bir kontrol ölü
affordance olurdu. Backend şablon sağlayınca seçim satırlarının arasına eklenecek.

Not: eski `CreateGroupDialog` (sekmeli oluştur/katıl) yerini `AddServerDialog`'a bıraktı;
komut menüsündeki "sunucu oluştur" / "kodla katıl" girişleri doğrudan ilgili adıma açıyor.

## 2026-07-27 — M18 ARAYÜZ dalgası (masaüstü + web; tek renderer)

Backend dalgası (aynı gün, üstteki bölüm) yalnız kontrat getirmişti; bu dalga onu
kullanıcıya görünür hâle getiriyor. Masaüstü ve web **aynı** renderer'ı çalıştırdığı için
tek uygulama iki yüzeyi birden kapsıyor; **mobil karşılığı ayrı dalga**. Mobil sütunu
dalga dalga doluyor: yapı yarısı (kategoriler + grup-DM davet linki) 2026-07-28'de indi,
kalan satırlar hâlâ Director kuyruğunda.

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Kanal kategorileri: katlanabilir başlık, kategorisiz kanallar üstte | ✅ | ✅ | ✅ |
| Kategori oluştur / yeniden adlandır / sil (onaylı) | ✅ | ✅ | ✅ |
| Sürükle-bırak: kanalı kategoriler arası taşı + kategori sırası | ✅ | ✅ | ➖ — telefonda sürükle-bırak yok; karşılığı alttaki menü satırı |
| Dar viewport alternatifi: "yukarı/aşağı taşı" + "kategoriye taşı" menüsü | ✅ | ✅ | ✅ — mobilde tek sıralama yolu bu |
| Kategori başlığında "+" → o kategoride kanal oluştur | ✅ | ✅ | ✅ |
| `category.created/updated/deleted/reordered` → canlı güncelleme | ✅ | ✅ | ✅ |
| Engelle / engeli kaldır (profil kartı + üye bağlam menüsü, onaylı) | ✅ | ✅ | ✅ profil kartı banner düğmesi + üye eylem sayfası, `Alert.alert` onaylı |
| Ayarlar → "Engellenen kullanıcılar" listesi (kaldırma butonlu) | ✅ | ✅ | ✅ `blocked-users.tsx` (Ayarlar → Hesap), onaylı kaldırma |
| `BLOCKED` hatasına dostu, **yön sızdırmayan** mesaj (DM aç/gönder, arkadaşlık, çağrı, gruba ekle) | ✅ | ✅ | ✅ `lib/errors.ts` `BLOCKED → errors.blocked` (nötr metin) |
| `user.blocks_updated` → blok/profil/arkadaş/DM/mesaj cache resync | ✅ | ✅ | ✅ anahtar kümesi artık tek kaynak: `lib/block-sync.ts` (mutasyon + realtime aynı listeyi geçersizler) |
| Özel durum: metin + süre (30dk / 1sa / bugün / süresiz) + temizle | ✅ | ✅ | ✅ `custom-status.tsx`; süre mantığı `client-core/custom-status.ts` (tek kaynak) |
| Özel durum profil kartında ve üye listesinde adın altında | ✅ | ✅ | ✅ profil kartı + sunucu üye listesi (durum, rol satırının yerini alır) + Sen sekmesi kimlik kartı |
| Moderasyon denetim kaydı sekmesi (sayfalı, owner ∨ KICK_MEMBERS) | ✅ | ✅ | ✅ Sunucu ayarları → "Denetim kaydı" (`/moderation-log`), sonsuz liste |
| Grup-DM davet linki: oluştur / kopyala / iptal (iptal owner-only) | ✅ | ✅ | ✅ — ayrıca yerel paylaşım sayfası |
| Katlanmış kategoriler cihazda kalıcı (sunucu bazlı) | ✅ localStorage | ✅ localStorage | ✅ SecureStore (yeni native bağımlılık yok) |

### 2026-07-28 — M18 yapı yarısının MOBİL paritesi
Kategoriler ve grup-DM davet linki mobile indi (`app/(app)/category-editor.tsx`,
`components/home/CategoryActionSheet.tsx`, `app/(app)/group-chat-invite.tsx`). İki not:
- **Tek kopya kuralı.** Kenar çubuğu yerleşim modeli (`buildSidebarBuckets`,
  nudge'lar, `toReorderPayload`) `@demli/app-ui`'dan
  `packages/client-core/src/channel-order.ts`'e taşındı; app-ui artık yalnız
  re-export ediyor (masaüstü importları ve 34 testi aynen çalışıyor). Sebep:
  app-ui react-dom'a bağlı, React Native onu import edemiyordu — mobil ikinci bir
  yoğun-pozisyon aritmetiği kopyası yazmak zorunda kalacaktı. Menü görünürlük
  kuralları (`categoryMenuItems`, `channelPlacementMenuItems`) ve grup-DM davet
  kuralları (`canRevokeGroupChatInvite`, `inviteUsage`) da orada.
- **Davet linki biçimi farkı (açık, takipte).** Masaüstü/web
  `https://app.getdemli.com/invite/<kod>` üretiyor, mobil ise kendi mevcut
  `buildInviteLink`'iyle `.../kat/<kod>` üretmeye devam ediyor. İkisi de **aynı**
  `POST /invites/:code/redeem`'e gidiyor ve her iki ayrıştırıcı ikisini de kabul
  ediyor, yani işlevsel kopukluk yok. Mobili `/invite/`'a almak `app.json`
  intentFilter değişikliği = **native build** demek; OTA gecesinde yapılamaz,
  yoksa mobilden paylaşılan linkler kurulu uygulamayı açmayı bırakır.

**Mobil parite dalgası (2026-07-28) — kişiler/moderasyon yarısı.** Kategoriler ve grup-DM
davet linki satırları hâlâ ⛔ (ayrı dalga). Bu dalgada taşınan **paylaşılan kural**:
özel durum süre-sonu mantığı artık `packages/client-core/src/custom-status.ts`
(`customStatusExpiryMinutes` / `buildCustomStatusInput` / `visibleCustomStatus`) —
"bugün" = kullanıcının KENDİ yerel gece yarısı, ve süresi geçmiş bir durum satırı
uygulama açıkken kendiliğinden kaybolur (sunucu zaten okuma anında null'lıyor; istemci
önbelleği için aynı kural). Masaüstü hâlâ `CustomStatusDialog.tsx` içindeki kendi
`minutesFor` kopyasını kullanıyor — davranışsal olarak aynı, ama tek-kaynağa geçiş
`apps/desktop` sahipliği nedeniyle bu dalganın dışında bırakıldı (Director kuyruğu).

## Kullanıcı bağlam menüsü + profil kartı (ADR 0019, migration 0020)

Sunucu ucları 0020 ile zaten canlıydı; bu dalga istemci tarafını bağladı. Menü her
platformda **tek bileşen** (masaüstü/web `MemberContextMenu`, mobil
`MemberActionSheet`) ve görünürlük kuralları **iki istemcinin PAYLAŞTIĞI tek saf
modülde**: `packages/client-core/src/member-menu.ts` (`memberMenuGroups`, 33 testle
kilitli). Yetkisi olmayan kullanıcı yıkıcı maddeleri *devre dışı* görmez, **hiç
görmez** (§35) — ve bu karar platform başına bir kez değil, toplamda bir kez
veriliyor; kural değişince iki taraf birlikte değişir.

> Tek-kaynak borcu KAPANDI: `apps/desktop/src/renderer/src/lib/member-menu.ts`
> artık yalnızca `@demli/client-core`'dan re-export ediyor; kural da metin
> kararı da (Ekle/Düzenle) tek modülde.

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Kullanıcı menüsü: üye listesi, mesaj avatarı **ve adı**, DM başlığı, arkadaş listesi, profil kartı ⋯ | ✅ | ✅ | ✅ mobil: uzun basma → `MemberActionSheet`; DM listesi satırı da (eski `DmActionsSheet` artık aynı menüyü sarıyor, "sohbeti gizle" `footer` yuvasında) |
| Menü dokunmatikte de açılır (uzun basma + kebab; web telefondan giriliyor) | ✅ | ✅ | ✅ mobilde ZATEN uzun basma; profil ekranında banner ⋯ düğmesi |
| **Kendine** ayrı (kısa) menü: profil / bahset / sunucu profilini düzenle / roller / ID kopyala | ✅ | ✅ | ✅ aynı `memberMenuGroups` çıktısı |
| Bahset (@) → açık composer'a `@Ad ` ekler, gönderimde `<@id>`'ye çevrilir | ✅ | ✅ | ✅ mobil seam `src/lib/mention-insert.ts` (message-jump ile aynı emitter deseni); ekleme paylaşılan `applyMentionInsert`ten geçer → token, sınır boşluğu ve `pendingMention` otomatik-tamamlamayla birebir (10 test) |
| Not ekle (256 krk) — **yalnız sana görünür**, ayrı cache anahtarı + kaynak-seviyesi sızıntı testi | ✅ | ✅ | ✅ mobilde de ayrı `user-note` anahtarı; sorgu `!isSelf` ile kapalı ve sheet gövdesi yalnız uzun-bastan SONRA mount olur → roster'da hiç istenmez, kendi menünde hiç istenmez. Ekle/Düzenle etiketi için yalnız VARLIK okunur, gövde menüde asla render edilmez. |
| Arkadaş takma adı (özel, 32 krk) — her yüzeyde geçerli, kişiye bildirilmez | ✅ | ✅ | ◑ menüde yazılıp okunuyor (harita `staleTime: Infinity`, yerinde yamalanır); mobil roster/mesaj satırı adları henüz `resolveUserName`den GEÇMİYOR → takma ad menüde ve menü başlığında görünür, listelerde değil (Director kuyruğu) |
| Sunucu takma adı (herkese görünür, 32 krk) — kendine serbest, başkasına `MANAGE_NICKNAMES` | ✅ | ✅ | ✅ ayrı gizlilik satırı: "bu adı sunucudaki HERKES görür" — özel takma adla karıştırılamaz |
| Ad çözümleme: özel takma ad → sunucu takma adı → displayName (tek fonksiyon, 13 test) | ✅ | ✅ | ◑ mobilde `resolveUserName` menüde ve diyaloglarda kullanılıyor; liste satırlarına yayma açık iş |
| Zaman aşımı: 60sn/5dk/10dk/1sa/1gün/1hafta alt menüsü + erken kaldırma (`KICK_MEMBERS`) | ✅ | ✅ | ✅ mobilde alt-menü ikinci bir ActionSheet; süreler paylaşılan `TIMEOUT_PRESET_MINUTES` |
| Yok say / yok saymayı bırak (blok DEĞİL — sessiz, tek yönlü) | ✅ | ✅ | ✅ satır altında gri ayrım metni ("bildirimleri sussun, mesajları katlansın") |
| Sesli bağlantıyı kes — yalnız kişi gerçekten sesli odadayken | ✅ | ✅ | ✅ occupancy store'dan türetilmiş tek boolean (harita aboneliği değil, §27); mobilde AYRICA onaylı — dokunmatikte yanlış basma daha olası |
| At / yasakla — kullanıcı adını içeren kırmızı madde + onay diyaloğu (yasakta sebep) | ✅ | ✅ | ◑ mobilde ad + kırmızı + `Alert.alert` onayı var; **yasak sebebi alanı yok** (mobilden sebepsiz banlanıyor) — Director kuyruğu |
| Kullanıcı adını kopyala — her zaman en altta, kopyalanacak `@handle` rozetiyle | ✅ | ✅ | ✅ **Founder düzeltmesi (2026-07-28):** satır veritabanı uuid'sini kopyalıyordu; founder'ın "id"den kastı USERNAME idi (uuid bir insana yaramaz — arkadaş ekleme/arama/tanıtma hepsinde kullanılan şey handle'dır). Mobil kapandı: bare `username` panoya gider, rozet tam olarak kopyalanacak metni gösterir, handle bilinmiyorsa satır HİÇ çizilmez (§35). Cihazda doğrulandı (yapıştırma). **Masaüstü+web de KAPANDI** (2026-07-30 denetimi; bu not "AÇIK" diyordu): `apps/desktop/src/renderer/src/components/MemberContextMenu.tsx:277` `const handle = nameParts.username`, uuid değil — dosyadaki yorum da iki menünün aynı jestle farklı şey ifade etmemesi gerekçesini yazıyor. |
| `user.nickname_updated` / `member.nickname_updated` / `member.timeout_updated` / `user.ignores_updated` → canlı resync | ✅ | ✅ | ✅ mobil no-op stopgap'leri kaldırıldı: özel takma ad haritası yerinde yamalanır, ignore listesi invalidate, grup-kapsamlı ikisi `groupDetails` invalidate. `user.blocks_updated` de artık gerçek (blok/profil/arkadaş/DM/mesaj cache resync) |
| Yok sayılan yazarın mesajları KATLANIR — ardışık koşu tek yer tutucuda, "Göster"le açılır | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda. Sunucu hiçbir şey gizlemez (ADR 0019 §4), katlama tamamen istemcide. Sanallaştırma güvenliği: yer tutucu HER durumda sabit 32px (`estimateSize` tahmin değil, tam değer) ve hover yalnız RENK değiştirir — hover'da yükseklik değişirse `measureElement` tüm listeyi kaydırır (MessageRow'daki eski hata). Aç/kapa yalnız satır EKLER, yer tutucunun kendi anahtarı/ölçümü sabit kalır. 22 test: `packages/app-ui/src/components/messageRows.test.ts` |
| Yok sayılan koşu ayırıcıları: okunmamış çizgisi, sistem bildirimleri ve normal mesajlar koşuyu böler | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda |
| Zaman aşımı rozeti — üye listesi + mesaj satırı (saat ikonu + "X tarihine kadar susturuldu") | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda. Süre dolunca KENDİLİĞİNDEN kalkar: sunucu gibi sorgu-zamanı karşılaştırması, yüzey başına TEK zamanlayıcı (satır başına değil, §27). 12 test: `packages/app-ui/src/components/memberTimeout.test.ts` |
| Ayarlar → Yok sayılanlar listesi (+ kaldırma), engellenenlerden AYRI bölüm | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda. Farkı açıklayan tek cümle her iki dilde de var (`ignore.settingsVsBlock`) |
| Ayarlar → Özel takma adlar listesi (+ satır-içi düzenle/kaldır) | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda. Satır-içi düzenleme, paylaşılan `friendNickname` diyaloğu z-50'de kaldığı ve ayarlar yüzeyi z-[55] olduğu için (diyalog panelin ARKASINDA açardı) |
| Profil kartı: avatara bas → büyük, yakınlaştırılabilir + kaydırılabilir avatar | ✅ | ✅ | ✅ mobil `AvatarLightbox`: M16 Dalga 4'te Reanimated + gesture-handler'a taşındı (odak noktasında pinch 1–4×, dokunulan yere çift dokun 2.5×, kaydırma taşma sınırına kırpılır, aşağı kaydır = kapat) — kitin native bağımlılıkları nedeniyle 2.1.0 APK döngüsüne bağlı |
| Profil kartı: alttaki mesaj kutusu + emoji seçici → DM'e gider, sayfadan çıkmadan | ✅ | ✅ | ✅ mobil `useSendDmMessage` (DM'i seed eder + gateway'e yeniden el sıkışır + normal outbox'tan gönderir → çevrimdışıysa kuyruğa girer); mevcut `EmojiPicker` yeniden kullanıldı |
| Profil kartı: kendi kartında "Profili düzenle" → ayarların profil paneli | ✅ | ✅ | ✅ mobilde zaten vardı (`/profile` rotası) |
| Profil kartı: banner sağ üstünde İKON eylemleri — arkadaş ekle **veya** arkadaşlıktan çıkar (aynı slot), + engelle (danger) | ✅ | ✅ | ✅ mobilde büyük CTA düğmesi de KALIYOR (telefonda birincil, parmak-boyu hedef); ikon ve düğme aynı handler'ı paylaşır, ayrışamazlar |
| Banner ikonları: tooltip + `aria-label` + yarı saydam koyu zemin (açık banner'da okunurluk) | ✅ | ✅ | ✅ mobilde tooltip yok (dokunmatik) → `accessibilityLabel` kişinin adını İÇERİR; zemin `rgba(0,0,0,0.5)`, danger `rgba(120,20,14,0.72)` |
| Arkadaşlıktan çıkar / engelle **onaylı** ve menüyle **birebir aynı kod yolu** (5 testle kilitli) | ✅ | ✅ | ◑ mobilde ikisi de onaylı ve AYNI i18n kopyasını kullanıyor; kod yolu ortak değil (banner `Alert` + menü `Alert`, iki çağrı yeri) — masaüstündeki tek-diyalog birleştirmesi mobil için açık iş |
| Profil kartı: ⋯ = sağ-tık menüsünün AYNISI (tek bileşen) | ✅ | ✅ | ✅ `insideProfile` ile "Profil" satırı düşer — ekran zaten açık (§35) |
| Profil kartı: not + takma ad arkasındaki gerçek ad gösterimi | ✅ | ✅ | ◑ (Web sütunu ✅ — web masaüstüyle AYNI renderer'ı çalıştırıyor, `ProfileCard.tsx` `noteBadgeText` + `realNameBehindNickname`; yüzeye göre dallanma yok, ◑ yanlıştı.) mobil profil ekranı artık NOTU adın yanında parantezle gösteriyor (`noteBadgeText`, kendi kartında asla); takma-ad-arkası gerçek ad satırı hâlâ AÇIK iş — Director kuyruğu |

### Kullanıcı menüsü — founder saha bulguları (2026-07-28)

Founder yeni menüde altı somut hata bildirdi; hepsi masaüstü/web'de kapandı ve mobil
paritesi de bu dalgada kapandı (emülatörde AVD `demli-debug` üzerinde doğrulandı).

| Bulgu | Masaüstü | Web | Mobil |
|---|---|---|---|
| **Sağ tık → "Profil" hiçbir şey yapmıyordu.** Kök neden Radix odak yönetimi: menü AÇIKKEN odak tuzağı (FocusScope `trapped`) profil kartına giden odağı menüye geri çekiyor, kart da bir dismissable-layer olduğu için "odak dışarı çıktı" sayıp kendini kapatıyordu; kapanışta FocusScope'un `setTimeout(0)` odak-geri-yükleme'si de kartı ikinci kez düşürüyordu. Çözüm: `useActionMenuAfterClose()` — eylem menü kapandıktan SONRA (microtask) çalışır ve o tek kapanışın `onCloseAutoFocus`'u `preventDefault` edilir. Escape/dışarı tık/odak döndürmeyen maddeler eskisi gibi satıra odak döndürür (a11y). | ✅ | ✅ | ✅ RN'de odak tuzağı yok; satır `run()` ile önce sheet'i kapatıp sonra route ediyor (kaynak-invariant testi). Emülatörde açıldı ve açık kaldı. |
| **"Bahset" gerçek bahsetme üretmiyordu.** Masaüstü composer eklemeyi elle yazıyordu (metnin SONUNA ekliyordu, caret'i yok sayıyordu). Artık paylaşılan `applyMentionInsert` (client-core) — otomatik-tamamlamayla aynı yol, caret'e ekler ve `@` öncesi sınır boşluğunu garanti eder. Sınır boşluğu kritik: `selam@Ali` `serializeMentions` tarafından bilerek REDDEDİLİR (e-posta koruması), yani mention sessizce düz metne dönerdi. | ✅ | ✅ | ✅ mobil composer artık paylaşılan `applyMentionInsert`'i çağırıyor; bitişik caret'te `<@id>` ürettiği 6 davranış testiyle kilitlendi (`mention-insert.test.ts`) |
| **"Not Ekle" not varken de "Ekle" diyordu.** Karar paylaşılan `memberMenuEntryVariant()`'ta (client-core); metinler `userMenu.noteEdit` / `friendNicknameEdit` / `serverNicknameEdit`. Menü notun VARLIĞINI okur, gövdesini asla (ADR 0019 §1). | ✅ | ✅ | ✅ `memberMenuEntryVariant()` mobilde de; `mobile:userMenu.{noteEdit,friendNicknameEdit,serverNicknameEdit}` + eşleşen *EditTitle diyalog başlıkları. Menü notun yalnız VARLIĞINI okur. |
| **Not, profilde adın yanında parantezde** — `noteBadgeText()` ile tek satıra indirgenir, 24 karakterde kırpılır (…), tamamı tooltip'te + "sadece sana görünür". Ayrı "Not" bölümü kaldırıldı (tek yer). | ✅ | ✅ | ✅ mobil profil ekranında adın yanında `(not)` — aynı `noteBadgeText()`, tek satır, %45 genişlik sınırı; a11y etiketi "sadece sana görünür" taşıyor. Kendi kartında ASLA (sorgu `!isSelf` ile kapalı + render kısa devre; iki kaynak-invariant testi). |
| **Takma ad silinemiyordu.** Her iki takma-ad diyaloğunda açık "Kaldır" düğmesi; görünürlük KAYITLI değere bağlı (girdiye değil — alanı boşaltınca düğme kaybolduğu için keşfedilemezdi). `friendNickname` diyaloğu artık `current`'ı açıkça alıyor: eski `displayName !== realName` çıkarımı, adı ezenin SUNUCU takma adı olduğu durumda yanlış cevap veriyordu. | ✅ | ✅ | ✅ iki takma-ad editöründe "Takma adı kaldır"; görünürlük KAYITLI değere bağlı, `onSave(null)` gönderiyor |
| **Not silinemiyordu.** Aynı desende açık "Notu kaldır" (`body: null`). | ✅ | ✅ | ✅ mobil not editörü `clearLabel={userMenu.noteRemove}` alıyor |

Regresyon kilidi: `packages/app-ui/src/components/ActionMenu.profile.test.tsx` ve
`MessageComposer.mention.test.tsx` GERÇEK bileşenleri jsdom'da monte edip sonucu
doğruluyor (kart açık kalıyor mu; gönderilen metin `<@id>` mi). Bunlar saf testlerin
yapısal olarak göremediği sınıftandı — ikisi de düzeltmeden ÖNCE kırmızıydı. Ayrıca
`apps/desktop/.../lib/user-menu-wiring.test.ts` kaynak-seviyesinde satır-içi açılışa
geri dönüşü ve notun menüde render edilmesini engelliyor.

**Bilinçli olarak KOYULMAYAN maddeler** (bu kategoride yaygın, bizde karşılığı yok → ölü menü olurdu, §35):
"Uygulamalar" (bot/uygulama sistemimiz yok), "Üyeyi Doğrula" (membership screening yok) ve
**"Mod Görünümünde Aç"** — sunucuyu seçilen rolün izinleriyle *önizleme* modu demektir;
bizde ne izin-önizleme motoru ne de rol-hiyerarşisi var (ADR 0007 bilinçli olarak sade), dolayısıyla
madde tıklandığında yapabileceği gerçek bir iş yok. Bir kapı açılırsa (rol-bazlı görünüm simülasyonu)
ayrı bir dalga olarak değerlendirilir.

**Bu dalganın açık bıraktığı ADR 0019 maddeleri** (Director kuyruğu): yok sayılan yazarın mesaj
satırlarının istemci-tarafı katlanması + aç affordance'ı, zaman aşımı rozetinin roster/profil
kartında gösterimi, ve Ayarlar altında "yok sayılanlar" + "özel takma adlar" listeleri. Menü
maddelerinin hepsi çalışıyor — yok say zaten sunucu tarafında bildirimleri kesiyor — ama görsel
yarısı eksik.

Sıralama kontratı (§35 kritik): `PATCH /groups/:id/channel-order` bir kovadaki
pozisyonları **yalnız listelenen id'ler üzerinden** 0'dan yeniden yazıyor. Bu yüzden istemci,
dokunduğu **her kovanın tam sıralı listesini** göndermek zorunda — yalnız taşınan kanalı
göndermek onu 0'a çekip komşularıyla çakıştırırdı. Kural saf modülde toplandı
(`packages/app-ui/src/components/channelOrder.ts`) ve 34 testle kilitlendi
(`channelOrder.test.ts`).

Yön gizliliği (§28 / ADR 0017): sunucu "ben engelledim" ve "beni engelledi" için **aynı**
`BLOCKED` kodunu döndürüyor. Arayüzdeki hiçbir metin tarafı ya da yönü adlandırmıyor;
bu, TR+EN kopyalar üzerinde regex ile `errors.blocked*` anahtarlarına test yazılarak
kilitlendi (`apps/desktop/src/renderer/src/lib/errors.blocked.test.ts`).

Bilinen boşluk: DM mesaj **gönderimi** WS kuyruğundan geçiyor ve paylaşılan
`OutboxErrorKey` birleşiminde `blocked` üyesi yok (o dosya bu dalganın sınırı dışında).
Kuyruk satırı genel "reddedildi" metnini koruyor; nötr `BLOCKED` gerekçesi kök seviyede
bir bildirimle bir kez veriliyor (`BlockedSendToast`). Kalıcı çözüm client-core outbox
sahibine ait.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Native başlıklar display fontta (Onest; M16 öncesi Space Grotesk) — authed Stack + Tabs `headerTitleStyle` | ✅ (globals.css) | ✅ | ✅ |
| BrandMark bileşeni (sabit sm 40 / md 56 / lg 96 basamakları) | ✅ (demli-logo.svg) | ✅ | ✅ (`src/components/BrandMark.tsx`) |
| Marka işareti: Mesajlar paneli sol üst | ✅ (GroupRail home) | ✅ | ✅ |
| Marka işareti: rail ana giriş tile'ı (jenerik bubble yerine logo) | ✅ | ✅ | ✅ |
| Marka işareti: giriş ekranında gerçek logo | ✅ (AuthScreen) | ✅ | ✅ |
| "Demli v{sürüm}" satırı (Sen sekmesi / ayarlar footer'ı) | ✅ (SettingsShell) | ✅ | ✅ |
| Kanal başlığı: `#`/ses GLYPH'i + display font (emoji/metin-önek değil) | ✅ (ChatView) | ✅ | ✅ |
| DM başlığında karşı tarafın avatarı | ✅ | ✅ | ✅ |
| EmptyState: ikon-daire + başlık + gövde + CTA kalıbı | ✅ (app-ui) | ✅ | ✅ |
| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Davet linki üretimi `https://app.getdemli.com/invite/<kod>` (tek kaynak: `packages/protocol`) | ✅ | ✅ | ◑ — HOST doğru (`apps/mobile/src/lib/deep-links.ts:35` `DEEP_LINK_HOST = "app.getdemli.com"`) ama YOL değil: `:39` `INVITE_PATH = "kat"`, yani mobil hâlâ `.../kat/<kod>` üretiyor. İşlevsel kopukluk yok (aynı redeem ucu, her iki ayrıştırıcı ikisini de kabul ediyor); `/invite/`'a geçiş `app.json` intentFilter = native build. Bu belgede "Davet linki biçimi farkı (açık, takipte)" notu aynı şeyi söylüyor — satır onunla çelişiyordu. |
| Geriye dönük parse: çıplak kod + `/invite/` + `/kat/` + `demli://join/…` | ✅ | ✅ | ✅ (mobil parser zaten son-segment tabanlı) |
| Sohbet içi davet kartı: ikon/ad/çevrimiçi·üye/oluşturulma + Katıl→Katıldın→Git durum makinesi | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda |
| Ölü davet kartı (süresi dolmuş / limit / geçersiz; GROUP_BANNED nötr metinle aynı) | ✅ | ✅ | ⛔ — mobil parite Director kuyruğunda |
| Davet linki için genel unfurl bastırma (kart öncelikli) | ✅ | ✅ | — (mobilde unfurl kartı yüzeyi ayrı dalga) |
| Tarayıcıda `app.getdemli.com/invite/<kod>` (veya eski `/kat/<kod>`) → oturum sonrası katıl adımı ön-dolu + URL temizleme | — (Electron dosya-yüklü) | ✅ | — (mobil kendi `/kat/[code]` rotasına sahip) |
| Görünür metinlerde marka tutarlılığı (davet placeholder'ları TR+EN, masaüstü+mobil katalog); örnekler yalnız `/invite/` gösterir | ✅ | ✅ | ✅ (katalog değişikliği OTA ile gider) |

## 2026-07-27 — Güncelleme rozeti (sağ üst) + rail indirme butonu masaüstünde gizli

Founder isteği: masaüstünde sol alttaki "uygulamayı indir" girişi anlamsız (zaten kurulu);
yeni sürüm gelince sağ üstte **yeşil bir indirme rozeti** çıksın, tıkla → indir, indikten
sonra hover/odak → "Güncel sürüm indirildi" + "Yeniden başlat"; yeniden başlatılmazsa
güncelleme kendiliğinden uygulansın.

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Rail "Uygulamayı indir" butonu | ⛔ **gizli** (zaten kurulu app) | ✅ (değişmedi) | — |
| Sağ üst güncelleme rozeti (yalnız yapacak iş varken görünür) | ✅ | ⛔ (electron-updater yok; köprü `disabled` döner) | — **anlamsız** (mobil dalga kararı 2026-07-27): mobilde güncelleme akışı zaten DAHA güçlü ve otomatik — `UpdateGate` açılışta + her ön plana gelişte OTA kontrol eder (kritikse bloke eden ekran, opsiyonelse `UpdateBanner`), `NativeUpdateGate` + `NativeUpdateBanner` ise APK'yı uygulama İÇİNDE indirip yükler (ilerleme yüzdesiyle). Aynı işi yapan ikinci bir rozet eklemek yeni bilgi vermez, yalnız iki yerden güncelleme öneren bir arayüz yaratırdı. |
| Rozet durum makinesi: yok → var (yeşil indirme) → indiriliyor (%) → indirildi (Yeniden başlat) → hata (Tekrar dene) | ✅ | — | — |
| Yüzde **gerçek** `download-progress` olayından (uydurma ilerleme yok, §35) | ✅ | — | — |
| Panel hover **ve** tıklama **ve** klavye odağıyla açılır; "Yeniden başlat" Tab ile erişilebilir | ✅ | — | — |
| İndirildi + normal çıkış → kurulum çıkışta (`autoInstallOnAppQuit`), sonraki açılış yeni sürüm | ✅ | — | ✅ (OTA/APK kendi akışı) |
| İndirildi + **çökme/zorla kapatma** → sonraki açılışta sessizce kurar ve yeniden açar (`pending-update.json`) | ✅ | — | — |
| Kurulum başarısızsa 2 denemeden sonra manuel akışa döner (açılış döngüsü yok) | ✅ | — | — |

Yüzey tespiti **köprüyle**, UA tahminiyle değil: `apps/desktop/src/renderer/src/lib/surface.ts`
(`appInfo.platform === "web"` ⇒ web; Electron `win32`/`darwin`/… döndürür). Aynı renderer
iki yüzeyi de beslediği için tek bileşen ikisini birden doğru kapsıyor.

Konum kararı: rozet **sabit (fixed) bir kaplama değil**, her yüzeyin başlık çubuğundaki sağ
eylem kümesinin son elemanı (kanal / DM / grup-DM / arkadaşlar / arama geçmişi). Sabit
kaplama üye listesi kapalıyken "üyeleri göster" düğmesinin üstüne binerdi; kümeye girince
hiçbir düzeni bozmuyor ve gerçekten sağ üstte duruyor.

Zorunlu (critical) güncellemeler rozete girmiyor — onları bloklayan `CriticalUpdateOverlay`
sahipleniyor. Giriş ekranında (oturum açılmadan) eski yüzen kart `GlobalUpdateBanner`
korundu; oturum açıkken rozet devraldı, iki kontrol aynı işi yapmıyor.

Karar kaydı testle kilitli: `apps/desktop/src/main/pending-update.test.ts`
(güncelleme kaybolmaz **ve** döngüye girmez).

## 2026-07-27 — M20 sesli kanal metin sohbeti (BACKEND dalgası; UI ayrı dalga)

Model: **her sesli kanalın kendi metin sohbeti var**. Bu dalga yalnız sunucu
tarafı idi — dört yazma kapısı açıldı, okuma yollarında zaten kind kapısı yoktu. O gün iki
istemcide de kullanıcıya görünen hiçbir şey yoktu (kontrat önce, UI sonra), ve **yeni
protocol olayı yok**: `message.created` / `typing.*` / `message.pinned` sesli kanal id'siyle
zaten çalışıyordu, çünkü WS abonelik kümesi (`conn.channelKinds`) sesli kanalları hep
kapsıyordu. İstemcinin ihtiyacı olan tek şey `channel.kind === "voice"` için de sohbet
paneli çizmekti.

> **GÜNCEL DURUM:** UI dalgaları indi — masaüstü/web bu belgede aşağıda "M20 sesli kanal
> metin sohbeti (MASAÜSTÜ/WEB UI dalgası)", mobil "MOBİL dalgası; parite kapandı".
> Hücreler ona göre ✅'e çekildi; sağdaki not dalganın backend içeriğini saklıyor.

| Özellik | Masaüstü | Mobil |
|---|---|---|---|
| Sesli kanalda mesaj gönder/al/kalıcı | ✅ | ✅ | UI: masaüstü `VoiceChannelHeaderControls.tsx` + `lib/channel-actions.ts`, mobil `ServerChannelList.tsx` + `components/voice/voice-channel-nav.ts`; sohbet yüzeyi iki tarafta da kind-agnostik (`lib/voice-channel-chat-wiring.test.ts`). Backend ✅ — REST `POST /channels/:id/messages` ve WS `message.send` artık `isChatCapableChannel(kind)` soruyor (tek tanım: `packages/types`). Okuma/arama/pin/tepki yolları zaten kind-agnostikti. UI dalgası: sesli kanal seçilince sohbet paneli. |
| Sesli kanal sohbetine dosya eki | ✅ | ✅ | Ayrı UI yok, gerekmiyor: composer aynı kind-agnostik sohbet yüzeyinde. Backend ✅ — `POST /channels/:id/attachments/upload-url` sesli kanalı kabul ediyor; NSFW tarama seam'i kanal başına `nsfw` bayrağını okuduğu için kind dalı gerekmedi. |
| Sesli kanal sohbetinde slowmode | ✅ | ✅ | UI: masaüstü `ChannelSettingsDialog.tsx` (voice/text dalı dışında, `slowmodeVoiceNote`), mobil `app/(app)/channel-settings.tsx`. Backend ✅ — `PATCH /channels/:id` `slowmodeSeconds` kabul ediyor; limiter kanal id'siyle REST+WS arasında paylaşılıyor. `maxParticipants`/`audioBitrateKbps` **sesli-özel kalmaya devam** (onlar odayı tanımlıyor, sohbeti değil). |
| Erişim kuralı: kanalı GÖREN yazar (sesli odada olmak şart değil) | ✅ | ✅ | Kural kullanıcıya görünür: sesli kanalın sohbeti odaya GİRMEDEN açılıyor (iki platformda da `voice-channel-chat-wiring.test.ts` bunu kilitliyor). Backend ✅ — ADR 0007 görünürlük sistemi aynen kullanıldı, yeni izin sistemi icat edilmedi. Kısıtlı sesli kanal, rolü olmayan üyeye okuma ve yazmada aynı 404'ü veriyor (varlık sızmıyor). |
| Kesişimler: engelleme · zaman aşımı · NSFW · mention/push | ✅ | ✅ | Aynı kind-agnostik sohbet yüzeyi üzerinden erişilebilir (üstteki satırlar). Backend ✅ — üçü de kind-agnostik çıktı ve **test edildi**: engellenen yazarın mesajı SQL'de geçmiş+aramadan düşüyor (ADR 0017), zaman aşımlı üye sesli kanala da yazamıyor ve tepki veremiyor (ADR 0019), NSFW bayrağı sesli kanalda da taşınıyor, mention/kanal push'u sesli kanal adıyla gidiyor ve göremeyen üyeye gitmiyor. |

Kanıt: `apps/api/src/__tests__/voice-channel-chat.int.test.ts` (8 test, gerçek Postgres) +
`apps/realtime/src/__tests__/gateway.int.test.ts` içindeki sesli-kanal fan-out testi.
Okunmamış SAYACI istemci tarafında `message.created` sayımıdır; sunucu tarafı dayanağı
(eş kopyanın sokete ulaşması) realtime testinde kilitlendi.

## 2026-07-27 — Açılışta otomatik güncelleme (splash içinde indir + uygula)

Founder: *"bilgisayar yeni açılırken her zaman yeni sürüm varsa indirsin loadingde. progress
barın gözüktüğü yerde yeni sürüm indiriliyor desin, güncelleniyor falan otomatik halletsin"* —
ardından netleştirme: *"tabi sadece uygulamanın ilk açılışında olacak"*.
Akış **yalnız soğuk açılışta** (renderer gerçekten yüklenirken, splash ekrandayken) çalışır.
Kullanıcı uygulamanın içindeyken arka planda kendiliğinden indirme YOK — o hâlâ sağ üst
rozetin işi. `autoDownload` bilerek `false` kaldı; indirmeyi başlatan tam iki şey var:
(1) bu açılış akışı, (2) kullanıcının rozete basması. Tepsiye küçültüp geri açmak renderer'ı
yeniden yüklemediği için akış orada tekrar ÇALIŞMAZ (X = çıkış değil, `close-to-tray`).

| Katman | Masaüstü | Web | Mobil |
|---|---|---|---|
| Açılışta yeni sürüm varsa splash içinde indirilir | ✅ | ⛔ (tarayıcı kendini günceller; `lib/surface.ts` ile ayrıldı, splash aynen kalır) | ✅ eşdeğeri zaten var — `UpdateGate` açılışta OTA kontrol eder, `NativeUpdateGate` APK'yı uygulama içinde indirir |
| Progress bar indirme sırasında GERÇEK yüzdeyi gösterir | ✅ main'in `download-progress` olayı; uydurma yok (§35) | ⛔ | ✅ (native indirici yüzdeyle) |
| Bar alanındaki metin: "Yeni sürüm indiriliyor · %42" → "Güncelleme uygulanıyor…" → "Uygulama yeniden başlatılıyor…" | ✅ TR+EN (`desktop:boot.update.*`) | ⛔ | ✅ benzer |
| İndirme bitince otomatik uygula + yeniden başlat | ✅ 1,2 sn'lik "uygulanıyor" bildirimi sonrası `quitAndInstall(silent, relaunch)` | ⛔ | ✅ |
| Yavaş/kopuk bağlantı → uygulama MEVCUT sürümle açılır | ✅ (aşağıdaki bütçeler) | — | ✅ |
| Çevrimdışı / feed erişilemez → hiç bekletme | ✅ ilk hata statüsünde anında bırakır | — | ✅ |
| Zorunlu (critical) güncelleme akışı değişmedi | ✅ akış `critical` görünce derhal çekilir; main + `CriticalUpdateOverlay` sahibi kalır | — | ✅ |

**Bütçeler** (`apps/desktop/src/renderer/src/lib/boot-update.ts`) — hepsi tek bir çıkışta
biter: `release` ⇒ `update` faz'ı kapanır ⇒ uygulama açılır.

| Bekleme | Üst süre | Gerekçe |
|---|---|---|
| Feed cevabı | 2,5 sn | main kontrolü pencere yüklenmeden başlatıyor, cevap çoğu zaman zaten elde; sıradan "güncel" açılışına gözle görülür gecikme eklemiyor |
| İndirme | 20 sn | sıradan bir hatta kurulumun tamamı sığar; daha yavaşsa main arka planda indirmeye devam eder, rozet devralır, `autoInstallOnAppQuit` çıkışta uygular — hiçbir şey kaybolmaz |
| İndirme durması (yüzde hiç ilerlemiyor) | 6 sn | ölü bağlantıyı 20 sn boyunca beklemenin anlamı yok |
| Bitmek üzereyken (≥%75) tek uzatma | +10 sn | %90'da bırakıp sonra baştan indirmek kullanıcı için daha kötü |
| `quitAndInstall` süreci kapatmazsa | 8 sn | kilitli/engellenmiş kurulumda uygulama MEVCUT sürümle açılır; paket zaten indiği için rozet "yeniden başlat" sunar |

Faz modeliyle birleşme: akış **tek bir boot faz'ı** (`update`, `stores/boot-store.ts`) sahibi.
Splash'ı açık tutmanın tek yolu o faz'ı kapatmamak, bırakmanın tek yolu kapatmak — yani yeni
bir "bloke etme" yolu icat edilemez ve `finishBoot()` her şeyi hâlâ ezer. Güncelleme yoksa faz
**düşürülür** (mevcut "uygulanmayan fazı düşür" deseni): payda 5'e döner, çubuk bugünküyle
birebir aynı kalır. Faz listede **sonda** duruyor ki her açılışta "Güncellemeler denetleniyor"
yazısı öne çıkmasın. `update` faz'ı **bloklayıcı değil** — başarısız bir güncelleme başarısız
bir açılış değildir, hata/Tekrar-dene ekranına asla düşmez. İndirme sürerken splash'ın
"oturum bilindikten 10 sn sonra her hâlükârda aç" tavanı askıya alınır: o pencere zaten
yukarıdaki sert üst sürelerle sınırlı ve görünür bir indirmeyi 10. saniyede kesmek özelliği
boşa çıkarırdı.
Ek sağlamlaştırma (aynı dalga): main'de `downloadUpdate()` yeniden-giriş koruması (artık üç
çağıran var) ve **açılış kontrolü hata alırsa** 10 sn + 45 sn'de en fazla iki yeniden deneme —
bilgisayar yeni açılırken DNS henüz ayakta olmadığı için ilk kontrolün patlaması tipik. Bu
denemeler yalnız KONTROL eder, indirme başlatmaz.
Kanıt: `apps/desktop/src/renderer/src/lib/boot-update.test.ts` (29 test). Kritik olanlar
"never blocks the app from opening" başlığı altında: yavaş indirme, duran indirme, cevapsız
feed, kurulamayan paket — ve her bekleme durumunu tek tek süpüren
*"EVERY waiting stage has a deadline"*, ki yeni bir bekleme durumu üst süresiz eklenemesin.
## 2026-07-27 — Hayalet çağrı P0 + yalnız kalınca otomatik ayrılma (BACKEND dalgası)
Founder canlıda bitmeyen zil sesi yaşadı. Kök neden: bir `dm_calls` satırının `ended_at`
alması için **her yol canlı bir istemci gerektiriyordu** (reject / cancel / hangup /
upgrade hepsi HTTP uç noktası). Kabul edilmiş bir çağrının iki tarafı da yok olunca
(çökme, uyku, ağ kopması, ya da DEPLOY) satır sonsuza kadar `active` kaldı — prod'da biri
3 GÜNLÜK. Tek otomatik süpürme `POST /dm-calls` içindeki tembel, o DM'e özel, yalnız
`ringing` satıra bakan koddu; `active` satır için hiçbir yol yoktu.

| Özellik | Masaüstü/Web | Mobil |
|---|---|---|
| Ölü çağrı süpürme (dakikalık job) | ✅ | ✅ | Backend ✅ — `apps/api/src/lib/dm-call-sweeper.ts`. Ölçüt YAŞ DEĞİL **canlılık**: LiveKit odası (`dmcall:<id>`) boş mu. Film gecesi saatlerce sürebilir, o yüzden "eski = ölü" varsayımı reddedildi. Medya düzlemi ULAŞILAMAZSA hiçbir `active` satır kapatılmaz — boş cevap uydurmak canlı çağrıyı öldürürdü. **Not (2026-07-30):** bu satır sunucu-tarafı bir davranış; hücreler ⛔ iken "bu özellik yok" gibi okunuyordu. Job canlı: `apps/api/src/app.ts` başlangıçta `createDmCallSweeper`'ı başlatıyor, dolayısıyla iki istemci için de geçerli. |
| Deploy sonrası hayalet temizliği | ✅ | ✅ | Backend ✅ — job'un İLK tick'i uzlaştırma modunda: odası boş olan eski `active` satır anında kapanır, odası dolu olan (LiveKit ayrı konteyner, API deploy'unu atlatır) dokunulmaz. LiveKit geç açılırsa uzlaştırma hakkı harcanmaz, ilk kanıtlı tick'e devreder. Aynı süpürücünün uzlaştırma tick'i (`apps/api/src/app.ts`), platformdan bağımsız. |
| Arayan düşünce zil geri çekiliyor | ✅ | ✅ | Backend ✅ — `apps/realtime/src/dm-call-disconnect.ts`. Son soket kapanınca 8s bekleme + presence yeniden kontrolü, sonra giden zil `missed`. **Aranan** düşerse zil DURMAZ (mobil push ile çalıyor, soketi hiç olmayabilir); **kabul edilmiş** çağrı asla WS kopmasıyla kapatılmaz (medya LiveKit'te — tünelde WS düşer, ses devam eder). `apps/realtime/src/dm-call-disconnect.ts` canlı; platformdan bağımsız. |
| Yalnız kalınca çağrıdan otomatik çıkma | ⛔ | ⛔ | Backend ✅ — aynı job, 3 dk. **DM araması** ve **grup-DM sesli kanalı** (yükseltilmiş çağrı dahil) için son kişi SFU'dan zorla çıkarılır. Yüzey `friend_groups.kind` ile veritabanından çözülür, oda adından TAHMİN EDİLMEZ. |
| Sunucu sesli kanalında süresiz yalnız kalma | ✅ | ✅ | Korundu ve korunacak — `kind='server'` kanaldan **asla** çıkarma yok (müzik dinleme, "buradayım" meşru kullanım). Tanınmayan oda da dokunulmaz sayılır. Regresyon testi: "NEVER ejects someone sitting alone in a SERVER voice channel". |
| Zilin mutlak üst sınırı (istemci) | ✅ | ✅ | `packages/client-core` — start-409 ile devralınan çağrıda zil zamanlayıcısı yalnız ARAYAN rolü için kuruluyordu, ARANAN rolünde zil sınırsızdı. Artık iki rolde de kuruluyor. |

Kanıt: `apps/api/src/__tests__/dm-call-sweeper.int.test.ts` (17 test, gerçek Postgres) +
`apps/realtime/src/__tests__/gateway.dm-call-disconnect.int.test.ts` (5 test, gerçek WS).
Protocol: `voice.disconnected` reason enum'una `alone` eklendi (yalnız genişletme; eski
istemci çerçeveyi düşürür, SFU çıkarması yine de uygulanır).
UI dalgası gerekli: `alone` için i18n metni + "yalnız kaldın, X sn" geri sayımı. Sunucu
otoriter kalır (mikrofon SFU'dan kesilir), geri sayım bilgilendirmedir.

## 2026-07-27 — M20 sesli kanal metin sohbeti (MASAÜSTÜ/WEB UI dalgası)

Backend dalgası (yukarıdaki bölüm) kontratı açmıştı; bu dalga onu kullanıcıya veriyor.
**Ürün kararı (founder): sesli kanala tek tık = SESE KATIL, ve o katılmanın parçası olarak
kanalın sohbeti açılır.** Sesli kanalda kullanıcının beklediği eylem KATILMAKTIR,
okumak değil; ölçülen en çok kullanılan ses hareketi de budur. Tek istisna:
**zaten içinde olduğun oda**. Ona tıklamak
"ne konuşulmuş göster" demektir, o yüzden yalnız sohbeti açar; yeniden bağlanma, oda
değiştirme, hiçbir ses FSM geçişi yok.
**Katılmadan okuma yeteneği kayıp değil, ikincil:** erişim kuralı zaten "kanalı gören
okur/yazar" (ADR 0007 — odada olmak şart değil), yani bu gerçek bir yetenek ve §35 gereği
ulaşılabilir bir kontrolü olmak zorunda. Satırda kendi ikonu var (ince işaretçide hover/odak
ile çıkar, **dokunmatikte ve dar ekranda her zaman görünür** — orada hover yok, hover-only
bir kontrol hiç yok demektir) artı bağlam menüsünde "Sohbeti aç (katılmadan)" maddesi.
Bağlantıyı kesme satırda YOK: sohbeti açan ikonun bir piksel yanında duran "ayrıl", çağrıyı
bitiren bir yanlış tık demektir. Ayrılma kasıtlı yüzeylerde — bağlam menüsü, ses paneli,
sohbet başlığı, sahne çubuğu.

| Özellik | Masaüstü/Web | Mobil |
|---|---|---|
| Sesli kanala tek tık: katıl + oda sohbetini aç | ✅ | ✅ |
| Zaten bağlıyken tık: yalnız sohbeti aç (yeniden bağlanma/oda değişimi yok) | ✅ | ✅ |
| Katılmadan oku: satır sohbet ikonu (dokunmatikte kalıcı) + menü maddesi | ✅ | ✅ |
| Sesli kanalda gönder/al/kalıcılık/sayfalama · pin · arama · ek dosya · taslak | ✅ | ✅ |
| Sesli kanal satırında okunmamış pip/sayı + "okundu işaretle" | ✅ | ✅ |
| Sahne ⇄ sohbet geçişi (sahnede "Kanal sohbetini aç", sohbette "Sahneye dön") | ✅ | ✅ |
| Komut paletinde iki grup: "Kanallar" = aç · "Sesli kanallar" = katıl | ✅ | ✅ |
| Kanal ayarlarında slowmode sesli kanalda da görünür | ✅ | ✅ |

**Tek sohbet uygulaması korundu** (kapsam notunun şartı): sesli kanalın sohbeti aynı
`ChatView` + `ChatDataProvider` + `MessageList` + `MessageComposer` ağacı. Kind'a bakan tek
yer başlıktaki ikon (`#` ⇄ hoparlör) ve başlığa eklenen oda kontrolü
(`VoiceChannelHeaderControls`). Sahne ikinci bir mesaj listesi gömmüyor — "Kanal sohbetini
aç" kullanıcıyı aynı yüzeye taşıyor.

**Satırda iki BAĞIMSIZ durum:** seçili ("sohbetin bunu okuyor", satır dolgusu) ve bağlı
("mikrofonun bu odada", hoparlör ikonu accent). İkisi rutin olarak farklı satırlarda doğru
oluyor; eskiden tek duruma katlanmışlardı ve bu, konuştuğun ama okumadığın kanalda okunmamış
pip'ini bastırıyordu.

**Kilit taşları (istemci):** `chat-store.setActiveChannel` artık `isChatCapableChannel()`
soruyor — sunucudaki dört yazma kapısıyla aynı paylaşılan tanım — ve `ensureChannelSelection`
seçili sesli kanalı grup detayları her tazelendiğinde #general'a geri çekmiyor. Sunucu ilk
açılışta hâlâ ilk METİN kanalını seçiyor: sunucuyu yalnızca açan kullanıcı kendini bir sesli
kanalın içinde bulmasın diye.

Kanıt: `apps/desktop/src/renderer/src/lib/voice-channel-chat.test.ts` (tık katılır · zaten
bağlıyken katılmaz · tık asla ayırmaz · menü join/leave kuralı),
`.../lib/voice-channel-chat-wiring.test.ts` (satır tıklaması katılma yolundan geçiyor · sohbet
ikonu bağlamadan açıyor ve tıklaması satıra sızmıyor · dokunmatikte görünür · çift-tık yok ·
ikinci sohbet uygulaması yok · slowmode kind dalının dışında),
`.../stores/chat-store.voice-chat.test.ts` (seçim + unread),
`packages/app-ui/src/components/channelVisibility.test.ts` (istemci kanal listesini
uydurmuyor da elemiyor da — görünürlük sunucunun).

**Mobil kuyruğu kapandı** — aşağıdaki bölüme bak.

## 2026-07-28 — M20 sesli kanal metin sohbeti (MOBİL dalgası; parite kapandı)

Masaüstü/web dalgasının aynısı, telefonun kendi girdi modeliyle. **Karar kuralı yeniden
yazılmadı: `packages/client-core/src/voice-channel-chat.ts`'e TAŞINDI** ve her iki istemci
oradan okuyor (`member-menu.ts` ile aynı gerekçe — iki elle yazılmış kopya, iki yüzeyin
founder'ın en çok kullandığı ses hareketinde sessizce ayrışma biçimidir). Masaüstündeki eski
yol yalnız bir yönlendirme (re-export) modülü olarak duruyor; üç import'u client-core'a
çevirip silmek mekanik bir takip işi.

**Sesli kanal mobilde TEK yer, İKİ görünüm:** `/voice/[channelId]` rotası bir `intent`
parametresi taşıyor — `join` (bağlan + sahneye in) ve `chat` (hiçbir şeye bağlanma, sohbeti
aç). Parametre yoksa `join` okunur, yani mini bar / push derin bağlantısı / komut paleti
aynen bağlanmaya devam ediyor. İki ayrı rota olsaydı kullanıcı aynı kanalı kendi üstüne
yığabilir ve "mini bar hangisine döner" sorusunun ikinci bir cevabı gerekirdi.

| Özellik | Mobil | Not |
|---|---|---|
| Sesli satıra dokunuş: katıl + oda sohbetini aç | ✅ | Araya giren "katıl?" sheet'i KALKTI (`VoiceChannelJoinSheet` silindi) — kimlerin odada olduğu zaten her satırın altında `VoiceChannelOccupants` ile duruyordu, önüne modal koymak gösterecek şeyi kalmamış bir adımdı. |
| Zaten bağlıyken dokunuş: yalnız sohbet | ✅ | `intent=chat` ile açılır ve `join` HİÇ çağrılmaz; motorun "aynı odaya no-op" davranışına güvenilmiyor. |
| Katılmadan oku: satırda ayrı, **her zaman görünür** hedef | ✅ | ≥44pt (`minWidth: 44`, satır yüksekliği). Telefonda hover yok: masaüstündeki hover-ile-açılan ikonun mobil karşılığı kalıcı olmak zorunda. Uzun basma menüsünde "Sohbeti aç (katılmadan)" ikinci yol. |
| Sesli kanalda gönder/al/pin/arama/ek/taslak/outbox | ✅ | Aynı `ChatThread` — mobilde ikinci bir sohbet uygulaması YOK. Kind'a bakan tek yeni şey `channelKind` prop'u (store'un aktif-kanal kapısı için). |
| Sesli satırda okunmamış pip/sayı + "okundu işaretle" | ✅ | Metin satırıyla birebir aynı mute önceliği. "Okundu işaretle" yeni `ChannelActionSheet`'te (uzun basma) — mobilde daha önce hiç yoktu, artık **her iki kind** için var. |
| Sahne ⇄ sohbet geçişi | ✅ | Sahnede sohbet düğmesi (okunmamış rozetiyle), sohbette başlıkta mikrofon + "Odaya dön" + "Ayrıl". Hangi kontrolün çıkacağına paylaşılan `voiceChatHeaderActions` karar veriyor. |
| Komut paletinde iki grup | ✅ | Zaten vardı (`palette-items.ts`: textChannels = aç, voiceChannels = katıl) ve intent'siz gezindiği için `join` olarak okunuyor. |
| Kanal ayarlarında slowmode sesli kanalda da | ✅ | Alan kind dalının DIŞINA çıktı; sesli için ayrı ipucu metni. `maxParticipants`/`audioBitrateKbps` sesli-özel kalmaya devam. |

**Bulunan ve düzeltilen sessiz hata:** `chat-store.setActiveChannel` `kind !== "text"` ise
çıkıyordu. Bu yalnız seçim değil, **okunmamış bastırma** demek: aktif kanal id'si, önünde
duran mesajın unread işaretlenmesini engelleyen şey. Yani sesli kanalın sohbetini okurken
gelen her mesaj, gözünün önünde okunmamış sayılıyordu. Kapı `isChatCapableChannel()`'a
çevrildi — sunucudaki dört yazma kapısıyla aynı paylaşılan tanım.

**İkinci düzeltme:** `ChatThread` alt boşlukta `VOICE_MINI_BAR_HEIGHT` ayırıyor ki yüzen bar
composer'ı örtmesin; ama bar `/voice/` rotasında kendini gizliyor. Sesli kanalın sohbeti artık
o rotada olduğu için iki taraf da tek bir yüklemi (`isVoiceRoomRoute`) okuyor — yoksa
composer'ın üstünde, orada olmayan bir bar için 64px delik kalırdı. DM araması bilerek hâlâ
ayırıyor (kendi rotasında `CallMiniBar` var).

Kanıt: `apps/mobile/src/components/voice/voice-channel-nav.test.ts` (dokunuş katılır · zaten
bağlıyken katılmaz · okuma hedefi asla katılmaz · intent'siz çağrı `join` okunur),
`apps/mobile/src/components/home/voice-channel-chat-wiring.test.ts` (satır dokunuşu paylaşılan
kuraldan geçiyor · araya sheet girmiyor · okuma hedefi kalıcı ve ≥44pt · liste yalnız
sunucunun döndüğü kanalları çiziyor · ikinci sohbet uygulaması yok · slowmode kind dalının
dışında), `apps/mobile/src/stores/__tests__/voice-channel-unread.test.ts` (sesli kanal
seçilebiliyor · sayaç sayıyor · açınca sıfırlanıyor · rail rozetine giriyor · mute'a saygılı).

## 2026-07-27 — Komut paleti mobile geldi (M20/W5)

Masaüstü/web'de Ctrl/Cmd+K ile açılan `CommandMenu`'nun mobil karşılığı eklendi. Mobilde
klavye kısayolu yok: **Ana Sayfa kabuğunun panel başlığındaki arama ikonu** (hem DM paneli
hem sunucu paneli) paleti açar — yeni bir gezinme sekmesi AÇILMADI. Tam ekran, otomatik
odaklanan alan, FlatList sanallaştırma, 150 ms debounce (filtreleme tamamen ÖNBELLEKTEN;
tuş başına ağ isteği yok). Eylem kümesi masaüstüyle birebir; iki fark aşağıda ve kodda
gerekçeli.

| Özellik | Masaüstü | Mobil | Not / Görev |
|---|---|---|---|
| Komut paleti (kanal/sunucu geçişi + hızlı eylemler) | ✅ Ctrl/Cmd+K | ✅ panel başlığı arama ikonu | `apps/mobile/app/(app)/command-palette.tsx`; veri katmanı saf + testli (`apps/mobile/src/components/command-palette/palette-items.ts`, 20 test) |
| Palet: metin/sesli kanal listesi + sunucu değiştir | ✅ | ✅ | Seçili sunucunun kanalları `position` sırasıyla; sunucu listesinden seçili olan düşer (masaüstüyle aynı kural) |
| Palet: kanalda mesaj ara / arkadaş davet et | ✅ (sunucu yüzeyinde) | ✅ (rayda sunucu seçiliyken) | Masaüstü `activeView === "server"` ile gizler, mobil "rayda sunucu seçili mi" ile — aynı kural. Arama hedefi: o sunucuda en son açılan metin kanalı, yoksa ilk kanal (palet açıkken mobilde kanal ekranı mount değildir, masaüstündeki "aktif kanal" kavramının dürüst karşılığı) |
| Palet: mikrofon / sağırlaştırma aç-kapat | ✅ her zaman | ✅ yalnız canlı ses oturumunda | Mobilde oturum dışında görünür etkisi olmadığından ölü satır gösterilmiyor (§35). Yetenek aynı |
| Palet: sunucu oluştur / kodla katıl / ayarlar / ses ayarları | ✅ | ✅ | Mobilde ayrı cihaz diyaloğu yok — mikrofon/ses/görüntü bölümleri Ayarlar ekranının içinde, iki satır da oraya gider |
| Palet: üye listesini aç/kapat | ✅ | — | Mobilde açılıp kapanan bir üye KENAR ÇUBUĞU yok; roster zaten sunucu kanal listesinin altında. Karşılığı olmadığı için satır eklenmedi (§35) |

Erişilebilirlik: her satır `accessibilityRole="button"` + etiket (kanalın sunucusu etikete
dahil), bölüm başlıkları `accessibilityRole="header"`. Klavye açıkken liste canlı IME
yüksekliği kadar padding alır (`useKeyboardHeight`; Android edge-to-edge altında
KeyboardAvoidingView klavye inset'i almadığı için — mevcut composer dersi).
## 2026-07-27 — Yalnız kalınca otomatik ayrılma: KULLANICIYA GÖRÜNEN yarısı (İSTEMCİ dalgası)
Üstteki backend dalgasının eksik yarısı. Kural tek yerde yaşıyor: sayaç ve neden-atfı
`packages/media` motorunda (§11), iki platform aynı kodu paylaşıyor — iki elle yazılmış kopya
değil.

| Özellik | Masaüstü | Mobil | Not / Görev |
|---|---|---|---|
| "Odada tek kişi sensin — arama M:SS sonra kapanacak" geri sayımı | ✅ | ✅ | Motor `VoiceState.aloneDeadlineAt` (bir ZAMAN DAMGASI) kurar; saniye tik'i yalnız uyarıyı çizen küçük bileşende döner, store'da değil — yalnız kalmak 180 store yazması değil **bir** yazma ediyor (§27). Masaüstü `AloneCountdownNotice.tsx` → `VoicePanel` + `CallDock`; mobil aynı adlı bileşen → `VoiceRoomScreen` + `InCallView`. |
| Sunucu sesli kanalında geri sayım **hiç görünmez** | ✅ | ✅ | Kapı motorda: `isAloneEjectableSurface` yalnız `call` ve `groupDm` için true; `server`, `unknown` ve **henüz çözülmemiş** (`null`) yüzeyde sayaç kurulmaz. Yüzey `friend_groups.kind`'dan çözülür (`lib/voice-surface.ts`, iki platformda da), oda adından tahmin edilmez — tek istisna `dmcall:` öneki, ki o zaten süpürülen yüzey. Çözülemezse **gösterilmez** (fail-safe: gelmeyecek bir kopmayı haber vermek sessiz kalmaktan kötü). |
| Biri girince uyarı anında kaybolur, çıkınca sayaç **baştan** başlar | ✅ | ✅ | Motor `refreshAloneDeadline()` — oda tek kişilik değilse `aloneDeadlineAt = null`. Sunucunun kendi `aloneSince` defteriyle aynı davranış; 10 sn'lik bir ağ kopması kimseye çağrısına mal olmaz. |
| Sayaç bitince istemci **kendi kendine ayrılmaz** | ✅ | ✅ | Sıfıra inince yalnız metin değişir ("arama kapanıyor"); ayrılma kararı sunucunun. Gerçek çıkarma 3-4 dk arasında düşer (3 dk pencere + 60 sn tick), negatif sayı hiç gösterilmez. Test: "does NOT leave on its own when the window elapses". **"Kal" butonu yok** — founder istemedi. |
| Kopma bildiriminde DOĞRU sebep | ✅ | ✅ | Yeni `VoiceEndedReason = "session_replaced" \| "alone"` + TR/EN metin (`voice.endedAlone`). Eskiden SFU'nun `PARTICIPANT_REMOVED`'ı her zaman "başka cihazdan katıldın" diye okunuyordu — yalnız kalıp çıkarılan kullanıcıya **yanlış** hikâye anlatıyordu (§26). Artık: `voice.disconnected(reason=alone)` geldiğinde ondan; gelmediğinde (1-1 DM aramasında sunucu `call.ended` yolluyor) kendi süresi dolmuş sayaçtan. |
| Yarış: SFU çıkarması mı, olay mı önce gelir | ✅ | ✅ | İkisi de olur. Olay önce gelirse motor temiz ayrılıp sebebi yazar; SFU önce gelirse bekleyen bildirimin **metnini düzeltir** (`handleForcedDisconnect`). Kullanıcı bildirimi kapattıysa geç gelen olay onu diriltmez. Oda iki adla anılabildiği için (SFU oda adı + kanal id, yükseltme durumu ADR 0012 §6) eşleşme ikisi üzerinden yapılır. |
| Bilinmeyen `reason` → mevcut genel metin | ✅ | ✅ | İleriye dönük uyumluluk: `voiceEndedReasonFromEvent` tanımadığı sebebe `null` döner (mevcut davranış korunur, `moderator` dahil — o metin moderasyon dalgasının işi), `localizeVoiceEnded` tanımadığı `VoiceEndedReason`'da mevcut metne düşer. Boş bildirim ya da ham enum sızıntısı yok. |

Kanıt: `packages/media/src/__tests__/alone-watch.test.ts` (13) + `engine.test.ts` içinde
"alone-idle deadline" (7) ve "alone-idle eviction reason" (7) blokları ·
`apps/desktop/src/renderer/src/lib/voice-surface.test.ts` (6) + `voice-notices.test.ts` (7) ·
`apps/mobile/src/lib/voice-surface.test.ts` (6) + `src/components/voice/voice-ended.test.ts` (7).
Yeni sunucu sözleşmesi YOK — istemci katılımcı sayısını zaten görüyordu.
## 2026-07-28 — Watch Party: SUNUCU yarısı (M20, ADR 0016)
Sesli kanalda birlikte YouTube izleme. Karar (b): videoyu herkes kendi cihazında
YouTube'dan oynatır, sunucu yalnız **oynat/duraklat/sar/video/host** durumunu mevcut WS
ağ geçidinden senkronlar — ücretsiz, API anahtarsız, medya düzlemine dokunmadan
(§10/§35). Bu dalga **yalnız sunucu**: kullanıcıya görünen hiçbir yüzey yok, dolayısıyla
ölü buton da yok (§35). Oynatıcı arayüzü + `frame-src` CSP değişikliği bir sonraki dalga.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| Watch Party — senkron sözleşmesi + ağ geçidi (sunucu) | ✅ | ✅ | Platformdan bağımsız: `watch.*` tipli olaylar (`packages/protocol`), yetki + host devri + sürüklenme düzeltmesi (`apps/realtime/src/watch-party.ts`), TTL'li Redis oturumu (`RedisWatchPartyStore`, DB tablosu YOK). 10 entegrasyon testi gerçek soketle. |
| Watch Party — gömülü oynatıcı (kullanıcı yüzeyi) | ⛔ | ⛔ | **Sonraki dalga.** Masaüstü/web: sesli sahnede oynatıcı karosu + `frame-src https://www.youtube-nocookie.com` CSP satırı (electron-security-review zorunlu) + Caddy CSP'si. Mobil: WebView embed (`voice/[channelId]`). İki istemci de `watch.*` olaylarını şimdilik BİLİNÇLİ no-op olarak tanıyor (exhaustive switch derlensin diye) — sahte arayüz yok. |
| Watch Party — DRM servisleri (Netflix/Disney+) | — | — | Ücretsiz/yasal senkron yolu YOK (ADR 0016). O geceler ekran paylaşımında kalır; Widevine donanım korumasında yakalanan bölge siyah çıkabilir. Founder beklentisi ADR'de yazılı. |

Sunucu tarafının kilit kuralları (hepsi testli): gönderen o sesli kanalın **işgalcisi**
olmalı (sunucu gerçeği — istemcinin iddiası değil); kontrol yalnız **host ∨ sunucu
sahibi**; **zaman aşımına** uğramış üye kontrol edemez (ADR 0019, mesaj yollarıyla aynı
kapı); host sesten ayrılınca **odadaki en kıdemli** işgalciye otomatik devir; oda
boşalınca oturum **biter** (`channel_empty`); video referansı sunucuda ayrıştırılır ve
tele **yalnız 11 karakterlik normalize id** çıkar (enjeksiyon sınırı); kontrol olayları
hız sınırlı. Engelleme (ADR 0017) burada kapı DEĞİL — gerekçe ADR 0016'da.
## 2026-07-28 — Watch Party: OYNATICI arayüzü (masaüstü + web, M20 / ADR 0016)
Sunucu yarısının kullanıcıya görünen tamamlayıcısı. Masaüstü ve web AYNI kodu çalıştırıyor
(web = tarayıcıda mount edilen masaüstü renderer'ı), dolayısıyla tek uygulama iki yüzeyi
birden kapatıyor. Oynatıcı sesli sahnenin (`VideoStage`) karosu; sesli kanal ve DM araması
aynı sahneyi paylaştığı için parti YALNIZ gerçek bir sesli KANALDA çıkıyor — DM araması
`dmcall:` odasıdır, kanal değildir, orada buton hiç görünmüyor (§35).

> **GÜNCEL DURUM (2026-07-30 denetimi):** bu tablo yazıldığında mobil sütunu boştu. Mobil
> Watch Party paritesi O ZAMANDAN BERİ KAPANDI (aşağıda "Watch Party: MOBİL oynatıcı + sıra
> + arama", APK 1.8.0 — `react-native-webview` artık `apps/mobile/package.json`'da kurulu).
> Mobil hücreler ⛔'den ✅'e çekildi; sağdaki notlar masaüstü/web uygulamasını anlatmaya
> devam ediyor, mobil karşılıkları `apps/mobile/src/components/watch/`.

| Özellik | Masaüstü | Mobil | Not / Görev |
|---|---|---|---|
| Gömülü YouTube oynatıcı (resmî `youtube-nocookie` embed) | ✅ | ✅ | Harici script YOK: `enablejsapi=1` + `postMessage` ile sürülüyor, `iframe_api` yüklenmiyor → `script-src 'self'` ve `connect-src` DOKUNULMADI. Oynatıcı değiştirilmiyor / reklam gizlenmiyor (ToS). `lib/watch-player-protocol.ts` (tel), `components/WatchPartyPlayer.tsx` (iframe + senkron döngüsü). Video değişince iframe REMOUNT edilmiyor, `loadVideoById` gönderiliyor — yoksa her video değişimi herkese tam bir embed yeniden yüklemesi olurdu. |
| Host = gerçek YouTube kontrolleri, izleyici = kontrol YOK | ✅ | ✅ | Host `controls=1` ile kendi transport çubuğunu kullanır; biz izleyip yayınlarız (`detectHostControl`). İzleyicide `controls=0` + iframe `pointer-events-none` — devre dışı ikiz buton ya da tıklanıp bir saniye sonra geri alınan tıklama yok (§35). Sunucu sahibi, host başkası olsa da kontrolü görür (ADR 0016 yetki adımı 4; kozmetik kapı, sunucu yeniden karar verir). |
| Sürüklenme düzeltmesi + seek-döngüsü koruması | ✅ | ✅ | 1 sn'lik tik; sapma `WATCH_DRIFT_TOLERANCE_SECONDS` (2 sn) eşiğini AŞARSA seek, eşitse/altındaysa seek YOK. Sarma sonrası 3 sn sessizlik: oynatıcı seek'i tamponlarken hâlâ ESKİ konumu bildirir, korumasız bir kontrol bunu "hâlâ sapmış" okuyup sonsuz seek eder. Yakınsamayan sapmada (REKLAM — oynatıcı reklamın zaman çizgisini bildirir, hiçbir seek düzeltemez) geri çekilme 3→6→9→12 sn; tolerans içine düşen ilk ölçüm sayacı sıfırlar, reklam bitince cezasız normale döner. Host KENDİNİ düzeltmez → eko döngüsü mimari olarak imkânsız. |
| Konum projeksiyonu saat kaymasına dayanıklı | ✅ | ✅ | `positionSec` yerel `Date.now()` farkıyla ilerletilir; `serverTime` yalnız SINIRLI (≤0.5 sn) gidiş-süresi tahmini için kullanılır. Saati bir saat ileri olan istemci aksi hâlde bir saatlik sapma hesaplayıp odanın kafasını uçururdu. 0.5 sn, 2 sn'lik eşiğin altında olduğu için kayma tek başına asla seek tetikleyemez. |
| Host devri (açık + otomatik) sessizce oturuyor | ✅ | ✅ | `watch.host_changed` yalnız `hostId`'yi değiştirir — `positionSec` el değmez, devir kimsenin kafasını oynatmaz. Devir menüsü SUNUCU gerçeği olan işgalci listesinden kurulur (gateway aynı listeye bakıp reddediyor), devredilecek kimse yoksa menü hiç çıkmaz. |
| `watch.stopped` sahneyi temizliyor · `watch.started` yeniden bağlanma anlık görüntüsü | ✅ | ✅ | Tek upsert yolu, "ilk kare" özel durumu yok: geç katılan, kopup dönen ve partinin açılış karesi aynı koddan geçer. Durdurulan oturum siliniyor — kimsenin yenilemeyeceği bir konumu sonsuza dek ilerleten öksüz oynatıcı kalmıyor. |
| Geçersiz link anında reddediliyor | ✅ | ✅ | Yapıştırma anında `parseYouTubeVideoId` (AYNI paylaşılan ayrıştırıcı, `@demli/config`) — tek gramer, iki çağıran, sapma yok. Bu bir UX kolaylığı; güvenlik kapısı sunucuda kalıyor ve tele hâlâ yalnız 11 karakterlik normalize id çıkıyor. |
| Hata durumları ham gösterilmiyor (§26) | ✅ | ✅ | Gömülemeyen video (101/150) / bulunamadı (100) / genel oynatma hatası ayrı metinler; bilinmeyen gelecek kodu genel metne düşer (yanlış açıklama, genel açıklamadan kötüdür). Ağ geçidi reddi `NOT_IN_VOICE` / `NOT_HOST` / `WATCH_NOT_ACTIVE` üç ayrı TR+EN cümle — bu üç kodun tüm ağ geçidinde tek yayıcısı watch-party olduğu için atıf başka bir özellikten çalınamaz. Otomatik oynatma engellenirse izleyiciye GERÇEK bir "Oynatmayı başlat" düğmesi (gerçek bir kullanıcı etkileşimi + `unMute`+`playVideo`), boş bir çerçeve değil. |
| DRM servisleri (Netflix/Disney+) | — | — | Değişmedi: ücretsiz/yasal senkron yolu YOK. Link yapıştırma penceresi bunu dürüstçe yazıyor ve ekran paylaşımına yönlendiriyor (founder beklentisi ADR 0016'da). |
| Mobil oynatıcı (WebView embed) | — | ✅ | **ENGEL KALKTI — kapandı (APK 1.8.0).** 2026-07-28'de bu satır "NATIVE BAĞIMLILIKLA ENGELLİ" diyordu: `react-native-webview` kurulu değildi ve WebView bir native modül olduğu için OTA ile çıkamıyordu. Native APK dalgasında kuruldu (`apps/mobile/package.json` → `react-native-webview` 13.16.1; `app.json` runtimeVersion 1.8.0, versionCode 8) ve oynatıcı indi: `apps/mobile/src/components/watch/WatchPartyPlayer.tsx` + `watch-player-bridge.ts` (masaüstüyle aynı `enablejsapi`/`postMessage` protokolü, harici script yok). Zorunlu gezinme kapısı da kurulu: `watch-player-bridge.ts:214` `allowWatchNavigation` → `WatchPartyPlayer.tsx:604` `onShouldStartLoadWithRequest`. |

CSP — tam olarak İKİ satır, ikisi de tek host: masaüstü `apps/desktop/electron.vite.config.ts`
(`demli-csp` → `CSP_BASE`) ve web `Caddyfile` (`app.{$DOMAIN}` başlığı). `script-src` ve
`connect-src` değişmedi (üretim build'i ve dev sunucusu çıktısı üzerinden doğrulandı).
`scripts/check-caddyfile.mjs` frame-src'i artık TAM KÜME olarak doğruluyor: eksikse de,
fazladan host/joker eklenirse de kırılıyor (ikisi de negatif testle denendi).

Electron gezinme koruması: `will-navigate` YALNIZ ana çerçeve içindir, iframe'i kapsamaz —
uygulamanın ilk iframe'i tam olarak bu boşluğu açıyordu. Ayrı bir `will-frame-navigate` kapısı
eklendi (`main/frame-navigation-policy.ts`, saf + testli): alt çerçeve yalnız embed origin'inde
gezinebilir; benzer-alan adı (`…youtube-nocookie.com.evil.test`), userinfo kaçırma
(`…@evil.test`), `javascript:` / `data:` / `file:` ve düz http reddedilir; ayrıştırılamayan URL
kapalı düşer. Reddedilen gezinme HARİCEN AÇILMAZ — bir çerçevenin kendini yönlendirmesi
kullanıcının "bu sayfayı aç" demesi değildir, öyle sayılsaydı düşman bir embed keyfî URL
fırlatıcısına dönerdi. Oynatıcıdaki YouTube linkleri `target=_blank` ile
`setWindowOpenHandler`'a düşüyor: uygulama içinde pencere açılmıyor.
(2026-07-28 güncellemesi — aşağıdaki "Dış link köprüsü" bölümü: bu handler artık
KOŞULSUZ `deny`; https bile OS'a devredilmiyor.)

Kanıt: `apps/desktop/src/renderer/src/lib/watch-party.test.ts` (28) ·
`lib/watch-player-protocol.test.ts` (12) · `stores/watch-party-store.test.ts` (9) ·
`src/main/frame-navigation-policy.test.ts` (6) · Caddyfile invariant (pozitif + iki negatif).
tek uygulama iki yüzeyi birden kapsıyor; **mobil karşılığı ayrı dalga (Director kuyruğunda)**.
Kanıt: `packages/client-core/src/__tests__/watch-party.test.ts` (27) ·
`__tests__/watch-player-protocol.test.ts` (14) ·
`apps/desktop/src/renderer/src/stores/watch-party-store.test.ts` (9) ·
(İlk iki dosya 2026-07-28'de `packages/client-core`'a taşındı — aşağıdaki bölüm.)
## 2026-07-28 — Watch Party: saf mantık tek kaynağa alındı (mobil dalganın ön koşulu)
Mobil parite dalgası, oynatıcının kendisine gelmeden ENGELE takıldı (yukarıdaki "Mobil
oynatıcı" satırı): `react-native-webview` kurulu değil ve native olduğu için OTA ile
gelemiyor. Engellenmemiş yarısı yine de yapıldı — çünkü mobil oynatıcı yazıldığında
paylaşılacak olan sayılar zaten burada duruyordu ve ikinci bir elle yazılmış kopya, iki
yüzeyin birbirini sonsuza dek düzeltmesi demek.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| Senkron sayıları tek kaynakta | ✅ | ✅ (hazır) | `apps/desktop/src/renderer/src/lib/watch-party.ts` + `lib/watch-player-protocol.ts` → `packages/client-core/src/`. Taşınan şey davranış değil KONUM: `git mv` + testleriyle birlikte, tek satır mantık değişmeden (41 test aynen geçiyor). 2 sn eşik, 3 sn sessiz dönem, 3→6→9→12 geri çekilme ve ≤0,5 sn saat kayması payı artık iki yüzeyde de aynı dosyadan okunuyor. |
| Masaüstü çağıranları | ✅ | — | 5 içe aktarma satırı `@demli/client-core`'a çevrildi (`WatchPartyPlayer`, `WatchPartyStage`, `WatchPartyLinkDialog`, `watch-party-store`). Re-export shim bırakılmadı — ölü dolaylama olurdu; `member-menu` / `custom-status` ile aynı tüketim deseni. |
| Alt çerçeve gezinme kapısı | ✅ | ✅ | Masaüstü kapısı `apps/desktop/src/main/frame-navigation-policy.ts`'te KALDI (main process bu dalganın sınırları dışında). Mobil WebView dalgası `onShouldStartLoadWithRequest`'i yazarken bu kuralı da client-core'a taşımalı — şu an tek kopya, o dalgadan sonra ikiye çıkmamalı. **Mobil kapısı indi:** `apps/mobile/src/components/watch/watch-player-bridge.ts:214` `allowWatchNavigation` → `WatchPartyPlayer.tsx:604` `onShouldStartLoadWithRequest`. Not artık iki kopya olduğunu söylüyor — client-core'a çekilmesi açık borç. |

## 2026-07-28 — Dış link köprüsü: `setWindowOpenHandler` koşulsuz `deny` (Watch Party güvenlik kapanışı)
Watch Party incelemesinden kalan tek açık madde kapandı (`docs/architecture/security.md`).
Handler pencereyi zaten reddediyordu ama `https://` ile başlayan her URL'i
`shell.openExternal`'a devrediyordu — ve bu yol artık ÜÇÜNCÜ TARAF iframe içeriğinden
(reklam, end-screen kartı, `target=_blank`) tetiklenebiliyordu. Aynı dosyadaki
`will-frame-navigate` kapısı "reddedilen gezinmeyi dışarı açmak hasmane embed'i URL
fırlatıcısına çevirir" diye gerekçelendirilmişti; `window.open` yolu tam olarak onu
yapıyordu. Tutarsızlık kapandı.

| Özellik | Masaüstü | Web | Not |
|---|---|---|---|
| Pencere açma kararı | ✅ | — | `setWindowOpenHandler(denyWindowOpen)` — KOŞULSUZ `deny`. `denyWindowOpen` (`main/external-link-policy.ts`) **hiç parametre almıyor**: URL'i göremeyen bir fonksiyon URL'e göre dallanamaz, yani "küçük bir https istisnası" ilerde sessizce geri eklenemez (imza değişmeden olmaz). Electron'suz + testli. |
| Kendi dış linklerimiz | ✅ | ✅ | Yeni dar IPC: `externalLinks.open(url)` → `external-link:open` (`main/external-link.ts`). Renderer'a `shell` VERİLMEDİ — `openPath`/`showItemInFolder`/`trashItem` erişilemez kalıyor. Doğrulama: zod ile sınırlı uzunluk (2048), sonra `isOpenableExternalUrl` ile YENİDEN ayrıştırma — yalnız `http(s)`, gömülü kimlik bilgisi yok (`https://getdemli.com@evil.test`), boş host yok; `javascript:`/`data:`/`file:` ve OS'ta kayıtlı UYGULAMA başlatan özel şemalar reddedilir. Gönderen yalnız kendi pencerelerimizin ÜST çerçevesi olabilir (alt çerçeve = embed, doğrudan red) + 10 sn'de 6 açılış hız sınırı (ele geçirilmiş renderer masaüstünü tarayıcı penceresiyle dolduramaz). |
| Web bozulmadı | — | ✅ | Aynı renderer web'i de besliyor ve orada `window.open` DOĞRU davranış. Tek ortak yol: `openExternalUrl` (`packages/app-ui/src/platform/external-link.ts`) — köprü varsa preload fiili, yoksa `noopener,noreferrer` `window.open`. `packages/app-ui` web'de de kullanıldığı için köprü OPSİYONEL okunuyor (erken boyama / test renderer'ı da kapsanır). Web köprüsü (`createWebBridge`) namespace'i uygulayarak sözleşmeyi 1:1 tutuyor. |
| Çağrı yerleri | ✅ | ✅ | `LinkEmbedCard.tsx`, `lib/download-links.ts` (`openDownloadUrl`), `packages/app-ui/.../MessageMarkdown.tsx` seam'e geçti. `DownloadPrompt.tsx`'in iki `<a target="_blank">`'ı zaten `openDownloadUrl`'e yönlendiriyordu (href erişilebilirlik için duruyor) ve bileşen zaten YALNIZ web yüzeyinde render ediliyor. Kullanıcıya görünen davranış aynı: linke tıkla → OS tarayıcısı. |

Kanıt: `apps/desktop/src/main/external-link-policy.test.ts` (8) ·
`src/main/external-link.test.ts` (8, sahte Electron ile gerçek IPC handler'ı) ·
`packages/app-ui/src/platform/external-link.test.tsx` (9, jsdom) ·
`src/renderer/src/lib/download-links.test.ts` (+3 yeni: köprü yolu / web geri düşüşü / red).

## 2026-07-28 — Kanal katlama + kanala davet (masaüstü + web; tek renderer)
Founder isteği, üç görselli. Masaüstü ve web **aynı** renderer'ı
çalıştırdığı için tek uygulama iki yüzeyi birden kapsıyor; **mobil karşılığı ayrı dalga**
(Director kuyruğunda, aşağıdaki satırlarda ⛔).

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| "Metin/Ses Kanalları" başlığında chevron → bölümü katla | ✅ | ✅ | ⛔ — Director kuyruğu (mobil kategori başlığı katlanıyor, sabit iki bölüm katlanmıyor) |
| Katlıyken YALNIZ seçili kanal görünür (bölümde yoksa tamamen kapanır) | ✅ | ✅ | ⛔ — aynı dalga |
| Katlıyken bağlı olunan sesli oda da görünür kalır | ✅ | ✅ | ⛔ — aynı dalga |
| Katlanmış KATEGORİ de aynı kuralı uygular (seçili kanal kaybolmaz) | ✅ | ✅ | ⛔ — mobil kategori katlaması hâlâ hepsini gizliyor |
| Katlama durumu kalıcı (hesap+sunucu bazında) | ✅ localStorage | ✅ localStorage | ✅ SecureStore (kategoriler için; yeni bölümler eklenince aynı depoya) |
| Başlık gerçek `button` + `aria-expanded` + klavye; chevron dönüş animasyonu YOK (reduced-motion) | ✅ | ✅ | ⛔ — aynı dalga |
| Kanal satırında davet ikonu: hover'da **veya seçiliyken** | ✅ | ✅ | ⛔ — aynı dalga |
| Aynı ikon dokunmatik / <900px'te KALICI görünür | ✅ | ✅ | — mobilde hover kavramı yok, karşılığı satır menüsü |
| Bağlam menüsü: "Kanala davet et" / "Sesli sohbete davet et" | ✅ | ✅ | ⛔ — aynı dalga |
| Yetkisi olmayana ikon da menü maddesi de GÖSTERİLMEZ (devre dışı DEĞİL) | ✅ | ✅ | ⛔ — aynı dalga |
| Davet modalı: sunucu adı + hedef kanal satırı + arkadaş arama + "Davet et"/"Davet edildi" + link/kopyala | ✅ | ✅ | ⛔ — aynı dalga |
| Arkadaşa davet = DM'e davet linki (mevcut sohbet-içi davet kartı) | ✅ | ✅ | ⛔ — mobil davet kartı zaten var, gönderme akışı yok |
| `targetChannelId` ile davet üretimi + redeem sonrası hedef kanala düşme | ✅ | ✅ | ⛔ — aynı dalga |
| Sesli hedefte OTOMATİK BAĞLANMA YOK (kullanıcı "Katıl"a basar) | ✅ | ✅ | ⛔ — aynı dalga |
| Boş alana sağ tık / uzun bas → kanal listesi menüsü | ✅ | ✅ | ⛔ — aynı dalga |
| Menüde "Sust. kanalları gizle" (onay kutulu, kalıcı, kişisel tercih) | ✅ | ✅ | ⛔ — aynı dalga |
| Menüde kanal/kategori oluştur + sunucuya davet (yetkisize GÖSTERİLMEZ) | ✅ | ✅ | ⛔ — mevcut akışlar çağrılıyor, ikinci sistem yok |
| Gizlenirken de seçili/bağlı kanal görünür kalır (katlama ile aynı kural) | ✅ | ✅ | ⛔ — aynı dalga |

**Paylaşılan kurallar tek kopyada** (mobil dalga bunları OKUYACAK, yeniden yazmayacak):
- `packages/client-core/src/channel-invite.ts` — `canCreateServerInvite` (API'nin
  `invite_policy` + guest kapısının birebir aynası; üyelik çözülmeden **kapalı** başlar,
  ki kontrol bir an görünüp kaybolmasın) ve `readInviteTargetChannel` (savunmacı okuma:
  alan yok / `null` / bozuk → hepsi "sunucu daveti", asla exception).
- `packages/client-core/src/sidebar-visibility.ts` — katlama VE "susturulmuşları gizle"
  için **tek** gizleme kuralı. İki ayrı kopya yazılsaydı biri istisnayı unuturdu:
  okunan kanal ve mikrofonun bağlı olduğu oda her koşulda ekranda kalır.

**Sunucu sözleşmesi** (backend dalgası, migration 0021): `POST /groups/:id/invites`
gövdesinde `targetChannelId?`; `GET /invites/:code/preview` ve `POST /invites/:code/redeem`
yanıtlarında `targetChannel: {id,name,kind} | null`. Hedef kanal davet edilenin
göremeyeceği bir kanalsa sunucu dürüstçe `null` döner ve katılma yine başarılıdır —
istemcide bu hata değil, "sunucu daveti gibi davran" demektir (§35: ulaşılamayacak bir
hedef reklam edilmez).

Kanıt: `packages/client-core/src/__tests__/channel-invite.test.ts` (13) ·
`__tests__/sidebar-visibility.test.ts` (13) ·
`packages/app-ui/src/components/ChannelSidebar.collapse.test.tsx` (16, jsdom — gerçek
bileşen; satır menüsü ile boş-alan menüsünün karışmadığını da kapsıyor) ·
`apps/desktop/src/renderer/src/components/channelRowControls.test.ts` (12) ·
Playwright ile görsel doğrulama: açık/katlı kenar çubuğu, boş-alan menüsü (yetkili ve
yetkisiz), davet modalı (metin ve sesli kanal hedefi, "Davet edildi" durumu).

## 2026-07-28 — Watch Party: SIRA (queue) + uygulama-içi YouTube ARAMA (sunucu, M20 / ADR 0016 wave 2)
Founder isteği: *"watch partye listeye video ekleyebilmek, link vermek değil de browser yap
içine, oradan seçsin. … watch party i açan kişi sıraya alsın sırayı değiştirsin ve videoyu
oynatsın."* **"İçine browser" REDDEDİLDİ** (ADR 0016 §Wave 2): `youtube.com` `X-Frame-Options`
ile çerçevelenmeyi reddediyor, ve bunu gerçekten yapabilecek tek mekanizma olan Electron
`<webview>`'ı açmak, wave 1'de tam da bunun için kurulan duvarı (tek-host `frame-src` +
`will-frame-navigate` kilidi + koşulsuz `setWindowOpenHandler` reddi) süs haline getirirdi.
Yerine: aramayı **biz** yapıyoruz, sonuçlar **bizim** listemizde. Bu dalga SUNUCU yarısı —
arayüz (sıra paneli + arama kutusu) ayrı dalga; iki istemci de `watch.queue_updated`'ı şimdilik
BİLİNÇLİ no-op olarak tanıyor, sahte arayüz yok.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| Sıra: veri modeli + olaylar (sunucu) | ✅ | ✅ | Platformdan bağımsız. Sıra, oynatma konumuyla AYNI TTL'li Redis oturum kaydının içinde — partisi biten bir sıra kimseye ait olmayan bir video listesidir. Yeni tipli olaylar: `watch.queue_add` / `_remove` / `_reorder` / `_play` / `watch.ended` → `watch.queue_updated`. Her mutasyon İNDEKS değil `itemId` (istemci-üretimi uuid) adlandırıyor: sırayı iki kişi (host + sunucu sahibi) sürüyor ve video bitince sunucu da değiştiriyor, yani bir an önce hesaplanan indeks başka satırı gösterebilir. `itemId` uuid — gevşek id olsaydı satırlarını "1,2,3" diye numaralayan bir istemci diğer sürücünün satırlarıyla çakışırdı ve ekleme idempotent olduğu için hata vermeden ikinci kişinin videosunu sessizce düşürürdü. |
| Sıra yetkisi = oynatma yetkisi | ✅ | ✅ | Yeni kapı İCAT EDİLMEDİ: aynı `authorize()` zinciri (işgal → üyelik/kanal türü → timeout → host ∨ sunucu sahibi). Founder "watch party'i açan kişi" dedi; host zaten o. Herkesin ekleyebildiği bir müzik kutusu ayrı bir ürün kararı olur ve yalnız `mayControl`'ü değiştirir. |
| Yeniden sıralama eşzamanlılık altında bozulmuyor | ✅ | ✅ | `watch.queue_reorder` "şu öğeyi şu indekse taşı" değil, **istenen TAM sıra**yı taşıyor; sunucu bunu elindeki listeye göre uzlaştırıyor (bilinmeyen id yok sayılır, anılmayan öğe mevcut göreli sırasıyla sonda kalır, hiçbir id iki kez çıkamaz). İki yarışan yeniden sıralama her zaman geçerli bir permütasyon bırakıyor; sonraki yalnız düzeni kazanıyor. İndeks tabanlı bir taşıma aynı yarışta sessizce YANLIŞ satırı taşırdı. |
| Sıra üst sınırı 50, dürüst reddediliyor | ✅ | ✅ | Yeni `RealtimeErrorCode`: `WATCH_QUEUE_FULL` (mesaj sayıyı ve çıkış yolunu söylüyor). `INVALID_PAYLOAD` kullanılsaydı kullanıcıya videosunun bozuk olduğu söylenmiş olurdu — videosu iyiydi. Sessiz düşürme yok; bir silme tekrar yer açıyor. |
| Video bitince otomatik sonraki | ✅ | ✅ | **Host istemcisi "bitti" der, SUNUCU ilerletir.** Gerekçe: ağ geçidi oynatma için YouTube'u hiç çağırmıyor (özelliğin ücretsiz olmasının sebebi bu), dolayısıyla videonun SÜRESİNİ hiç öğrenmiyor ve bitişi kendi zamanlayamaz; host'un oynatıcısı ise anında biliyor ve host'un konumu zaten diğer tüm kontroller için otoriter. Sonucu sunucuda tutmak "sırada ne var" sorusunun istemciler arasında pazarlık edilmesini engelliyor. `watch.ended` biten `videoId`'yi taşıyor — bilgi değil **idempotency kalkanı**: oynatıcı ENDED'i birden çok kez bildirebilir, geç gelen bildirim video elle değişmişken düşebilir; eşleşmeyen her `watch.ended` yok sayılıyor, yani kopya bir kare sıradan fazladan öğe yiyemiyor. |
| Sıra boşalınca parti BİTMİYOR | ✅ | ✅ | Son videoda duruyor (aynı video, `playing:false`). Oturumu bitirmek, oda hâlâ orada oturmuş sırada ne izleyeceğini konuşurken partiyi yıkmak olurdu — ve `watch.stopped` kanal genelindeki "parti sürüyor" rozetini temizleyen sinyal, o rozet hâlâ görünmeli. Partinin bitmesinin iki dürüst yolu değişmedi: host durdurur, ya da oda boşalır. |
| Sıra sıcak kareye BİNMİYOR (§27) | ✅ | ✅ | `watch.queue_updated` ayrı bir olay ve YALNIZ işgalcilere, YALNIZ değişince gidiyor. `watch.state` 5 sn'lik sürüklenme kalp atışı — bu özelliğin açık ara en sık gönderdiği kare ve her tikte değişen bir sayıyı taşımak için var. Sırayı içine katmak, beş saniye öncekiyle neredeyse hep aynı olan bir listenin boyunu bu kareye çarpmak olurdu. İstemci sırayı odaya girerken ve her değişimde alıyor; testle kanıtlı (kalp atışı sessizliği). |
| Canlı oturumlar bu deploy'da ÖLMÜYOR | ✅ | ✅ | Üretimde ŞU AN `queue` alanı olmayan oturum kayıtları var. `parseRecord` bunu geçersiz kayıt saymıyor — eksik/bozuk sıra boş sıra olarak okunuyor; aksi halde bu deploy'un indiği anda süren her watch party ölürdü. Testle kanıtlı. |
| Uygulama-içi YouTube arama (uç) | ✅ | ✅ | Yeni modül `apps/api/src/modules/watch`. `GET /watch/search?channelId&q` → normalize sonuç (videoId, başlık, kanal, süre, kapak). `search.list` (100 birim) + TEK toplu `videos.list` (1 birim) — 15 ayrı süre sorgusu 15 birim ederdi; süre sorgusu başarısız olursa arama ölmüyor, `durationSeconds: null` dönüyor (100 birim zaten harcandı). Anahtar SUNUCUDA kalıyor, istemciye asla gitmiyor. Yalnız oturum açmış + o kanalı GÖREBİLEN + kanal SESLİ ise arayabiliyor (yoksa herhangi bir hesap bizim anahtarımızı harcayan bedava YouTube proxy'si olurdu); görünmeyen kanal 403 değil 404. |
| Kota: gerçek tavan, gerçek bütçe | ✅ | ✅ | Google günde proje başına 10.000 birim veriyor, arama 100 (+1) → **tüm dağıtım için günde ~99 arama**. Dört katman: oturum başına HTTP hız sınırı (10/10 sn), kullanıcı başına günlük 25 arama, dağıtım geneli 9.000 birimlik bütçe (gerçek tavanın %10 altında) **Redis'te** (süreç-içi sayaç her deploy'da sıfırlanır; gün içinde birkaç deploy bütçeyi katlardı), ve 10 dakikalık sonuç önbelleği (aynı sorguyu tekrar çalıştırmak bedava ve kullanıcı kotasından düşmüyor). Yukarı akış hatası İADE EDİLMİYOR: YouTube hatayla yanıtladığı çağrıyı da ücretlendiriyor, iade etseydik güvenilir şekilde hata tetikleyen bir istemci bütçeye hiç dokunmadan gerçek kotamızı yakabilirdi. |
| Anahtarsız = ölü buton DEĞİL (§35) | ✅ | ✅ | `YOUTUBE_API_KEY` yoksa arama ucu 503 `WATCH_SEARCH_DISABLED`, ve asıl önemlisi `GET /watch/capabilities` → `{ searchEnabled: false }`. İstemci arama kutusunu devre dışı göstermek yerine HİÇ göstermiyor, link-yapıştırma yoluna düşüyor. Üç ayrı hata kodu (`_DISABLED` / `_QUOTA` / `_UNAVAILABLE`) çünkü üçü tamamen farklı sürelerde açılıyor: hiç / YouTube'un gece yarısında / belki bir dakika içinde. Oynatma ve sıra anahtarsız da tam çalışıyor — hiçbiri anahtara ihtiyaç duymadı. |
| Dış yanıta güvenilmiyor | ✅ | ✅ | Dönen her `videoId` bizim `parseYouTubeVideoId` kapımızdan yeniden geçiyor; geçemeyen sonuç ONARILMIYOR, DÜŞÜRÜLÜYOR. `thumbnailUrl` yanıttan ALINMIYOR, doğrulanmış id'den **biz** kuruyoruz — yanıtın URL'i her üyenin makinesinde `<img src>` olarak render edilecek dışarıdan kontrollü bir dize olurdu. Başlık/kanal adı kontrol + sıfır-genişlik + bidi karakterlerinden arındırılıp sınırlanıyor. Varsayılan fetch YÖNLENDİRME İZLEMİYOR: URL sorgusunda anahtarımız var, yönlendirmeyi izlemek onu yönlendirmenin gösterdiği host'a teslim etmek olurdu. |
| Sıradaki başlık = güvenilmeyen METİN | ✅ | ✅ | Ağ geçidinin kendi metadata kaynağı yok, ve 50 satırlık opak 11-karakterlik id listesi kullanılabilir bir sıra değil — bu yüzden `title`/`durationSeconds` ekleyen istemciden geliyor. Protokol sınırında temizleniyor (kontrol/sıfır-genişlik/bidi → boşluk, sonra 120 karakter sınırı), hiçe inen başlık `null` oluyor, ve `addedBy` sunucu gerçeği olarak her satırı sahibine bağlıyor. Sözleşmede DÜZ METİN olarak belgeli: istemci markup/link olarak render etmeyecek. |

**Ölçüler** (`packages/config`, tek kaynak): `WATCH_QUEUE_MAX_ITEMS=50`,
`WATCH_QUEUE_TITLE_MAX_LENGTH=120`, `WATCH_SEARCH_DAILY_UNIT_BUDGET=9000`,
`WATCH_SEARCH_PER_USER_PER_DAY=25`, `WATCH_SEARCH_MAX_RESULTS=15`,
`WATCH_SEARCH_CACHE_TTL_MS=10dk`, `YOUTUBE_QUOTA_RESET_UTC_OFFSET_HOURS=-8` (YouTube kotası
Pasifik gece yarısında sıfırlanıyor; sabit -8s yaklaşımı yılın bir kısmında 1 saat kayabilir,
bütçemiz gerçek tavanın %10 altında olduğu için bu kayma harcayamadığımız kotayı harcatamaz).

**Founder'ın çalıştırması gereken (opsiyonel, arama için):** Google Cloud projesi → "YouTube
Data API v3" etkinleştir → API anahtarı oluştur → yalnız o API'ye kısıtla → `.env.prod`'a
`YOUTUBE_API_KEY=...` ekle → `bash scripts/deploy-remote.sh`. Anahtar EKLENMEZSE hiçbir şey
bozulmaz; arama kapalı kalır, link yapıştırma çalışır.

Kanıt: `apps/realtime/src/__tests__/gateway.watch-queue.int.test.ts` (13, gerçek soket) ·
`apps/realtime/src/__tests__/watch-queue-reorder.test.ts` (8) ·
`packages/protocol/src/__tests__/watch-queue.test.ts` (15) ·
`apps/api/src/__tests__/watch-search.int.test.ts` (11) ·
`apps/api/src/__tests__/watch-search.unit.test.ts` (15) ·
`apps/api/src/__tests__/watch-search-fetch.int.test.ts` (6 — VARSAYILAN fetch seam'i yerel bir
HTTP sunucusuna karşı: yalnız mock'lanan bir seam kimsenin çalıştırmadığı seam'dir, unfurl dersi) ·
`packages/db/src/__tests__/watch-party.test.ts` (+4, sıra kalıcılığı ve QUEUE'SUZ eski kayıt).

**Sonraki dalga (arayüz):** masaüstü/web sıra paneli + arama kutusu (`searchEnabled` bayrağına
göre arama kutusu ya da link-yapıştırma), ve mobil oynatıcı (hâlâ tüm `watch.*`'ı no-op).

## 2026-07-29 — Watch Party: SIRA paneli + uygulama-içi YouTube araması (masaüstü + web, M20)

Founder isteği birebir: *"watch partye listeye video ekleyebilmek, link vermek değil de
browser yap içine, oradan seçsin. … watch party i açan kişi sıraya alsın sırayı değiştirsin
ve videoyu oynatsın."*

**"İçine browser" YAPILMADI, ve bu bir eksiklik değil bir karar.** `youtube.com`
`X-Frame-Options: SAMEORIGIN` gönderiyor — çerçevelenmeyi reddediyor — ve Electron
`<webview>` açmak, bu özelliğin üzerine kurulduğu kapanımı (tek çerçevelenen origin, tek
CSP satırı, yeni script origin'i yok) delerdi. İsteğin GERÇEKTEN istediği şey — uygulamadan
çıkmadan, tarayıcıda link avlamadan video seçmek — kendi arayüzümüzdeki arama ile karşılandı.

| Özellik | Masaüstü + Web | Mobil | Not |
|---|---|---|---|
| Sıra paneli (şimdi oynayan + sıradakiler) | ✅ | ✅ | Oynatıcının YANINDA, sahnenin içinde: `WatchPartyStage` artık oynatıcı + panel satırı. Oynatıcı satırda ÖNCE geliyor ve panel ondan SONRA takılıp sökülüyor — iframe'in ağaçtaki yeri değişmesin diye. Değişseydi panel her açılışta embed'i remount eder, el sıkışmayı yok eder ve videoyu sıfırdan başlatırdı. Panel herkese açık, varsayılan AÇIK, katlanabilir (16:9 video dar pencerede genişliği geri ister). Bileşen `packages/app-ui`'de → web aynı kodu alıyor, mobil dalgası da alabilecek. |
| Yetkisiz kullanıcı sırayı GÖRÜR, değiştiremez | ✅ | ✅ | §35: devre dışı ikiz YOK. İzleyicinin panelinde hiç düğme render edilmiyor (test boş dizi bekliyor), satırlar `draggable` değil. Yetki `host ∨ sunucu sahibi` — oynatıcının kullandığı `watchControlMode`'un aynısı, yani panel ve transport aynı kararı veriyor. Kozmetik kapı; ağ geçidi her kareyi yeniden karara bağlıyor. |
| Sırayı yeniden sıralama — sürükle-bırak **ve** klavye | ✅ | ⛔ | Sürükle-bırak tek yol DEĞİL: her satırda gerçek `<button>` yukarı/aşağı taşı (tab sırasında, klavyeyle çalışır, dokunmatikte de çalışır — HTML5 drag olayları orada yok). Uçlarda düğme devre dışı bırakılmıyor, HİÇ render edilmiyor. Kontrol kümesi satırda `absolute` konumlu: akışta olsaydı 256px panelin ~110px'ini kalıcı yerdi (opacity 0 iken bile) ve host'un başlıkları iki kelimeye kırpılırdı — sırada ne olduğunu en çok okuması gereken kişi. Playwright ile doğrulandı: host ve izleyici satırları dinlenme hâlinde AYNI genişlikte başlık gösteriyor. |
| Her işlem `itemId` ile, index ile DEĞİL | ✅ | ✅ | Sıra ayağımızın altından kayıyor (host'un `watch.ended`'i başı tüketiyor, `watch.queue_updated` render ile tık arasına düşebiliyor), dolayısıyla render anında yakalanan bir index tıklandığında BAŞKA videoyu adlandırabilir. `moveQueueItem`/`dropQueueItem`/kaldır/şimdi-oynat hepsi id alıyor; "liste altından kaydıktan sonra aynı id" testleri hem saf hem DOM seviyesinde var. `watch.queue_reorder` TAM sırayı yolluyor (sunucu da öyle bekliyor) → bayat bir görünümden hesaplanan sıralama bozmak yerine yakınsıyor. |
| Uygulama içinden YouTube araması | ✅ | ✅ | Tek girdi, iki anlam: alan `parseYouTubeVideoId` ile önce ayrıştırılıyor — ayrıştırılabilen bir referans DOĞRUDAN gönderiliyor (kota harcamadan), ayrıştırılamayan bir metin arama oluyor. `GET /watch/search` (sunucu tarafı zaten canlıydı). Aynı diyalog üç yerde: partiyi BAŞLAT, videoyu DEĞİŞTİR, SIRAYA ekle — böylece "uygulamadan seç" İLK video için de geçerli, ki isteğin asıl anı orası. Eski `WatchPartyLinkDialog` silindi (iki benzer diyalog = biri aramasız kalır). |
| Kota koruması (~100 arama/gün, TÜM kurulum için) | ✅ | ✅ | Tuş vuruşuyla arama YOK — debounce'lu bile değil, hiç: 12 karakterlik bir sorgu 300ms debounce ile bile ~8 istek eder, günlük bütçeyi iki kişi bitirir. Arama yalnız AÇIK bir eylemle (Enter / düğme). Üstüne: aynı sorgu tekrar gönderilirse istek yok, sonuçlar sorgu başına önbellekte, 700ms gönderim soğuması çift-Enter/çift-tıkı yutuyor, sıra numarası yavaş bir yanıtın hızlı olanı ezmesini engelliyor. `useQuery` KULLANILMADI — focus/remount refetch'i, kimsenin istemediği anda paylaşılan bütçeden harcardı. Hatalar önbelleğe alınmıyor (kota geceleri sıfırlanır). Mobil aynı disiplini uyguluyor (`components/watch/WatchVideoPickerSheet.tsx` — açık eylemle arama, sorgu başına önbellek + soğuma); ayrıntı aşağıdaki mobil dalga bölümünde. |
| Arama kapalıysa arama kutusu YOK | ✅ | ✅ | `GET /watch/capabilities` `searchEnabled:false` dönerse arama düğmesi/kutusu hiç render edilmiyor; diyalog link-yapıştırma diyaloğuna dönüyor, açıklama ve placeholder da öyle. Ölü düğme yok (§35). Yetenekler yüklenirken (`null`) de arama gösterilmiyor — affordance bir kez belirsin, içeri girip çıkmasın. Mobil karşılığı `WatchVideoPickerSheet.tsx` (`searchEnabled === true` değilse kutu hiç çizilmiyor). |
| Üç arama hatası, üç ayrı cümle | ✅ | ✅ | `WATCH_SEARCH_DISABLED` (bu sunucuda hiç yok — hep link yapıştır) / `WATCH_SEARCH_QUOTA` (bugünlük bitti, **her gece sıfırlanır** — bu ayrıntı olmadan "kapalı" gibi okunur) / `WATCH_SEARCH_UNAVAILABLE` (birazdan tekrar dene). Testte dördü de (bilinmeyen dâhil) BİRBİRİNDEN FARKLI ve dördü de çalışan yolu (link) gösteriyor. Üç kod `ApiClientErrorCode`'a eklendi; mobil + masaüstü `errors.ts` haritalarında bilinçli `errors.generic` (o yüzeyler bu rotayı çağırmıyor). Mobil eşlemesi `apps/mobile/src/components/watch/watch-queue.ts` (üç kod, üç ayrı mobil dize). |
| Sıra dolu hatası dürüstçe gösteriliyor | ✅ | ✅ | `WATCH_QUEUE_FULL` artık `WATCH_ONLY_ERROR_CODES` kümesinde — dört watch kodunun tek yayıcısı watch-party koordinatörü, dolayısıyla atıf başka özellikten çalamıyor. Dördü içinde kullanıcının ANINDA düzeltebileceği tek kod bu (birini çıkar), bu yüzden `console.warn`'a düşmesi en kötüsü olurdu. TR+EN ayrı cümle. |
| Video bitince sıra ilerliyor — raporu YALNIZ host yolluyor | ✅ | ✅ | Wave 2'de hiç kimse `watch.ended` YOLLAMIYORDU, yani otomatik ilerleme hiç çalışmıyordu. Artık host'un oynatıcısı `PLAYER_STATE.ended`'de gönderiyor. Herkes gönderseydi sunucu İLK raporu doğru sayar, oda önde giden üyeye göre ilerler ve reklamı erken biten biri videonun son saniyelerini herkese kestirirdi. Gönderilen id oturumun videosu (iframe'in son yüklediği değil) + videoId başına tek sefer koruması. Mobil karşılığı `WatchPartyPlayer.tsx:343` (`PLAYER_STATE.ended`, videoId başına tek sefer koruması). |
| Başlıklar METİN olarak render ediliyor (XSS yok) | ✅ | ✅ | `title`/`channelTitle` başka bir kullanıcının aramasından gelen, sunucuda sınırlanmış ama güvenilmeyen metin. React text node'u olarak basılıyor: markdown yok, link yok, `dangerouslySetInnerHTML` yok. Test: `<img onerror>` + `<script>` içeren başlık ekranda birebir string olarak görünüyor, DOM'da 0 `<img>` / 0 `<script>`. Başlıksız öğe ham 11 karakterlik id'yi DEĞİL "Adsız video"yu gösteriyor. |
| Kapak görselleri (CSP `img-src`) | ✅ | — | YouTube kapakları `https://i.ytimg.com`'dan geliyor; üretim CSP'si `img-src`'i storage origin'ine SABİTLİYOR, yani kapaklar sessizce kırılırdı. Tek host eklendi — masaüstü (`electron.vite.config.ts`) **ve** `Caddyfile` (web), ikisi birden. Yalnız `img-src`: yeni script/connect/frame origin'i yok, ve URL'leri kendi sunucumuz doğrulanmış 11 karakterlik id'den kuruyor. `scripts/check-caddyfile.mjs`'e iki yüzeyin ayrışmasını engelleyen kilit-adım kuralı eklendi. **Playwright ile gerçek kanıt:** paketlenmiş build'in TAM CSP metniyle bir sayfa yüklendi → i.ytimg.com görseli YÜKLENDİ, başka bir https host BLOKLANDI, satır-içi handler'lar bloklandı (yani politika gerçekten uygulanıyor). |
| Şimdi oynayan videonun adı | ✅ | ✅ | Oturum karesi yalnız id taşıyor ve bir öğe OYNAMAYA BAŞLADIĞI an sıradan siliniyor — yani herkesin baktığı tek video, panelin adlandıramadığı tek video olurdu. Store `videoId → başlık` haritası tutuyor, her `setQueue`'da sıradan yeniden kuruluyor + oynayanınki taşınıyor: kanal başına en fazla 51 string, sıra boşaldıkça kendini temizliyor, tahliye politikası yok. |

Kanıt: `packages/app-ui/src/components/watchQueue.test.ts` (22, saf) ·
`WatchQueuePanel.test.tsx` (19, jsdom — host/izleyici ayrımı, klavyeyle sıralama, XSS) ·
`WatchVideoPicker.test.tsx` (26, jsdom — arama kapalı, kota disiplini, üç hata metni) ·
`apps/desktop/src/renderer/src/stores/watch-party-store.test.ts` (+10: sıra dilimi, başlık
haritası, `WATCH_QUEUE_FULL`) · `scripts/check-caddyfile.mjs` (+2 img-src kilit-adım kuralı).

**Mobil (⛔ hepsi):** mobil hâlâ tüm `watch.*` olaylarını no-op'luyor ve oynatıcısı yok
(`react-native-webview` kurulu değil, native olduğu için OTA ile gelemez). Sıra paneli +
arama, mobil oynatıcı dalgasının üstüne gelmeli; sunum bileşenleri `packages/app-ui`'de
durduğu için o dalga onları yeniden yazmak zorunda kalmayacak.

## 2026-07-29 — Watch Party sırasında ping fırlaması (founder P0, medya)

Founder: *"watchpartyde çok ping giriyor onu fark ettim. düzelt onu."* Ölçüm iki AYRI
neden buldu; ikisi de düzeltildi.

| Özellik | Masaüstü + Web | Mobil | Not |
|---|---|---|---|
| Ping göstergesi ana-iş-parçacığı gecikmesinden ARINDIRILDI | ✅ | ✅ | **Asıl neden.** Gösterilen "ping" livekit'in sinyal-RTT'siydi: `Date.now() - lastPingTimestamp`, iki damganın İKİSİ de ana iş parçacığında alınıyor (pong, WebSocket `onmessage` içinde damgalanıyor). Ping ile pong ARASINA düşen her uzun görev raporlanan sayıya 1:1 ekleniyor — yani watch party'de herkesin kendi iframe'inde film oynatmasının ürettiği renderer jank'i, AĞ gecikmesi diye gösteriliyordu. Gerçek soketle ölçüldü (pong sabit 40 ms tutuldu): boşta p95 **42 ms**, 350 ms'lik uzun görevler enjekte edilince AYNI formül p95 **355 ms / max 384 ms** — gerçek RTT hiç değişmeden. p50 hep 41 ms kaldı, ki bu founder'ın "sürekli yüksek" değil "fırlıyor" demesiyle birebir örtüşüyor. Artık `candidate-pair.currentRoundTripTime` (getStats) birincil kaynak: libwebrtc bunu kendi ağ iş parçacığında STUN'dan ölçüp SAKLIYOR, biz sadece okuyoruz — bloklanan iş parçacığı okumanın ZAMANINI geciktirir, DEĞERİNİ değil. Aynı jank altında sonuç p95 **43 ms / max 44 ms**. Sinyal-RTT yalnızca ilk STUN turu ölçülene kadar yedek. **Mobil de taşındı (o dalga indi):** `apps/mobile/src/media/livekit-room.ts:774-808` `createConnectionQualityProbe` aynı `candidate-pair` / `currentRoundTripTime` kaynağını kullanıyor, sinyal-RTT orada da yalnız yedek; kaynak seçimi `apps/mobile/src/media/__tests__/rtt-probe-source.test.ts` ile kilitli. |
| Bant genişliği baskısı sinyali (`setBandwidthPressure`) | ✅ | ✅ | **İkinci neden + genel dikiş.** Watch party'de KİMSE ekran paylaşmıyor: film her istemcinin kendi `youtube-nocookie` iframe'inde YEREL oynuyor, dolayısıyla sesli oda her istemcinin ayrıca çok-megabitlik bir video indirdiğini göremiyordu — ve `adaptScreenShareToUplink` yerel paylaşım yoksa erken dönüp tamamen atıl kalıyordu. Motora artık ÖZELLİK değil KOŞUL bildiriliyor: `setBandwidthPressure(source, active)`, kaynak-anahtarına göre ref-sayımlı (watch party ilk tüketici; büyük yükleme/indirme, ölçülü mobil bağlantı, ileride "birlikte dinle" aynı dikişi kullanır). Baskı altında yerel KAMERA 640×360@30 / 800 kbps ile yayınlanıyor (fhd'de ~4,2 Mbps, auto/hd'de ~1,7 Mbps UPLINK serbest kalıyor) ve ekran-paylaşımı adaptif kontrolcüsünün tabanı 720p30 → 480p30'a iniyor. Uplink kasıtlı hedef: ev bağlantıları asimetrik, dolu bir uplink filmin kendi TCP ACK'lerini de geciktirir. Abone tarafına DOKUNULMADI — `adaptiveStream` uzak kamera katmanlarını zaten karo boyutuna göre seçiyor ve bir pin `VideoStage`'in odak efektiyle çakışırdı. **Mobil bağlandı:** `apps/mobile/src/stores/voice-store.ts:530` `engine.setBandwidthPressure(BANDWIDTH_SOURCE_WATCH_PARTY, active)`. |
| SES hiçbir baskı durumunda kısılmıyor (§6) | ✅ | ✅ | Baskı YALNIZCA video kolu. Mikrofon bitrate'i, capture kısıtları ve abonelikler değişmiyor; deafen/mute'a dokunulmuyor. Test bunu iki motoru yan yana koşup mikrofon publish argümanlarının BİREBİR aynı olduğunu doğrulayarak koruyor — ayrışırsa test kırılır. |

Kanıt: `packages/media/src/__tests__/engine.test.ts` (+12: kısıtlı kamera tier'i, bırakınca
geri dönüş, baskı sırasında açılan kamera, hafif seçimi ASLA yükseltmeme, ref-sayımı,
idempotency, kamera kapalıyken dokunmama, **ses değişmezliği ×2**, sinyal yokken davranışın
aynı kalması, boş kaynak anahtarı, taban derinleşmesi). Taban testi mutasyonla doğrulandı:
`PRESSURE_SCREEN_SHARE_FLOOR` normal tabanla değiştirilince test 2 500 000'de kırılıyor.
Yeni dosya `packages/media/src/bandwidth.ts`; masaüstü bağlantısı `voice-store.ts` içinde
iki mağazayı uzlaştıran `syncBandwidthPressure` (kare dinleyicisi DEĞİL: parti biz odadayken
başlayıp bitebilir, biz de partisi çalışan bir odaya girip çıkabiliriz).

**Mobil takibi:** `setBandwidthPressure` motorda (paylaşılan `packages/media`) hazır ve
mobilde çağrılmıyor — mobilin watch party oynatıcısı henüz yok, dolayısıyla baskı üreten bir
tüketici de yok. Mobil oynatıcı dalgası geldiğinde iki satır gerekiyor: aynı uzlaştırıcı
(`apps/mobile/src/stores/voice-store.ts`, motoru zaten `voiceEngine` olarak dışa veriyor) ve
`candidate-pair` prob düzeltmesinin `apps/mobile/src/media/livekit-room.ts`'e taşınması.
---
## M20 cilası — sunucu afişi + arama tamamlama (2026-07-29)
Roadmap'in "kalan cila" maddesinin iki yarısı. Migration **0022** (additive, tek NULLABLE
kolon: `friend_groups.banner_url`; 9.7k satırlık yerel veride uygulandı, ön-0022 kolonların
hiçbiri değişmedi, tekrar çalıştırmak no-op).
| Özellik | Masaüstü/Web | Mobil | Not / Görev |
| Sunucu afişi — yükleme (sahip) | ✅ | ⛔ | **#160 mobil parite.** `POST /groups/:groupId/banner`. Profil afişinin kural kümesi bire bir: satır-içi base64, aynı MIME beyaz listesi (GIF var, SVG ASLA — depolanmış XSS), 5 MB, aynı PUBLIC kova + aynı `SUPABASE_AVATAR_BUCKET` kapısı, `group-banners/<groupId>/<uuid>.<ext>`. Kova tanımsızken 503 → **üretim, founder yüklemeleri açana kadar değişmiyor**. Başarı mevcut `group.updated`'ı yayınlıyor: yeni olay yok, ağ geçidi değişmedi, her üyenin kenar çubuğu canlı tazeleniyor. |
| Sunucu afişi — yetki | ✅ | ⛔ | **YALNIZCA SAHİP**, ve bu yeni bir kural değil: `PATCH /groups/:groupId`'in sahip kontrolü `requireServerOwner`'a aynen taşındı ve iki yol da onu çağırıyor, yani ad/simge ile afiş asla farklı cevap veremez. Rol sistemi "sunucuyu düzenle" anlamına gelen bir yetki biti İÇERMİYOR (MANAGE_CHANNELS/ROLES/KICK_MEMBERS var), dolayısıyla onurlandırılacak bir yönetici katmanı yok — uydurmak yetki modeli değişikliği olurdu (§33, §6). Üye olmayan da grup-sohbeti id'si de 404 alıyor (üyelik/kind sızmıyor, §28). |
| Sunucu afişi — görsel doğrulama + **piksel bombası** | ✅ | ⛔ | Zincir: beyaz liste → base64 uzunluğu → çöz → gerçek uzunluk → sihirli baytlar → **piksel bütçesi**. Son adım #144'ün guard'ı, YENİDEN YAZILMADI: `isWithinPixelBudget` `packages/app-ui`'den `@demli/config`'e TAŞINDI (app-ui'de bir re-export bırakıldı), çünkü orada `apps/api` ona ulaşamıyordu. **Bu yüzden profil afişinde de bu koruma HİÇ YOKTU** — 5 MB'lık bayt sınırı aktarımı sınırlar, çözülmüş bitmap'i değil: ~300 KB'lık 40000×40000 bir PNG her kapıyı geçip render eden herkeste gigabayt olurdu. Artık iki afiş yolu da guard'ı çalıştırıyor ("profil afişindekinin aynısı" iki yönde de doğru). |
| Sunucu afişi — render (kenar çubuğu başlığı) | ✅ | ⛔ | Başlığın ARKASINDA katman; `h-16` geometrisi DEĞİŞMİYOR, yani afişli ve afişsiz sunucu birebir aynı yerleşim (altındaki hiçbir şey kaymıyor). Afiş yokken hiçbir şey render edilmiyor — boş kutu yok, kırık `<img>` yok (§35); `onError` katmanı düşürüyor, ölü URL bugünkü başlığa dönüyor. Perde İKİ katman: tekdüze veil (her piksel için kontrast TABANI, chevron dâhil) + sola ağırlıklı gradyan (adın olduğu yer). Tek gradyan yetmiyor — **beyaza yakın afişle chevron kayboluyordu, Playwright'ta görüldü**. |
| Sunucu afişi — kaldırma | ✅ | ⛔ | `PATCH {bannerUrl:null}`; nesne kovadan da best-effort siliniyor. `PATCH` afişi rastgele bir URL'e YÖNLENDİREMİYOR (null dışı değer 400) — yönlendirebilseydi yukarıdaki bayt doğrulamasının tamamı isteğe bağlı hâle gelirdi (§28). "Kaldır" düğmesi yalnız kaldıracak bir şey varken var. |
| Mesaj arama — sonuca tıkla, **mesaja git** | ✅ | ⛔ | **#161 mobil parite.** Sonuç, pin panosunun M17'den beri kullandığı `requestMessageJump` dikişinden mesaja atlıyor (liste eski sayfalarda geri yürüyor, kaydırıyor, yakıyor). Panel bunu "güvenilir atlama hedefi yok" diye reddetmişti; pin panosu aksini kanıtlıyor ve sınır (`JUMP_MAX_PAGE_LOADS`) ikisinde de aynı. Satır eşleşen metni göstermeye devam ediyor, yani çok geriden gelen bir isabet bulunduğu yerde okunabilir kalıyor. |
| Mesaj arama — DM ve grup-DM'de | ✅ | ⛔ | DM'in stream'i ZATEN bir metin kanalı ve aynı uçta; eksik olan yetenek değil GİRİŞ NOKTASIYDI: `DmView`/`GroupChatView`'da arama düğmesi yoktu ve Ctrl+F yalnız sunucu `ChatView`'ında kayıtlıydı, yani üç sohbet yüzeyinin ikisinde sessizce hiçbir şey yapmıyordu. Kısayol `useChannelSearchHotkey`'e çıkarıldı, üçü de onu kullanıyor; panel `label` alıyor ki DM "Burak Demir sohbetinde ara" desin (uuid adlı gizli kanal değil). |
| Mesaj arama — klavye | ✅ | ⛔ | ↑/↓ gezen imleç, Enter mesaja gider, Esc kapatır; yüklenmiş son satırın ötesine ↓ sonraki sayfayı çeker (fare için "daha fazla yükle" ne yapıyorsa o). Satırlar tab durağı DEĞİL — görebildiğin sonuca ulaşmak için elli satır tab'lamak gezinme değildir. Kural saf fonksiyon (`search-cursor.ts`, 15 test): boş, ilk, son, "henüz seçim yok", sarmala-DEĞİL-sabitle. |
| Mesaj arama — dürüst sayaç | ✅ | ⛔ | Etiket `results.length`'i, yani YÜKLENMİŞ olanı, toplammış gibi yazıyordu. API toplam döndürmüyor; başka sayfa varken artık "20+" diyor — her "daha fazla yükle"de değişen bir sayı, dürüst bir alt sınırdan kötüdür. |
**Bilinçli KAPSAM DIŞI (yeni API yüzeyi, kendi dalgası):** filtreler (`from:` / `has:` /
tarih), sunucu geneli arama, alaka sıralaması (`ts_rank`), ILIKE kolu için trigram index.
Bunlar mevcut olanın tamamlanması değil, yeni sorgu parametresi + SQL + index işi.
Kanıt: `apps/api/src/__tests__/group-banner-api.int.test.ts` (17 — sahip evet/üye 403/yabancı
404, PNG etiketli SVG, gerçek GIF bombası, boyutunu söylemeyen başlık, PATCH kaçak yolu,
kaldırmada nesne temizliği, yeniden adlandırma afişe DOKUNMUYOR, 503 kapalıyken, 422 NSFW) ·
`packages/app-ui/src/components/ChannelSidebar.banner.test.tsx` (8 — yarısı negatif: afiş yok
→ `<img>` yok, ad duruyor, yükseklik aynı) ·
`apps/desktop/src/renderer/src/lib/search-cursor.test.ts` (15).
**Playwright ile gerçek uygulamada doğrulandı** (yerel API + web, gerçek Postgres): afişsiz ve
afişli başlık yan yana (geometri aynı), koyu ve **beyaza yakın** afişle okunabilirlik, sunucu
ayarlarında önizleme + "Kaldır", kaldırma sonrası "Afiş yok" + kenar çubuğunun eski hâline
dönmesi, sunucu kanalında arama (9 sonuç, vurgu, klavye imleci, Enter → doğru mesaj yandı),
grup-DM'de ve DM'de Ctrl+F ile arama.
**Mobil (⛔ hepsi):** `apps/mobile` bu dalgada HİÇ değiştirilmedi (paralel ajan sahipti).
Mobil ikizi OTA-safe: afişi grup başlığında render + sunucu ayarlarında yükleme
(`expo-image-picker` zaten profil afişi için bağlı), aramada `requestMessageJump`
(`apps/mobile/src/lib/message-jump.ts` VAR ve `ChatThread` zaten dinliyor) + DM/grup-DM
arama girişi. Alan `FriendGroup.bannerUrl` olarak protokolde hazır, mobil DTO'su onu bugün
görmezden geliyor.
## 2026-07-29 — Watch Party: MOBİL oynatıcı + sıra + arama (M20 parite dalgası)
Founder'ın kalıcı kuralı: iki platform parite olacak. Watch Party masaüstü/web'de canlıydı,
mobil ise tüm `watch.*` olaylarını bilinçli no-op'luyordu. Bu dalga o boşluğu kapatıyor.
**Senkron sayıları YENİDEN YAZILMADI, İÇE AKTARILDI.** 2 sn sürüklenme toleransı, 3 sn sessiz
dönem, 3→6→9→12 geri çekilme merdiveni, ≤0,5 sn saat kayması payı, host-seek eşiği ve embed
origin'i — hepsi `@demli/client-core`'dan okunuyor. Telefon 1,5 sn tolere edip dizüstü 2 sn
etseydi, telefon dizüstünün doğru saydığı bir konuma sarar, dizüstü dokunmaz, telefon
düzeltmeye devam ederdi: aynı odanın iki üyesi tek bir oynatma kafası üzerinde kavga eder.
| Özellik | Masaüstü + Web | Mobil | Not |
|---|---|---|---|
| Gömülü YouTube oynatıcı | ✅ | ✅ | Aynı resmî `youtube-nocookie` embed, aynı `enablejsapi=1` postMessage protokolü, harici script YOK. Fark yalnız TAŞIMA: masaüstü `iframe.contentWindow`'a doğrudan post edebiliyor, RN'de DOM yok — araya kendi yazdığımız tek-iframe'lik bir HTML belgesi ve `injectJavaScript`/`onMessage` röle'si giriyor (`watch-player-bridge.ts`). Protokol karelerini yine client-core kuruyor; bu dosya taşıma ekler, protokol eklemez. |
| Origin disiplini (iki yön) | ✅ | ✅ | Giden kareler açık `targetOrigin` ile — asla `"*"`. Gelen kareler yalnız `event.origin === YOUTUBE_EMBED_ORIGIN` **ve** `event.source === frame.contentWindow` ise geçiyor; ikisi de şart (origin tek başına aynı host'taki başka bir çerçeveyi kabul ederdi, source tek başına başka yere gitmiş kendi çerçevemizi). Belge kendi CSP'sini taşıyor: `default-src 'none'; frame-src https://www.youtube-nocookie.com` — bizim sayfamız o tek çerçeve dışında hiçbir şey yükleyemiyor. Masaüstündeki `will-frame-navigate` guard'ının mobil karşılığı `onShouldStartLoadWithRequest`: ÜST çerçeve yalnız bizim verdiğimiz belgeyi açabilir (embed'in "YouTube'da izle" bağlantısı ve end-card'ları oynatıcıyı bir web sayfasıyla değiştiremez), alt çerçeveler serbest (reklam/onay makinesi orada çalışıyor; kapanım CSP). `isTopFrame` gelmezse KAPALI tarafa düşüyor. |
| Host vs izleyici ayrımı — birebir | ✅ | ✅ | Host: `controls=1`, YouTube'un gerçek transport çubuğu, `detectHostControl` ne yaptığını izleyip yayınlıyor, kendine sürüklenme düzeltmesi uygulamıyor (eko döngüsü mimari olarak imkânsız). İzleyici: `controls=0` **ve** WebView `pointerEvents="none"` bir View'ın içinde. O sarmalayıcı süs değil: olmadan dokunuş gizli YouTube hedefine iner, izleyicinin oynatıcısı bir şey yapar ve düzeltici bir saniye sonra geri alır — çalışıyor görünüp kendini geri alan kontrol tam olarak §35'in yasakladığı şey. Devre dışı ikiz YOK; yerine kimin sürdüğü yazıyor. |
| `watch.ended` yalnız HOST'tan | ✅ | ✅ | Her istemci sonu kendi anında görür (reklamlar kişi başı, tamponlama farklı, arka plandan dönen telefon geç yakalar). Herkes raporlasaydı sunucu İLK raporu doğru sayar, oda önde giden üyeye göre ilerler, reklamı erken biten biri videonun son saniyelerini herkese kestirirdi. Gönderilen id oturumun videosu + videoId başına tek sefer. |
| Sıra: görüntüleme herkese, kontrol host'a | ✅ | ✅ | Masaüstünde oynatıcının YANINDA bir sütun; telefonda alt sayfa (`WatchQueueSheet`) — 390pt'lik bir ekranda aynı sütun ikisini birden okunmaz yapardı. İzleyicide mutasyon kontrolü HİÇ render edilmiyor (devre dışı ikiz değil). Yetki `host ∨ sunucu sahibi`, oynatıcının kullandığı `watchControlMode`'un aynısı → sayfa ve transport aynı kararı veriyor. |
| Sırayı yeniden sıralama | ✅ | ✅ | Masaüstünde sürükle-bırak + yukarı/aşağı düğmeleri; telefonda yalnız düğmeler — HTML5 drag olayları dokunmatikte zaten yok, yani bu bir eksiltme değil aynı kararın doğal sonucu. ≥44pt hedefler, uçlarda devre dışı bırakılmıyor HİÇ render edilmiyor, ikisi de `watch.queue_reorder`'a TAM sırayı yolluyor. Her işlem `itemId` ile, index ile değil (sıra ayağımızın altından kayıyor). |
| Uygulama içinden YouTube araması | ✅ | ✅ | Aynı tek-girdi-iki-anlam: alan önce `parseYouTubeVideoId` ile ayrıştırılıyor, ayrıştırılabilen referans DOĞRUDAN gönderiliyor (kota harcamadan), gerisi arama sorgusu. Telefonda o "önce link" sırası daha da önemli — en sık yapılan şey sohbete düşen bağlantıyı uzun basıp kopyalamak. Üç yer: partiyi BAŞLAT (sesli oda başlığındaki Tv düğmesi), videoyu DEĞİŞTİR, SIRAYA ekle. |
| Kota koruması | ✅ | ✅ | Tuş vuruşuyla arama YOK. Telefonda debounce masaüstünden DAHA kötü olurdu: yazmak yavaş, duraklama çok, her duraklama bir istek. Arama yalnız açık bir eylemle (klavyenin arama tuşu / düğme); 700ms gönderim soğuması dokunmatikteki çift-dokunuşu yutuyor; sorgu başına önbellek; sıra numarası yavaş yanıtın hızlıyı ezmesini engelliyor. `useQuery` KULLANILMADI — telefonda her arka plandan dönüş bir focus olayı, yani paylaşılan günlük bütçeden kimsenin istemediği harcamalar. |
| Arama kapalıysa arama kutusu YOK | ✅ | ✅ | `GET /watch/capabilities` `searchEnabled:false` dönerse arama kutusu/düğmesi hiç render edilmiyor; sayfa link-yapıştırma sayfasına dönüyor, açıklama ve placeholder da öyle. Yetenekler yüklenirken (`null`) da gösterilmiyor. Dört arama hatası dört ayrı TR+EN cümle. |
| Ağ geçidi reddi kullanıcıya ulaşıyor | ✅ | ✅ | `NOT_IN_VOICE` / `NOT_HOST` / `WATCH_NOT_ACTIVE` / `WATCH_QUEUE_FULL` — dördünün de tüm ağ geçidinde tek yayıcısı watch-party koordinatörü, dolayısıyla atıf başka özellikten çalamıyor. Mobilde de `console.warn`'a düşmüyor, sahnede dokununca kapanan bir şerit olarak çıkıyor. |
| **Arka plan → ön plan senkronu** | — | ✅ | Telefona özgü, masaüstünde karşılığı olmayan başarısızlık. Android aktivite gidince WebView'in zamanlayıcılarını donduruyor ve medyayı durduruyor: doksan saniye başka uygulamada kalan telefon, hiç durmamış bir odanın doksan saniye gerisinde dönüyor. Kurtarma senkron modelinin zaten içinde: `expectedPositionSec` sunucunun konumunu **yerel** varış anından ileri projeksiyonluyor, yani keyfi uzunlukta bir boşluğun ötesinde de doğru. Dönüşte her yerel okuma atılıyor, histerezis SIFIRLANIYOR (boşluktan kalma bir soğuma tam da önemli olan düzeltmeyi yutardı) ve oraya sarılıyor. İZLEYİCİ giderken duraklatılıyor (kimsenin görmediği kareler için pil/veri harcamasın, ve film sesi cebinde çalmasın); HOST duraklatılmıyor — bildirime üç saniye bakan host filmi herkes için durdurmamalı — bunun yerine `HostPlaybackSnapshot` takibi sıfırlanıyor, böylece platformun kendi durdur/devam'ı hiçbir `watch.control` karesi üretmiyor. |
| **Film sesi vs konuşma sesi** | ✅ (OS mikseri) | ✅ (oynatıcı sesi) | Kullanıcı aynı anda sesli odada. WebRTC odaya TEK bir playout track'i veriyor ve onun AudioAttributes'ı `media/audio-profile.ts` tarafından `Room.connect()`'ten ÖNCE bir kez kuruluyor (#121); RN SDK canlı anahtar sunmuyor. Bu yüzden watch party ses oturumuna DOKUNMUYOR — `configureAudio` çağırmıyor, audioMode değiştirmiyor, profili zorlamıyor. Onun yerine film sesi embed'in kendi `setVolume`'uyla ayarlanıyor (sıra sayfasında %100/%60/%30/Sessiz). Videoyu ve yalnız videoyu kısıyor: donanım yankı gidericisi ve Bluetooth mikrofon yolu el değmemiş kalıyor. Masaüstünde bu bir OS mikseri sorunu; telefonda tek ses tuşu zaten aramanın. |
| Ekran uyanık kalıyor | ✅ | ✅ | Ayrı bir kilide gerek yok: watch party sesli kanala bağlı ve yalnız odadayken render ediliyor, `VoiceKeepAwake` de `connected/joining/reconnecting` boyunca `expo-keep-awake` kilidini tutuyor. Film oynarken ekran sönmüyor. |
| Büyüt/küçült (landscape) | ✅ (pencere) | ✅ | 16:9 bir kare portre telefonda ekranın üçte biri. Oynatıcının köşesindeki düğme LANDSCAPE'i açıyor (tam ekran ekran-paylaşımının aldığı anlaşmanın aynısı, founder #70) ve başlık/durum şeridi/kontrol çubuğunu düşürüyor. Parti biterken `expanded` sıfırlanıyor → telefon boş bir sahnenin üstünde yan yatmış kalmıyor (paylaşım yolunun bir zamanlar yaşadığı hata). Küçültme her zaman tek dokunuş: düğme filmin üstünde duruyor. |
| Kiminle izlediğin görünüyor | ✅ | ✅ | Filmin altında katlanabilir katılımcı filmstribi — ekran paylaşımı sahnesindeki aynı tile'lar, aynı konuşma halkası. Birlikte izlemek hâlâ birlikte olmak: yanında yüz olmayan film sadece bir video. |
**Native bağımlılık:** `react-native-webview@13.16.1` (Expo SDK 57 uyumlu sürüm,
`npx expo install` ile çözüldü). Native olduğu için OTA ile GELEMEZ →
`runtimeVersion` 1.7.0 → **1.8.0**, `version` 1.8.0, `versionCode` 8.
Yayın sırası §32 adım 4'teki gibi bağlayıcı: önce APK derle, sonra publish,
EN SON `MOBILE_LATEST_RUNTIME` bump + deploy.
**Bilinçli kod tekrarı (tek yer):** `apps/mobile/src/components/watch/watch-queue.ts`,
`packages/app-ui/src/components/watchQueue.ts`'in dört saf fonksiyonunu tekrarlıyor
(`canMoveQueueItem` / `moveQueueItem` / `formatWatchDuration` / `watchSearchFailure`).
Sebep: `@demli/app-ui` bir react-dom paketi ve barrel'i `./components`'i yeniden ihraç
ediyor, yani Metro'dan import etmek dört saf fonksiyon için APK'ya bir DOM renderer'ı
sokardı; `exports` haritası da derin yol sunmuyor (`.` ve `./tokens.css`). Bu takas
yalnızca buradaki hiçbir şey makineler-arası bir anlaşma OLMADIĞI için kabul edilebilir —
sapma bir ok tuşunu bir satır fazla gösterir, bir odayı desenkronize edemez. Kalıcı çözüm
app-ui'ye dokunulan bir sonraki dalgada bu dosyayı client-core'a taşımak.
Kanıt: `apps/mobile/src/components/watch/watch-queue.test.ts` (14, saf) ·
`watch-player-bridge.test.ts` (16 — origin disiplini iki yön, CSP, attribute kaçışı,
enjeksiyon kaçışı, üst-çerçeve navigasyon guard'ı KAPALI-fail dâhil) ·
`apps/mobile/src/stores/__tests__/watch-party-store.test.ts` (16 — upsert'in "ilk kare"
dalı olmadığı, sıranın oturumla birlikte öldüğü, reddin odalar arası sızmadığı) ·
i18n TR+EN parite (57 yeni anahtar, `locale-parity.test.ts`) ·
`pnpm -r typecheck` + `pnpm lint` + `pnpm test` yeşil.
### Emülatör doğrulaması (AVD `demli-debug`, Android 14 / API 34, 2026-07-29)
Mobil medya işi cihazda çalıştırılmadan "bitti" sayılmaz (mobil ses-çökmesi dersi).
x86_64 debug APK derlendi, emülatöre kuruldu, canlı `api.getdemli.com` arkasında
mevcut QA hesabıyla sunucu sesli kanalında koşturuldu.
**Emülatörde görülenler:** Watch Party girişi yalnız odadayken ve parti yokken çıkıyor ·
sunucuda YouTube anahtarı olmadığı için sayfa link-yapıştırma varyantında açıldı, arama
kutusu HİÇ render edilmedi (§35) · parti başladı, WebView embed'i yükledi ve video oynadı ·
host'ta YouTube'un gerçek kontrolleri (scrubber/tam ekran/ayarlar) çıktı ve dokunulabilir ·
sıra sayfası: şimdi-oynuyor + film sesi çipleri + boş-durum metni · sıraya ekleme sunucu
turu (0→1, "… ekledi") · şimdi-oynat videoyu YERİNDE değiştirdi (WebView remount YOK,
sıra 1→0) · logcat'te tek bir fatal/exception yok.
| Doğrulanan risk | Sonuç | Kanıt |
|---|---|---|
| WebView ↔ embed köprüsü (iki yön) | ✅ | Embed'in `onError`'ı röleden geçip `parsePlayerMessage`'a ulaştı ve §26 metnimiz olarak render edildi; ardından `listening` el sıkışması + komutlar çalışıp video oynadı. Köprünün her iki yönü de gerçek trafikle görüldü. |
| **Arka plan → ön plan senkronu, OYNARKEN** | ✅ | 50 sn arka planda; dönüşte video donduğu yerden devam etmedi, sunucunun projeksiyonladığı saniyeye İLERİ sardı (sahne duvar saati kadar ilerlemişti). |
| **Arka plan → ön plan senkronu, DURAKLATILMIŞKEN** | ✅ | Host duraklattı (15,29 sn), 30 sn arka plan, dönüş: oynatıcı tam 0:15'te ve DURAKLATILMIŞ. Enstrümante edilmiş log: `resync {"playing":false,"pos":15.29,"exp":15.29}` — `expectedPositionSec` duraklatılmış oturumu ileri projeksiyonlamıyor. |
| Host kontrolü yakalanıyor, hayalet kare YOK | ✅ | `snap {prev:{playing:true…}, cur:{playing:false…}, intent:{action:"pause"…}}` → `send watch.control pause`. Sıradan ilerleme tiklerinin hepsinde `intent:null` (yani sürekli ilerleyen bir video sahte seek yayınlamıyor). Arka plandan dönüşteki ilk okuma `prev:null` → `intent:null`: temel sıfırlaması çalışıyor, platformun kendi durdur/devam'ı odayı durdurmuyor. |
| **Film sesi konuşmayı ezmiyor** | ✅ | Film oynarken `dumpsys audio`: `Actual mode = MODE_IN_COMMUNICATION`, sahibi hâlâ bizim uygulamamız. Film `USAGE_MEDIA` → STREAM_MUSIC; konuşma `USAGE_VOICE_COMMUNICATION` → STREAM_VOICE_CALL; dump'ta AYRI volume group'lar. Ses oturumuna hiç dokunulmadı. |
| Ekran uyanık | ✅ | `VoiceKeepAwake` zaten odadayken kilidi tutuyor ve parti yalnız odada render ediliyor; film boyunca ekran sönmedi. |
**Emülatörde bulunup düzeltilen GERÇEK hata — YouTube hata 153.** İlk denemede video
oynamadı: embed `onError 153` ("video player configuration error") döndü. Sebep taşıma
katmanındaydı: Android WebView, temel URL'siz satır-içi HTML'i OPAK bir origin'de yükler ve
`Referer` GÖNDERMEZ; embed de hiçbir siteye atfedemediği isteği reddeder. Masaüstü bunu
görmez çünkü `file://` altında koşar ve embed onu kabul eder — yani platformun tele
koyduğu şeyle ilgili, paylaşılan `buildEmbedUrl` ile ilgili DEĞİL (o `origin` parametresini
bilinçli göndermiyor; opak bir origin el sıkışmayı tümden bozar). Düzeltme taşımada:
belge `WATCH_DOCUMENT_BASE_URL` altında yükleniyor.
Bu URL YouTube'un origin'i DEĞİL, kendi web origin'imiz — ve bu ayrım güvenlik taşıyor:
çoğu RN sarmalayıcısının yaptığı gibi `https://www.youtube.com` iddia etseydik, embed'in
normal oynatma sırasında kendi alt çerçevelerini youtube.com'a taşıması o alt çerçeveyi
belgemizle AYNI ORIGIN yapardı; o da `parent.ReactNativeWebView.postMessage`'ı doğrudan
çağırıp röleyi ve iki kontrolünü de atlayarak sahte oynatıcı karesi üretebilirdi (odanın
videosunu atlatan sahte bir `ended`, sürüklenme düzeltmesini süren sahte bir konum).
Kendi origin'imiz aynı işi görüyor (embed'i atfedilebilir herhangi bir referrer memnun
eder) ve her YouTube çerçevesini cross-origin bırakıyor. Testle sabitlendi.
**İkinci düzeltme:** `originWhitelist` `["*"]` yapıldı. react-native-webview, whitelist'e
UYMAYAN bir URL'yi iptal etmez — `Linking.openURL`'e verir, yani sistem tarayıcısında açar.
Bu, bu özelliğin üzerine kurulduğu masaüstü kuralının tam tersi ("reddedilen gezinme iptal
edilir, harici olarak yeniden açılmaz") ve embed oynatma boyunca alt çerçeve gezindiği için
telefonu tarayıcı sekmeleriyle döşerdi. Tek kapı artık `allowWatchNavigation`, ve o gerçekten
iptal ediyor.
**Doğrulanmadı (açık risk):** iki istemcili senkron — host'un oynat/duraklat'ının bir
İZLEYİCİDE yansıması. Bu makinede tek QA kimliği var ve üretimde gerçek kullanıcılar
olduğu için ikinci hesap açılmadı. Host tarafı (niyet üretimi + `watch.control` gönderimi)
yukarıda logla kanıtlandı; izleyici tarafı (`nextSeekDecision` + oynat/duraklat dayatması)
masaüstünde canlıda çalışan AYNI `client-core` kodu ve 41 birim testiyle kaplı. Founder'ın
iki cihazlı testinde bakılacak ilk şey bu olmalı.
**Not (yayın hattı):** `scripts/build-mobile-apk.sh` bir worktree'den derlemeyi REDDEDİYOR
(Windows MAX_PATH; ajan worktree kökü 53 karakter, sınır 32) ve bu doğrulama için kısa
yollu geçici bir worktree'den x86_64 debug APK derlendi. Yayınlanabilir imzalı APK, dosyanın
kendi kuralı gereği MERGE SONRASI ana checkout'tan derlenmeli.
### Bant genişliği baskısı — mobil yarısı bağlandı
Ping dalgası (yukarıda) `setBandwidthPressure` dikişini motora koyup mobil tarafını
"oynatıcı gelince bağlanacak" diye açık bırakmıştı. Oynatıcı geldi, dikiş bağlandı.
| Özellik | Masaüstü + Web | Mobil | Not |
|---|---|---|---|
| Watch party sürerken bant genişliği baskısı bildiriliyor | ✅ | ✅ | `apps/mobile/src/stores/voice-store.ts` içinde masaüstünün ikizi olan uzlaştırıcı: iki mağazaya da abone (parti biz odadayken başlayıp bitebilir, biz de partisi çalışan bir odaya girip çıkabiliriz — kare dinleyicisi ikisini birden yakalayamaz). Baskı altında yerel KAMERA 640×360@30/800 kbps ile yayınlanıyor ve ekran-paylaşımı tabanı 480p30'a iniyor; SES hiçbir koşulda kısılmıyor (§6). Telefonda masaüstünden daha çok önemli: odadaki en kötü hat genelde telefon (mobil veri ya da uzak bir erişim noktası, downlink'in çok altında bir uplink), yani film gecesinde herkesin ping'ini fırlatmaya en yatkın istemci tam olarak bu. |
**KAPANDI (2026-07-30 denetimi):** o gün "hâlâ açık" yazan `candidate-pair` ping probu
mobilin kendi oda adaptörüne taşındı — `apps/mobile/src/media/livekit-room.ts:774-808`
`createConnectionQualityProbe`, sinyal-RTT yalnız yedek, kaynak seçimi
`apps/mobile/src/media/__tests__/rtt-probe-source.test.ts` ile kilitli. Geriye yalnız
founder cihazında ÖLÇÜM kalitesi doğrulaması kaldı (kod işi değil).

## 2026-07-29 — Mobil web: indirme hedefi + diyaloglar sayfa gibi (founder P0)

Founder telefon tarayıcısından girdi: sol-alttaki indir düğmesi ona kuramayacağı bir
Windows kurulumunu gösteriyordu ve açtığı modal düzgün açılmıyordu. İki düzeltme, ikisi de
WEB yüzeyinde (aynı renderer, masaüstü tarayıcıda davranış AYNEN korundu).

| Özellik | Masaüstü | Web (geniş) | Web (telefon) | Mobil native |
|---|---|---|---|---|
| Rail indir düğmesi | — (kurulu uygulama, UpdateBadge) | ✅ platform modalı | ✅ **doğrudan APK indirir**, modal YOK | — |
| iOS tarayıcı | — | — | ✅ düğme HİÇ görünmez (yapılmış bir sürüm yok, §35) | — |
| Diyaloglar dar viewport (≤899px) | — (pencere min 940) | değişmedi | ✅ alt-yaslı sayfa/sheet | — (native ekranlar ayrı) |

**"Mobil" tespiti UA ile, viewport ile DEĞİL** (`lib/device-platform.ts`). Soru "bu makine
hangi ikilimizi çalıştırabilir" — bir kapasite sorusu. Dar sürüklenmiş masaüstü penceresi
bir telefon DEĞİLDİR: ona APK verip Windows'u gizlemek çalışmayan bir indirme sunmak olurdu
(§35). `(pointer: coarse)` de yanlış — dokunmatik Windows dizüstü kurulumu ister.
`navigator.userAgentData.mobile` daha dürüst olurdu ama Safari'de yok ve apps/web iPhone 6 /
Safari 12 hedefliyor. Karar tek yerde: `railDownloadAction()` (`lib/download-surface.ts`,
7 test) → `hidden` | `direct` | `dialog`; düğmenin görünürlüğü, etiketi ve tıklaması aynı
karardan besleniyor, ayrışamazlar. Telefonda tek hedef kaldığı için modal ARA ADIM olurdu —
hiçbir şey seçtirmeyen bir adım bırakılmadı.

**Diyalog: 29 çağrı yerine prop eklenmedi.** Founder kuralı "küçükse küçük kalsın, büyükse
ekranı kaplasın" bir İÇERİK YÜKSEKLİĞİ kararı; hiçbir çağrı yeri kendi yüksekliğini bilmez.
Bu yüzden dar viewport'ta kart alt kenara yaslanıp `height:auto` + viewport tavanı alıyor
(tek medya sorgusu, `styles/globals.css`): onay kutusu küçük bir sheet olarak kalıyor,
ayarlar/davet/kaynak listesi tavana çarpıp sayfa oluyor. Sonradan eklenen diyaloglar da
doğru şekle kendiliğinden düşüyor. Kural KATMANSIZ yazıldı — Tailwind v4 utility'leri
`@layer utilities` içinde olduğu için katmansız CSS `!important` olmadan hem taban kartı hem
çağrı yeri genişliklerini (`max-w-sm`…`max-w-2xl`) eziyor.

Telefon ayrıntıları: `100dvh` (adres çubuğu `100vh`'i yalan söyletir) + Safari 12 için `vh`
fallback'i ÖNCE; `env(safe-area-inset-*)` (çentik altında kalan kapatma düğmesi işe yaramaz);
kapatma düğmesi 44×44; `overscroll-behavior: contain` (liste sonunda arka plana zincirlenme
yok); `interactive-widget=resizes-content` (Android klavyesi açılınca sheet ve input görünür
kalıyor — `#root` `height:100%/overflow:hidden` olduğu için klavye aksi halde üstüne biner);
`pop-in` yerine `sheet-in/out` (alt kenardan gelen yüzeye göze doğru büyüme yanlış jest).

**Yol boyunca bulunan iki gerçek hata:**
- Tailwind v4 `-translate-x-1/2`'yi `transform` değil standalone `translate` ÖZELLİĞİNE
  derliyor; `transform: none` tek başına sheet'i kendi genişliğinin yarısı kadar ekran dışına
  itiyordu. Ölçerek yakalandı, `translate: none` eklendi, kaynak-değişmez testle kilitlendi.
- `DownloadAppDialog` platform satırları grid öğesi ve `min-width:auto` taşıyordu; nowrap
  ipucu metni satırı 383px'e şişirip 375px kartın ~30px dışına taşırıyordu (İndir düğmesi
  kırpılıyordu). `min-w-0` eklendi.

Doğrulama: Playwright 375×667, 320×420, 375×300 (klavye) ve 1440×900 ekran görüntüleri +
ölçüm. 1440×900'da kart sayısal olarak değişmedi (max-w 672 = `max-w-2xl`, max-h 85vh,
translate -50% -50%, radius 12px, `pop-in`, kapatma 24×24). Sınır 899/900'da tam;
Electron pencere minimumu 940 olduğu için kurulu masaüstü uygulaması bu bloğa ASLA girmiyor.
### Landing yeniden yazımı — marka sistemi + anti-slop boru hattı
Landing üç yüzeyin hiçbirine ait değil (kurulmadan önce görülen sayfa), o yüzden matriste
platform sütunu yok; kaydı buraya §32 kapısı için düşülüyor.
| Özellik | Masaüstü + Web | Mobil | Not |
|---|---|---|---|
| Landing: Tavşan Kanı yönü + "Çayını al, gel." | ⛔ **GERİ ALINDI** | — | Founder 2026-07-29'da iki zevk kararını verdi (`docs/product/brand-system.md` §7/§8) ama o sayfa **revert edildi** (`c48650f` "revert(landing): back to the previous design", ardından `1d0450d` "the DARK page, which is the one that was live"). Canlı `apps/landing/src/components/` bugün Hero/Features/Downloads/SiteHeader/SiteFooter — saat damgalı akşam anlatısı DEĞİL; "Çayını"/"Tavşan" dizeleri repoda hiç geçmiyor. Yeniden yapılacaksa yeni görev açılmalı. |
| Landing: kırmızı ↔ hata rengi ayrımı testle kilitli | ⛔ | — | **Bu test yok.** `apps/landing/test/color-contract.test.mjs` diskte mevcut değil; `apps/landing`'de hiç test dosyası ve `package.json`'da `test` betiği yok. Üstteki revert'le birlikte gitti. |
| Landing: dokunma hedefleri 5 durumun HEPSİNDE ≥44px | ⛔ | — | **Bu test de yok** (`apps/landing/test/touch-target.test.mjs` mevcut değil). 44px kuralı hâlâ doğru bir hedef, ama şu an hiçbir şey onu zorlamıyor. |
**Bu dalganın asıl çıktısı sayfa değil, kapı:** `surface-brief` → üretim → `copy-voice` →
**üretenden farklı bir ajanın** `slop-check`'i. Landing iki tur FAIL aldı (ilki %41 jenerik
metin + 39px hedef, ikincisi 5 vuruşun 2'si hâlâ takas testinden geçiyor) ve ikisi de
düzeltildi. Kapı çalışıyor: aynı metin marka dokümanından geldiği için düzeltmeler
`brand-system.md` §7'ye de işlendi, yoksa bir sonraki yüzey aynı cümleleri miras alırdı.
**Ama sayfanın kendisi sonradan geri alındı** (üstteki üç satır) — kapının kaydı duruyor,
ürünü durmuyor.

## 2026-07-30 — Arama bağlantı güvenilirliği, SUNUCU yarısı (W1A / plan K2)

Founder bulgusu: *"birini özelden aradığımda bazen karşıdaki kabul etse bile bağlantı
sağlanamıyor. odadan çıkıp o kişiyi tekrar aramak zorunda kalıyorum."* Bu satırlar
sunucu-taraflıdır; istemci FSM yarısı W1B, mobil PiP W1C.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| `POST /dm-calls` yanıtı push'u BEKLEMEZ | ✅ (sunucu) | ✅ (sunucu) | Zil/geri-çekme/yükseltme push'ları artık fire-and-forget + yavaş/başarısız dispatch loglanır (`CALL_PUSH_SLOW_MS`). Eskiden Expo round-trip'i 201'in önünde duruyordu; aranan, arayan kendi çağrı kimliğini öğrenmeden kabul edebiliyordu. Tek uç, iki platform. |
| `GET /dm-calls/active` — çağrı düzlemi resync'i | ✅ | 🚧 istemci | Uç YAYINDA ve testli (`voice.resync` muadili, ama PULL): kullanıcının tek canlı çağrısı + peer + taraf + TAZE LiveKit kimlik bilgisi. Faz-dışı `call.accepted` düşürmek yerine buradan yeniden oturulur. Sözleşme: `packages/protocol/src/requests/dm-calls.ts`. **Masaüstü/web istemcisi İNDİ:** `apps/desktop/src/renderer/src/realtime/connection.ts:1007` her handshake-sonrası yeniden bağlanmada `getCallController()?.resyncActiveCall("reconnect")` çağırıyor (kontrolcü `packages/client-core/src/dm-calls/call-controller.ts:629`). **Mobilde hâlâ yok** — `resyncActiveCall` `apps/mobile/src` altında hiç geçmiyor. |
| Kabul EDİLMİŞ çağrıya gelen `cancel` → idempotent kapanış | ✅ (sunucu) | ✅ (sunucu) | 409 yerine hangup semantiği (`ended` + `call.ended{hung_up}` + süreli sistem mesajı). Founder'ın "odadan çıkmak zorunda kaldım" hissi buradan geliyordu: 409 istemcide yutuluyor, satır `active` kilitleniyor, tek çıkış 3-6 dakikalık süpürücüydü. |
| Zaten kapanmış çağrıya `cancel`/`hangup` → 200 | ✅ (sunucu) | ✅ (sunucu) | İki taraf aynı anda kapatınca ikincisine "başarısız" denmiyor; ikinci sistem mesajı / ikinci `call.ended` YOK (geçiş SQL'de `closeIfIn` ile korunuyor). |
| Kabul/iptal yarışında satır asla yanlış duruma yazılmaz | ✅ (sunucu) | ✅ (sunucu) | `activateIfRinging` + `closeIfIn`: `canceled` bir satır `active`e diriltilemez, `active` bir satır `canceled` diye damgalanamaz. Eski oku-sonra-yaz koruması bu pencereyi açık bırakıyordu. |

**Migration 0023 (additive):** `dm_calls` üzerinde iki KISMİ indeks
(`dm_calls_live_caller_id` / `dm_calls_live_callee_id`, yalnız `ringing`/`active`) — resync
her soket (yeniden)bağlantısında çağrıldığı için arama kaydı büyüdükçe seq-scan olmasın.
Kolon eklenmiyor, veri yazılmıyor.

**Kanıt (mutasyonla kırıldığı doğrulandı, "kapı yeşil ≠ kapı çalışıyor"):**
`apps/realtime/src/__tests__/dm-call-early-accept.int.test.ts` — GERÇEK Postgres + GERÇEK
gateway soketi + gerçek API: zil aranana ulaşır, aranan kabul eder, arayanın soketine
faz-dışı `call.accepted` düşer, `POST /dm-calls` HÂLÂ dönmemiştir; arayan
`GET /dm-calls/active` ile `active` çağrıya oturur ve odaya girecek kimlik bilgisini alır.
Sıra rastgele değil, yayın kapısı test tarafından tutuluyor (gate kaldırılınca test kırılıyor
— doğrulandı). `apps/api/src/__tests__/dm-calls.int.test.ts` — 12 yeni test:
cancel-sonrası-accept, idempotent kapanışlar, resync gövde şekilleri, süresi geçmiş zilin
resync'te reap'lenmesi ve **askıda kalan push ile 201** (mutasyonda 30s timeout ile kırıldı).

## 2026-07-30 — Arama bağlantı güvenilirliği, MOBİL kablolama (W1C / plan K2)

W1A sunucuyu kapattı, paylaşılan istemci düzeltmeleri
(`packages/client-core/src/dm-calls/`) ikisinde de aynı kod. **Ama onları TETİKLEYEN
platform kablolaması yalnız masaüstünde bağlanmıştı** — telefonda eski davranış aynen
duruyordu: karşı taraf kabul etse bile bağlanmayabiliyor, kurtulmanın tek yolu odadan
çıkmak oluyordu. Founder mobil kullanıyor.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| WS yeniden bağlanınca çağrı düzlemi resync (`GET /dm-calls/active`) | ✅ | ✅ | `apps/mobile/src/realtime/connection.ts` handshake dalında, yalnız RE-connect'te (`hadHandshake`). `call.accepted` kuyruksuz/replaysız fan-out: telefonun wifi→veri geçişi, ekran-kapalı doze'u ya da deploy'daki gateway restart'ı cevabı SONSUZA DEK yutuyordu — arayan zaman aşımına düşerken aranan canlı odada oturuyordu. |
| Engine `error` / açıklamasız `disconnect` → çağrıyı kapat | ✅ | ✅ | Ortak karar: `decideCallMediaOutcome` + `watchCallMedia` (client-core). Mobil bu üç sonun HİÇBİRİNİ işlemiyordu, dolayısıyla ölü medya `active` bir hayalet çağrı bırakıyor ve `isCallLive` her yeni aramayı reddediyordu ("çıkıp o kişiyi tekrar aramak zorunda kalıyorum"). İstisnalar AYNEN korunuyor: `session_replaced` (çağrı DİĞER cihazda canlı — kapatmak onu öldürür) ve `alone` kapatılmaz, `pending` bir kontrol eylemi sırasında hiç tepki verilmez. |
| Join öncesi `leaving` beklemesi + dürüst `isConnectedTo` | ✅ | ✅ | Ortak adaptör: `createCallEngineAdapter`. `leaving` durumunda LEAVE de JOIN de yasak (§11); elle yazılmış eski mobil seam `InvalidVoiceCommandError` fırlatıp accept'i sessizce yarıda bırakıyordu — satır sunucuda canlı, telefonda medya yok. `isConnectedTo` artık ses FSM'inden okunuyor, yani "FSM active ama LiveKit oturumu yok" durumu resync tarafından görülüp onarılabiliyor. Ek: mobil çağrı join'i artık Bas-Konuş tercihini de uyguluyor (kanal join'i zaten uyguluyordu, çağrı sıcak mikrofonla açılıyordu). |
| Her FSM geçişinde tek gözlem satırı (`voice.status` + `call.phase`) | ✅ | ✅ | `[call] <action> from→to (dropped) voice=… call=…`; `dropped` = reducer eylemi YOK SAYDI, yani bu dalganın düzelttiği hata sınıfı artık iz bırakıyor. adb/Expo logundan okunur, çağrı başına bir avuç satır (§27). |

**Ortaklaştırma (kopya değil):** karar `packages/client-core/src/dm-calls/voice-bridge.ts`'te
yaşıyor — `createCallEngineAdapter` (join yasallığı + `leaving` beklemesi + `isConnectedTo`),
`decideCallMediaOutcome` (saf karar) ve `watchCallMedia` (aboneliği kuran ince sarmalayıcı).
Platformdan yalnız "ses FSM'ini nasıl okurum / nasıl abone olurum" isteniyor; `@demli/media`
import EDİLMİYOR, RN bağımlılık grafiği yalın kalıyor. **Masaüstü hâlâ kendi kopyasını
taşıyor** (`renderer/src/lib/call-controller.ts` + `stores/voice-store.ts`): bu dal
`apps/desktop`'a dokunmadı (paralel ajan oradaydı), devir tek satırlık açık iş ve davranış
farkı yok.

**Kanıt:** `packages/client-core/src/__tests__/call-voice-bridge.test.ts` (17 test; mutasyonla
kırıldığı doğrulandı — `endedReason` istisnası kaldırılınca ve `leaving` beklemesi silinince
kırmızıya döndü) + `apps/mobile/src/stores/__tests__/call-wiring.test.ts` (dört kablolamayı
kaynak düzeyinde sabitler; mobilde RN render harness'ı yok ve kaçırılan hata tam olarak
"paylaşılan düzeltme var ama uygulama onu ÇAĞIRMIYOR" sınıfındaydı).

⚠️ **CİHAZ DOĞRULAMASI BEKLİYOR.** Yukarıdaki ✅'ler KOD paritesidir; hiçbiri telefonda
çalıştırılarak görülmedi. Emülatör oturumu founder BlueStacks oynadığı için (aynı WHPX
katmanı) yarıda kesildi: debug APK derlendi ve kuruldu, uygulama açıldı ve Metro'dan JS
paketini çekmeye başladı, ama giriş ekranına ulaşılamadan emülatör kapatıldı. Cihazda
görülmesi gereken üç şey: (1) çağrı sırasında WS koptu-bağlandı → logda `[call] …`
geçiş satırları ve çağrının kendini toparlaması, (2) sesli odadayken gelen çağrıyı kabul
→ medyanın gerçekten açılması (eski `leaving` çakışması), (3) çağrı sırasında medyayı
öldürüp (uçak modu) hemen yeni çağrı başlatabilmek (hayalet `active` kalmaması).

---

## 2026-07-30 — W3: mobil sesli/arama KABUĞU birleşti (call-ux-plan)

Founder'ın "sunucudaki sesli ile özel arasında fark olmamalıydı" şikâyetinin asıl kaynağı
mimari değildi — teşhis doğrulandı: medya katmanı zaten TEK (aynı engine, aynı FSM, aynı
token yolu). Fark **mobil kabuğun kopyasından** geliyordu.

| Kalem | Önce | Sonra |
|---|---|---|
| Kişi-bazlı ses (uzun-bas) | Sunucu seslisinde çalışıyor, **DM aramasında ÖLÜ** (host mount edilmiyor) | Ortak kabukta tek host → iki yüzeyde de çalışıyor |
| Sahne-üstü kontrol barı | Yalnız DM aramasında | Ortak kabukta → iki yüzeyde de |
| Ses çıkış rotası (`AudioOutputControl`) | Yalnız sesli odada | İki yüzeyde de |
| Tile kurucu | `InCallView` + `VoiceRoomScreen`'de 18 satır kopya | Tek `use-stage-tiles.ts`, `@demli/media`'nın `buildTiles`'ını tüketiyor |
| Grid⇄focus + filmstrip | Mobilde el yapımı (`tiles.filter`) | Ortak `resolveStage` + K3 konuşan-filmstribi |
| Self-view | Yok | `SelfViewPip` (odak + kamera tam ekranı), kamera kapalıyken dikdörtgen |

**Yeni/taşınan dosyalar:** `components/voice/VoiceStage.tsx` (kabuk), `use-stage-tiles.ts`,
`SelfViewPip.tsx`, `stores/self-view-store.ts`, `stage-shell.test.ts`;
`components/call/CallStageControls.tsx` → `components/voice/StageControlBar.tsx` (taşındı,
eski yol SİLİNDİ). `packages/media` ve `packages/client-core/src/dm-calls/**` dosyalarına
DOKUNULMADI — ortak model tüketildi, değiştirilmedi.

**Kapılar:** `pnpm -r typecheck` · `pnpm lint` · `pnpm test` (mobil 531, media 369, i18n 37
— i18n TR+EN parite dahil) yeşil. `stage-shell.test.ts` **mutasyonla doğrulandı**: volume
sheet mount'u silindiğinde 15 testin 2'si kırmızıya döndü, geri alınınca yeşil
(`gates-that-lie` — yeşil kapı, kırıldığı görülmeden kanıt sayılmaz).

⚠️ **CİHAZDA GÖRÜLMEDİ — dürüst kayıt.** AVD `demli-debug` açıldı ve önyükleme
tamamlandı (BlueStacks çalışmıyordu; ayrıca founder'a ait `drey-audit` emülatörü zaten
açıktı, ona DOKUNULMADI ve açık bırakıldı). Ama AVD'de kurulu paket **prod 1.8.0 release
APK**'sı ve `expo-dev-client` bağımlılığı yok — yani cihaz yalnız `preview` kanalına
YAYINLANMIŞ paketi çalıştırabiliyor. Bu daldaki kodu oraya sokmanın tek yolu gerçek
kullanıcılara OTA yayınlamaktı; inceleme öncesi yayın YAPILMADI. Bunun yerine yapılabilen
en güçlü doğrulama yapıldı: **`npx expo export --platform android` tam Metro grafiğini
derledi ve Hermes'e çevirdi (9 MB `.hbc`)** — yani `stage.ts` / `active-speaker.ts`
tüketimi gerçekten RN-safe, hiçbir DOM-only bağımlılık sızmıyor, tüm import'lar çözülüyor.
Emülatör iş sonunda kapatıldı (`adb -s emulator-5556 emu kill`).

Founder'ın CİHAZDA görmesi gereken üç şey (iki kişi / iki cihaz gerektiriyor, tek başına
üretilemez):
1. **DM aramasında** uzak katılımcıya uzun-bas → ses seviyesi sheet'i AÇILIYOR mu (asıl
   düzeltilen ölü kontrol) ve kaydırınca karşı tarafın sesi gerçekten değişiyor mu.
2. **Self-view:** odakta/tam ekranda sağ-altta kendi kutun; kamerayı KAPATINCA kaybolmayıp
   "Kameran kapalı" dikdörtgenine dönüyor mu; sürükleyip köşeye yapışıyor ve uygulamayı
   kapatıp açınca AYNI köşede mi.
3. **Konuşan-filmstribi hissi:** ≥4 kişilik odada birine pinleyip diğerlerinin yalnız
   konuşunca girip ~5 sn sonra çıkması rahatsız edici mi (300 ms / 5 sn sabitleri
   `packages/media/src/active-speaker.ts`'te tek yerde, founder kulağına göre ayarlanabilir).

## 2026-10-19 — M16 Dalga 1C, SUNUCU yarısı (moderasyon medyası · avatar sahipliği · yükseltme yarışı · doluluk · arama push'ları)

Hasmane sunucu taramasının (`code-health-server`) bulguları. Hepsi sunucu tarafı; iki
platformu aynı anda etkiler. Tek istemci değişikliği `voice.join` yeniden denemesi
(`packages/client-core/src/voice-announcer.ts`, masaüstü + mobil `realtime/connection.ts`).

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| At / yasakla / zaman aşımı kişiyi SES odasından da çıkarır | ✅ (sunucu) | ✅ (sunucu) | Eskiden yalnız `member.left` yayınlanıyordu; gateway'in "ses teardown"u bir harita düzenlemesiydi, SFU oturumu sürüyordu — atılan kişi duymaya ve konuşmaya devam edebiliyordu. Artık sunucunun her sesli kanalının GERÇEK odası (`livekitRoom ?? id`, yükseltilmiş çağrıda `dmcall:<id>`) için `removeParticipant`; içinde olduğu odaya `voice.disconnected{reason:"moderator"}`. Sahip başkasını sunucudan / grup sohbetinden çıkarınca da aynısı. `apps/api/src/lib/voice-eviction.ts`. Çıkarılan kişi "Sesli odadan çıkarıldın." görür (`endedModerator`); eskiden SFU'nun çıkarması "Başka bir cihazdan sesli odaya katıldın." diye okunuyordu ve istemci `moderator` sebebini yok sayıyordu — ses-kesme (voice disconnect) eyleminde de dev'de böyleydi. |
| Atılan kişi elindeki token'la geri giremez | ◑ (sunucu) | ◑ (sunucu) | (1) Medya token'ı artık 10 dk katılım hakkı veriyor (6 saat değil) — LiveKit bağlı katılımcının token'ını kendisi yeniliyor (oturum başında + 5 dk'da bir, 10 dk'lık), yani arama süresi etkilenmez. (2) `POST /hooks/livekit`: SFU'nun imzalı `participant_joined` webhook'unda token uçlarının bugünkü yetki kontrolü yeniden koşar, geçemeyen çıkarılır. (3) **Yapılandırma açıldı (`feat/m16-ship-prep`, canlıya bir sonraki `deploy-remote.sh` ile):** `deploy/livekit.yaml` `webhook:` → `http://api:4000/hooks/livekit` (iç ağ), `api_key` = `LIVEKIT_API_KEY` (envsubst ile; secret dosyaya hiç yazılmaz). `deploy.sh` render'ı kanıtlar, LiveKit'i YALNIZ config değiştiyse yeniden yaratır — o an süren her arama kesilir (ham livekit-client 1,8 sn'lik ani SFU yeniden başlatmasından ~5 sn'de kendiliğinden döndü; docker SIGTERM süresi ve uygulamaların ses FSM'i ÖLÇÜLMEDİ → bu deploy'u kimse aramadayken yap; `DEPLOY_SKIP_LIVEKIT_RECREATE=1` erteler), açılmazsa eski config'e geri döner, SFU→API yolunu imzasız probe=401 ile kanıtlar. Yerel E2E (gerçek WebRTC, LiveKit 1.9.12): yetkili kullanıcılar DM araması (çalarken katılan arayan dahil), sesli kanal ve yükseltilmiş arama odasında 32 sn kaldı, sıfır yanlış çıkarma; atılan kişi atılmadan önceki token'la 3 kez girdi → her seferinde SFU'da ACTIVE olduktan ≤0,25 sn sonra çıkarıldı; zaman aşımındaki üye de aynı; webhook kapalı kontrol koşusunda atılan kişi odada KALDI. Canlıda doğrulanana kadar ◑. |
| Başkasının avatar/afiş dosyası silinemez | ✅ (sunucu) | ✅ (sunucu) | `PATCH /users/me` kendi bucket nesnen OLMAYAN bucket URL'ini reddeder; yükleme sonrası "eskiyi sil" adımı yalnız `avatars/<sen>/`, `banners/<sen>/`, `group-banners/<sunucu>/` altını siler, `..`/kodlanmış `/` içeren anahtarı reddeder. Eskiden profiline başkasının avatar URL'ini yazıp yeni avatar yükleyen herkes O dosyayı siliyordu (bucket canlıda açık — satır 92). |
| Özel aramadan gruba yükseltmede ilk iki kişi kanalda görünür | ✅ | ✅ | Gateway `call.upgraded`'ı iletmeden önce kullanıcıyı yeni gruba alıyor; `member.joined` DB'yi beklerken gelen `voice.join` artık reddedilmiyor. Ret olursa `error.raised.channelId` (protokole eklendi, opsiyonel) ile istemci kendi katılımını tanıyıp 0,5→8 sn, 5 denemeyle yeniden dener (eskiden bir sonraki reconnect'e kadar hiç). Yarış stub-repo testiyle ÜRETİLDİ (`gateway.voice-occupancy.test.ts`, eski gateway'de kırmızı). |
| Ses doluluğu bağlantı başına sayılır | ✅ | ✅ | Geç biçilen ölü soket ya da aynı odadaki ikinci cihazın çıkışı, odada olan kullanıcıyı listeden silmiyor; `voice.participant_left` (ve watch party sahip devri) yalnız SON bağlantı çıkınca. |
| Yükseltilmiş çağrının sesli kanalı resync'te boş görünmez | ✅ | ✅ | `voice.resync` ve `GET /voice/occupancy` LiveKit'e kanalın gerçek odasını soruyor (`channels.livekitRoomOverrides`); eskiden her reconnect/odaklanmada 3 kişi konuşurken kanal boş görünüyordu. |
| Arama push'ları doğru Android kanalında, süreli | — | ✅ (sunucu) | Her push `channelId: messages-v2` (uygulamanın açtığı kanal; test iki tarafı birbirine kilitliyor). Zil `ttl` = zil süresi (30 sn): geri gelen telefon çoktan biten aramayı çaldırmaz. ⚠️ Kanalın cihazda sesli geldiği founder cihaz testiyle doğrulanmadı. |
| Cevapsız her bitişte zil "Cevapsız arama"ya döner | — | ✅ (sunucu) | Yalnız iptalde değil: süpürücü, arayan-düştü biçicisi ve `POST /dm-calls` / `GET /dm-calls/active` içindeki satır-içi biçme. Satır-içi biçme artık `call.ended` + DM geçmişine cevapsız satırı da yazıyor (süpürücüyle aynı). |
| Başka cihazda cevaplanan/reddedilen zil | — | 🚧 istemci | Sunucu, arananın diğer cihazlarına SESSİZ `call_ended{answered|declined}` push'u (aynı etiket) gönderiyor; zili kapatmak mobil istemcinin işi (arka plan bildirim görevi) — henüz yok. |
| Aynı anda ikinci yükseltme | ✅ (sunucu) | ✅ (sunucu) | 500 yerine 409. |

**Açık:** arama push metinleri hâlâ İngilizce — sunucuda alıcı dili yok (cihaz kaydında
`locale` + istemcinin göndermesi + sunucunun katalog okuması gerekir). Bu dalga yeni metin
eklemedi.


## 2026-10-19 — M16 Dalga 1A/1B: paylaşım sesi yankısız (masaüstü + web)

Founder saha bulguları H1 (masaüstü sistem sesiyle paylaşınca karşı taraf KENDİ sesini
duydu) ve H3 (web'den paylaşımda ses gitmiyor). Davranış DM aramasında, sunucu sesli
kanalında ve grup aramasında aynı: üçü de tek `voice-store.startScreenShare` → tek
`screen-share.ts` yolundan geçiyor.

| Özellik | Masaüstü | Web | Mobil |
|---|---|---|---|
| Üç açık ses seçeneği (Ses yok · Yalnız bu uygulama · Sistem sesi — Demli hariç); pencere → uygulama, ekran → sistem varsayılanı, tür başına hatırlanır | ✅ | ✅ (Ses yok / Sesi de paylaş; ne gideceğini tarayıcı yüzeyi belirler) | ⛔ mobil yayın sessiz (#45) |
| Kendi süreç-yakalama yardımcımız (`native/process-audio`, MS ApplicationLoopback MIT uyarlaması, statik MinGW, `--check` ile bayt-bayt tekrar üretilebilir) | ✅ | — | — |
| Tüm-cihaz loopback + karışım-girişi (Stereo Mix/Voicemeeter/CABLE) katmanları SİLİNDİ; `getDisplayMedia` handler artık yalnız görüntü verir | ✅ | — | — |
| "Yalnız bu uygulama" ayrılamazsa (ağacı Demli'yi içeriyor — Demli ya da Explorer gibi atası —, süreç çözülemedi, Windows reddetti) ses GİTMEZ; panel uyarır ve tek tıkla "Sistem sesini gönder (Demli hariç)" sunar. Kendiliğinden sistem sesine düşmez (seçilen "yalnız bu uygulama" sözü) | ✅ | — | — |
| UWP/Store penceresi (ApplicationFrameWindow) → `--window-pid` asıl uygulamanın sürecini (CoreWindow sahibi) döner; küçültülmüş/askıdaki uygulama → çıkış 8 → ses yok + öneri | ✅ | — | — |
| Windows build < 19041 → ses yok + dürüst not (loopback'e düşülmez: o yol HER konuşmada yankı yapar, kulaklık da önlemez). 19041–20347 (Windows 10 2004–22H2) deneniyor; Windows reddederse `activation_failed` → ses yok + not. Gerçek Windows 10 cihazında doğrulanmadı | ◑ | — | — |
| Bilinen sınır: Demli'nin çıkışını kendi sürecinden yeniden çalan mikser (Voicemeeter MME/WDM, SteelSeries Sonar, "Bu cihazı dinle") "Sistem sesi"ne o kopyayı geri sokabilir; seçici metni bunu söylüyor, çare "Yalnız bu uygulama" | ◑ | — | — |
| Lisans: statik bağlanan MinGW-w64 çalışma zamanı + winpthreads bildirimleri `resources/process-audio/LICENSE` ve THIRD-PARTY.md'de; derleme betiği eksik bildirimde başarısız | ✅ | — | — |
| Denetleyici yalnız izler: bekleniyor / canlı / kesildi; kaynağı ASLA değiştirmez | ✅ | ✅ | — |
| Zehirli localStorage (`film-audio-source` = loopback/mixinput, eski `system-audio`) göç ettirilip silinir | ✅ | ✅ | — |
| Web isteği: `displaySurface:'browser'`, `selfBrowserSurface:'exclude'`, `surfaceSwitching:'include'`, `restrictOwnAudio:true`, `suppressLocalAudioPlayback:false`, `windowAudio`/`systemAudio` ipucu | — | ✅ | — |
| Seçilen yüzeye göre dürüst rehber (sekme kutusu / tüm ekran kutusu / pencere ses vermez / tarayıcı desteklemiyor / `restrictOwnAudio` yoksa yankı uyarısı) | — | ✅ | — |
| Paylaşım sesi durumu + ses hataları ORTAK bileşen (`ShareAudioStatus` / `VoiceErrorNotice`): VoicePanel (kanal + grup) ve CallDock (DM — eskiden hiç göstermiyordu) | ✅ | ✅ | ⛔ mobil arama ekranı ayrı görev |
| voice-store yarışı: edinim sonucu yayın bitince yazılıyor (eski kod "izleyiciler duymuyor" uyarısını ve önizlemeyi yayın sürerken siliyordu) | ✅ | ✅ | — |
| `replaceScreenShareAudio`: takas sırasında gelen durdurma kazanır, yeni iz yayında kalmaz | ✅ | ✅ | ✅ (ortak motor) |

**Sayısal kanıt — 2. tur (denetim sonrası, `node apps/desktop/scripts/verify-process-audio.mjs --packaged`,
ton −30 dBFS, "yok" = aynı tonun referans kayıttaki seviyesinin en az 40 dB altı; zemin
yüksekse "kanıtsız" sayılır):** include(A) 613 Hz −30,0 dBFS / 1471 Hz −147,2 dBFS (117 dB
reddedildi); exclude(A) 1471 Hz −30,0 dBFS / 613 Hz −80,6 dBFS (50,6 dB). UWP: Filmler ve TV
887 Hz çalarken `--window-pid` çerçeveyi asıl uygulamaya çözdü (eski yardımcı
ApplicationFrameHost'u dönüyordu); include(uygulama) −30,0 dBFS, include(ApplicationFrameHost)
−152,7 dBFS. 7/7 geçti. Electron bölümü (2. kısım) bu turda koşulamadı: `<audio>` bu
makinede ilerlemedi (`currentTime 0`) ve `electron.exe` karıştırıcıda sessizde.

**Sayısal kanıt — 1. tur** (`pnpm --filter @demli/desktop verify:process-audio`, bu makinede, arka
planda başka ses çalarken): iki süreç aynı anda 613 Hz / 1471 Hz çalarken include(A) 613 Hz
−12,0 dBFS / 1471 Hz −143 dBFS; exclude(A) 1471 Hz −12,0 dBFS / 613 Hz komşu bantların
üstünde tepe yok (−1 dB) — 3 koşuda 12/12. Gerçek Electron `<audio>` (ilk koşu, 1000/440 Hz):
exclude(Electron ana PID) Electron tonu −118,8 dBFS / başka sürecin tonu −12,0 dBFS;
include(Electron ana PID) Electron tonu −12,0 dBFS → Electron'un ses servisi ana sürecin
ağacında. Sonraki koşularda `electron.exe` Windows ses karıştırıcısında SESSİZE alınmıştı
(oturum `mute=1`; süreç-yakalama karıştırıcı sonrası alır) — betik bunu artık "geçti" değil
"kanıtsız" sayıyor; karıştırıcı açıkken yeniden koşulmalı.

**Açık (cihaz):** founder makinesi (Voicemeeter + SSL) ve düz Windows'ta DM/kanal/grup
aramasında karşı taraf konuşurken tüm ekran + sistem sesi paylaşımı → karşı taraf kendini
DUYMAMALI; bir mikser (Voicemeeter MME/WDM ya da Sonar) kurulu makinede aynı kontrol; bir
Windows 10 22H2 makinesinde iki mod; web'de gerçek Chrome ile sekme/ekran/pencere senaryoları. Otomatik testler
kaynak seçimini ve iletiyi kilitliyor; uçtan uca çağrıdaki tonu ölçmedi.

## 2026-10-19 — M16 1D Android yankı (H2) + 1C mobil yarısı + Dalga 4 native bağımlılıkları (dal `feat/m16-android-audio`, YAYINLANMADI)

Native değişiklik → **runtimeVersion 2.1.0, versionCode 11** (yeni APK, §32 adım 4: önce
`publish-mobile-apk.sh`, SONRA `MOBILE_LATEST_RUNTIME: "2.1.0"` + deploy). Tek APK döngüsü
Dalga 4'ün bağımlılıklarını da taşıyor: `react-native-reanimated 4.5.0`, `react-native-worklets
0.10.0`, `react-native-gesture-handler ~2.32.0`, `expo-blur ~57.0.0` artık açıkça bildirildi
(Expo 57 `bundledNativeModules` sürümleri; önceden yalnız dolaylı geliyordu, gesture-handler
test edilmemiş 3.0.2'deydi).

| Madde | Durum | Not |
|---|---|---|
| Yankı engelleyici seçimi | 🚧 APK bekliyor | `patches/@livekit__react-native@2.11.1.patch`: `setupAdm` tercihi SharedPreferences'tan okur (anahtar yoksa donanım = bugünkü davranış). Ayarlar → Yankı engelleyici: Telefonun kendi (varsayılan) / WebRTC yazılımı; yeniden açılışa kadar "önceki seçim çalışıyor" der. |
| Gerçek ses rotası + değişim olayı | 🚧 APK bekliyor | `getSelectedAudioOutput` ana looper'da okunur (seçimden SONRA sıralanır), `LK_AUDIO_OUTPUT_CHANGED` audioswitch'in kendi geri çağrısı. |
| `setAudioModeAsync` kilidi | 🚧 APK ile gider (JS) | `sounds/audio-mode-guard.ts`: joining/connected/reconnecting'de reddeder; connect devam eden değişikliği bekler (en çok 1,5 sn), geç inen değişiklikten sonra LiveKit oturumunu yeniden kurar. Sahiplik bir KİRA: yeni aramanın acquire'ı eskisinin yerine geçer, release yalnız kendi kirasını bitirir. Test: `audio-mode-guard.test.ts` (12) + gerçek adaptörle `audio-session-ordering.test.ts` (3) — connect'teki `acquireCallAudio` silinince 2'si kırmızıya döndü (mutasyonla doğrulandı). |
| Tek sahipli native ses oturumu | 🚧 APK ile gider (JS) | Denetim bulgusu (yüksek): motor eski odanın `disconnect()`'ini beklemeden ateşliyor; sesli kanaldan DM aramasına geçince eski adaptörün `stopAudioSession`'ı yeni aramanın start'ından SONRA inebiliyordu. audioswitch `start()` eski oturum nesnesi dururken hiçbir şey yapmıyor, `stop()` ise sökümü yalnız ana looper'a koyuyor → yeni arama MODE_NORMAL'da, ses odağı olmadan, ölü rota menüsüyle kalıyordu; eski adaptör guard'ı da yeni arama için açıyordu. Şimdi start/stop/select sırayla koşuyor, her start/stop yamalı `getSelectedAudioOutput` bariyerini bekliyor (aynı looper'da sökümün/aktivasyonun ARKASINDA), oturumu yalnız sahibi durdurabiliyor; önceki aramanın oturumu hâlâ canlıysa yeni connect devralıp yeniden başlatıyor. Reassert de aynı bariyerle yeniden başlatıyor (eskiden arka arkaya stop/start oturumu tamamen öldürebiliyordu). Test: `audio-session-native.test.ts` (5) native zamanlamayı modelliyor (void köprü çağrısı, ertelenmiş söküm, canlı oturumda no-op start); önceki adaptörde 4'ü kırmızı. ⚠️ Cihazda yeniden üretilmedi — statik analiz + model. |
| Görüntülü arama = hoparlör | 🚧 APK ile gider (JS) | Varsayılan zaten hoparlör (audioswitch BT > kablolu > hoparlör > ahize). Ek kural: kamera açılınca rota AHİZE ise hoparlöre alınır (motor son çıkış seçimini her katılışta yeniden uyguladığı için önceki sesli aramadan kalan ahize görüntülü aramaya taşınıyordu). Sesli aramada davranış DEĞİŞMEDİ (hoparlör); ahize-varsayılanı founder kararı. |
| Arama ekranında ses hatası | 🚧 APK ile gider (JS) | `VoiceNotices` — üst tablodaki satır. |

**H2 durumu: AÇIK.** Bu APK varsayılan olarak dev ile aynı ADM'yi (donanım AEC) ve aynı
hoparlör-önce rotayı kuruyor; kilit yalnız `setAudioModeAsync` bir katılımla çakışınca devreye
giriyor. Yani founder'ın yankısı ayara dokunulmadıkça büyük olasılıkla AYNEN tekrar eder — bu
APK düzeltme değil, A/B aracı. H2 founder sonucu gelene kadar kapanmaz.
**Açık kalan (media-core sahası, bu dalın dışı):** Ayarlar → Mikrofon → "Yankı Engelleme"
anahtarı hâlâ uyarısız kapanıyor; müzik modu dışında kapalıyken iki engelleyici de çalışmaz.
Masaüstü 1C gibi "kulaklık kullanıyorum" onayına bağlanmalı (`MicSettings.tsx`).

**Founder A/B maddesi (gerçek telefon, AVD akustik yol taşımıyor):** masaüstü KULAKLIKLA,
Android telefon HOPARLÖRDE, yayın KAPALI, görüntülü DM araması. (1) Ayarlar → Yankı
engelleyici = Telefonun kendi: Ali konuşur, kendi sesini geri duyuyor mu? (2) WebRTC yazılımı
seç, uygulamayı tamamen kapat-aç (ekran "Bu seçim şu an çalışıyor" demeli), aynı test.
(3) Aynı testi ahize rotasında. Varsayılan "Telefonun kendi" kaldı çünkü bugünkü davranış bu
ve Android'de libwebrtc'nin yazılım yolu mobil engelleyiciye (AECM) düşüyor olabilir — derlenen
`libjingle_peerconnection_so.so` içinde "Disabling EC since built-in EC will be used instead"
ve `mobile_mode` yapılandırma alanı var, hangi dalın seçildiği ikili dosyadan kanıtlanamadı.
Yazılım yolu kazanırsa varsayılanı çevirmek yamadaki tek bir `true` → yeni APK. Test
telefonunda bölüm "donanım yankı engelleyicisi yok" diyorsa o telefon yalnız AOSP AEC'sine
sahip ve libwebrtc zaten yazılımı çalıştırıyor — A/B o telefonda anlamsız, başka cihaz gerekir.

**Emülatör (AVD `demli-debug`, Android 14 / API 34 x86_64 — AVD silinmişti, aynı adla yeniden
kuruldu):** imzalı release APK (`app-release.apk`, 173.375.462 bayt, imza keystore ile eşleşti)
kuruldu, `versionName=2.1.0 versionCode=11`, açıldı, giriş ekranına geldi; `FATAL EXCEPTION` 0,
süreç ayakta. logcat: `LiveKitReactNative: setupAdm: hardwareAudioProcessing=true sdk=34`
(yamalı native kod Application.onCreate'te koşuyor). **Doğrulanamayanlar:** repoda belgelenmiş
test hesabı yok → giriş yapılmadı; ayarlardaki yeni bölüm, sesli odaya katılma ve rota
değişimi (`dumpsys audio`) emülatörde GÖRÜLMEDİ. Ayrıca emülatörde `AcousticEchoCanceler`
olmayabileceği için orada bölüm yalnız bilgi satırı gösterecektir.

**Denetim sonrası yeniden derleme (2026-10-19, `8093d40`):** imzalı release APK 173.382.550
bayt (imza keystore ile eşleşti), AVD `demli-debug` (API 34) üzerine kuruldu, `versionName=2.1.0
versionCode=11`, giriş ekranı açıldı, uygulama için `FATAL EXCEPTION` 0, süreç ayakta (ekrandaki
"System UI isn't responding" ve `com.google.android.gms.persistent` ANR'ı emülatörün soğuk
açılışına ait, uygulamaya değil). logcat: `setupAdm: requested=true hardwareAec=false
hardwareNs=false sdk=34`. AVD'nin `/vendor/etc/audio_effects.xml`'i yalnız AOSP `aec`
(`bb392ec0-…`) ve `ns` (`c06c8400-…`) tanımlıyor — yani bir önceki derlemenin aynı AVD'de
yazdığı `hardwareAudioProcessing=true` tam olarak denetimin bulduğu yalandı; yeni kod libwebrtc'nin
gerçekten çalıştırdığını raporluyor ve bu telefon sınıfında bölüm seçim yerine "donanım yankı
engelleyicisi yok" bilgisini gösterecek. Giriş hesabı olmadığı için ayar ekranı ve oda içi ses
oturumu emülatörde yine GÖRÜLMEDİ.

## 2026-10-19 — M16 Dalga 2: "Koyu Masa" tasarım sistemi temeli (tüm platformlar)

Dal `feat/m16-design-foundation`. Ürün ekranları henüz taranmadı (Dalga 3/4); bu dalga
token, font, hareket ve atom katmanıdır — ekranlar yalnız token değerleri ve yerinde
yeniden stillenen ortak atomlar kadar değişir.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Koyu Masa paleti (nötr siyah + mercan #ff8464, cam/veil/scrim, beyaz birincil) | ✅ `globals.css @theme` | ✅ `theme.ts` | `tokens.css` ile üçlü testle kilitli |
| Metin rampası AA (fg-faint #8f8f8f, fg-subtle #666 yalnız metin-dışı) | ✅ | ✅ | doküman #737373/#404040 AA'yı geçmiyordu; ölçülü test |
| Tehlike = pembe #ff6fb5 (dnd dahil), dolguda koyu mürekkep | ✅ | ✅ | renk-körlüğü ölçümü tasarım dokümanı §1.4 |
| Radius 8/10/12/16 + 18/24/32/pill | ✅ | ✅ | `--radius` 10→12 |
| Inter (gövde) + Onest (başlık), OFL, paketli | ✅ değişken woff2 | ✅ statik TTF (OTA) | Instrument Sans + Space Grotesk kaldırıldı |
| Hover = 200ms ton geçişi; konum yayı {500,60,1} | ✅ CSS `linear()` + framer `springs` | ✅ `motion.spring` + `MOTION_PRESETS` (RN Animated + Reanimated `motionTo`/`pressTo`/`toneTo`) | Reanimated adaptörü Dalga 4 mobil kitiyle geldi; basış yayı + overlay koreografisi masaüstü `presets.ts`'ten testle okunuyor |
| Atomlar: Button (5×3 + yükleniyor), IconButton+ipucu, Avatar/AvatarGroup, Field/Input/Textarea doğrulama, Switch, Checkbox, Radio, Slider, Select, Menü/Bağlam menüsü, Dialog/Sheet, Toast, Skeleton, Badge/CountBadge, Kbd, Chip'ler | ✅ `packages/ui` | ◑ Dalga 4 kit (`components/ui/**`) | Mobil kit indi (aşağıdaki Dalga 4 bölümü); Select/Menü/Kbd mobilde ayrı atom değil (menü = ActionSheet, seçim = RadioGroup/Chip/Segmented, klavye kısayolu yok). Ekranlar henüz kite taşınmadı |
| Avatar konuşma halkası yeşil → mercan; durum noktası avatarın %30'u | ✅ | ◑ atom hazır, ekranlar YEŞİL | Mobil `Avatar` `speaking` prop'u (2px yüzey halkası, solan mercan halka, nokta max(10, %30)) var, ama hiçbir ekran onu geçmiyor: sesli odada kullanıcı hâlâ yeşil halka görüyor — `voice/ParticipantTile.tsx`, `voice/CameraTile.tsx`, `voice/DraggableCameraPip.tsx`, `voice/VoiceParticipant.tsx` (`speaking ? colors.online`). Dalga 5 ekran işi: bu 4 dosya `Avatar speaking`'e ya da `colors.accent`'e taşınacak |
| Menü vurgusu mercan dolgu → raised ton; tehlike satırı pembe yıkama | ✅ | — | StatusPicker vurgulu satır mürekkebi uyarlandı |
| Dev-only UI kiti `/ui-kit.html` (G2 kapısı) | ✅ web dev sunucusu | ✅ `demli://ui-kit` (yalnız `__DEV__`) | web: build'e girmez · mobil: release'de rota ana sayfaya yönlenir |
| Dolgusuz kontrol hover/basılı + iskelet = göreli beyaz yıkama (`wash` .06 / `wash-strong` .10) | ✅ | ✅ token (`colors.wash`) | mesaj araç çubuğu, güncelleme/sabit mesaj popover'ı ve profil kartı iskeleti `#171717` üstünde görünmüyordu; `ui-tones.test.tsx` her kap tonunda ölçer |
| Açık dolguda (çağrı reddet/kapat/kabul, odadan çık, okunmamış rozeti, rail "sunucu ekle" hover'ı) koyu `on-accent` mürekkep | ✅ | ✅ (zaten `onAccent`) | beyaz pembe üstünde 2.56:1, yeşil üstünde 2.28:1 idi; kaynak taraması testi zorlar |
| Avatar baş harfleri saf beyaz | ✅ | — (mobil zemin %24 açıklık: `fg` ile en kötü 5.31:1, değişiklik gerekmedi) | `fg` ile 360 renk tonunun 151'i AA altındaydı; şimdi 0 (en kötü 4.67:1) |

**Kapılar:** desktop `design-tokens.test.ts` (76) + mobil `design-tokens.test.ts` (72)
mutasyonla doğrulandı (fg-faint #737373, yay süresi, tehlike #ef4444 → kırmızı);
`ui-primitives.test.tsx` (20, gerçek mount) mutasyonla doğrulandı; motion
`m.*` testi `motion.div` negatif kontrolüyle. Tarayıcıda `/ui-kit.html` üç görünüm:
0 konsol hatası, 76 kontrolün hepsinin erişilebilir adı var, 375px'te yatay taşma yok.

**Bilinen açık:** iki `index.html` önyükleme iskeleti, pencere flaş rengi, BootSplash ve
VideoStage gradyanları, mobil `app.json` splash/ikon renkleri hâlâ sıcak eski palet —
token değişimi bunlara ulaşmıyor (liste tasarım dokümanı §7.3). Mobil splash APK ister.

## 2026-10-20 — M16: "Görünmez" seçen kendini "çevrimdışı" görüyordu (sunucu + iki istemci)

Dal `feat/m16-presence-self`. Entegrasyon testleri ilk kez gerçek Postgres/Redis'e karşı
koşunca çıktı.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Kendi durum noktan GERÇEK durumu gösterir (görünmez → görünmez, çevrimdışı değil); başka cihazda seçilen durum bu cihazın noktasına gelir | ✅ | ✅ | Kök neden: `groups.listCoMemberUserIds` kullanıcının kendisini içeriyor, gateway bunu `presenceAudience` olarak aynen kullanıyordu → kişi kendi EŞLERE-maskeli durumunu (invisible→offline) canlı ve her handshake snapshot'ında alıyordu. Sözleşme (`PresencePayload` dokümanı): eşler maskeli; kişinin kendi soketleri ADR 0020 türetilmiş GERÇEK durumu alır (telefonda dnd → masaüstü noktası kırmızı); bağlantıyı açan soket kendi connect yayınından hariç; snapshot yalnız eşler; kendine `offline` hiç gönderilmez. Yayın sırası düzeltildi (Redis en son okunur → yavaş bir kitle sorgusu eski durumu en son teslim edemez). Sunucu düzeltmesi yayındaki eski istemcileri de düzeltir; istemciler ayrıca kendine gelen `offline`'ı düşürür (`client-core/self-presence.ts`). Testler: `gateway.presence-self.test.ts` (6; eski gateway'de 6/6 kırmızı), derivation int +2 ve app-state int (grup-başına izolasyon) eski gateway'de kırmızı. |

**Bilinen açık:** (1) Durum seçicideki tik hâlâ BU cihazın seçimi; nokta artık hesabın
türetilmiş durumunu izliyor, yani "Çevrimiçi ✓ + kırmızı nokta" (telefonda dnd) görülebilir —
doğru ama açıklamasız (UI işi, ADR 0020 "Known gap"). (2) Tek cihazla görünmez bağlanan
kullanıcı, istemcinin ilk `presence.update`'ine kadar (~1 RTT) eşlere `online` yayınlanıyor:
yeni soket sunucuda varsayılan "online" ile kaydediliyor. Kapatmak handshake'te ilk durumu
taşımayı ister (ayrı iş).

## 2026-10-20 — M16 Dalga 3 (masaüstü + web): uygulama çerçevesi ve ilk izlenim

Dal `feat/m16-ui-shell`. Açılış → giriş → dört kolonlu kabuk → dar web kabuğu, komut
menüsü, bütün kök bildirimler, boş/yükleniyor/hata durumları Koyu Masa diline taşındı.
Yapı korundu (rail | kanallar/ana sayfa | orta | üyeler); stil landing'in "ada" dilinden.
Mobil karşılıklar Dalga 4'te (aşağıdaki ⏳ satırlar takip kaydıdır).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Ada çerçevesi: siyah sayfa, rail sayfada, kolonlar radius-24 adalar, aralar 8px siyah | ✅ | ✅ | kenar çizgisi/dış gölge yok |
| Tek satır dili (`shellRow`): seçili = mercan yıkama + açık mercan yazı, hover = yüzey tonu 200ms, basılı = bir ton koyu, okunmamış = beyaz kenar pipi + kalın ad, sessize alınmış = %55 | ✅ kanal / DM / grup / üye / komut menüsü | ✅ | hover'da hiçbir şey kaymaz/büyümez |
| Rail kenar hapı: seçili 36px mercan, okunmamış 8px beyaz, hover 20px — konum yayıyla büyür | ✅ | ✅ | eski radius-morph hover kaldırıldı |
| Sayaç rozeti 18px (mention = mercan, düz = açık çip), değişince pop | ✅ | ◑ | Mobil eksik: rozet 20px (18 değil), sayı değişince pop yok. |
| Kanal kenar çubuğu: dönen daralt oku, açılınca satırlar belirir, iskelet (ilk yükleme), yükleme HATASI = "Kanallar yüklenemedi" bandı + Tekrar dene, boş sunucu durumu (+ kanal oluştur, yetkiye göre) yalnız başarılı boş yanıttan sonra | ✅ | ✅ | `ShellData.serverDetailsLoading/serverDetailsError/retryServerDetails` (isteğe bağlı); denetim: hata eskiden "Henüz kanal yok" diyordu |
| Üye listesi: 48px satır, iskelet, hata bandı + Tekrar dene; yüklenmemiş/başarısız listede sahte "— 0" sayısı yok | ✅ | ✅ |  |
| Ana sayfa DM listesi: iskelet / hata bandı + Tekrar dene / satırlar / boş kart — "Henüz sohbet yok" yalnız başarılı boş yanıttan sonra; grup sohbetleri aynı bant | ✅ | ✅ | `ShellData.dmsStatus/dmsErrorMessage/retryDms`; tek kural `lib/shell-list-status.ts` |
| Rail sayaç rozetleri karonun köşesinde (rail kenarında kırpılmıyor), sunucu sütunu yana kaymıyor | ✅ | ✅ | denetim: 4px kırpılıyordu |
| Kullanıcı çubuğu: yüzey hapı; mikrofon kapalı / sağır = pembe tehlike düğmesi + kesik ikon; ikinci satır özel durum, kimlik bloğu ~96px (28px kontroller), üstüne gelince durumun tamamı | ✅ | — | denetim: ad/durum 38px'e sıkışıyordu Mobilde kullanıcı çubuğu yüzeyi yok (mikrofon/sağır dokta, kimlik Sen sekmesinde). |
| Komut menüsü: cam radius-24 kart, seçili satır = kabuk seçili dili, boş durum, klavye ipucu satırı (⌘/Ctrl) | ✅ | — (mobil komut paleti M20) | |
| Tek bildirim kartı (`NoticeToast`): üzerine gelince/odakta süre durur, Esc/✕, tehlike = alert; kök yığın üst üste binmez, yazma alanının üstünde; "hesap değiştirilemedi (çevrimdışı)" da artık yığının üyesi | ✅ 6 bildirim | ◑ | Mobil eksik: tehlike tostu ekran okuyucuya öncelikli (assertive) duyurulmuyor; alt boşluk sabit, yazma alanını hesaba katmıyor. |
| Yaş doğrulama + "uygulamayı indir" hapları: geniş kabukta kolon içinde (artık rail/mikrofonu örtmüyor), dar web'de üst çubuğun altında akışta tek satır (mesajları ve bildirim yığınını örtmez) | ✅ | — | denetim: telefonda bildirimlerle çakışıyordu |
| Dar web kabuğu: ada orta kolon, 44px dokunma hedefleri, çekmece konum yayıyla açılır, kapalıyken `inert` (Tab'a girmez), odak içeri/geri, kaydırarak kapatma (dokunma olaylarıyla — tarayıcı pan'i pointer'ı iptal etse de) | ✅ web | — | denetim: pointer tabanlı kaydırma gerçek telefonda hiç kapanmıyordu; CDP dokunma testi |
| Açılış: siyah sayfa + tek mercan ışık (BootSplash, iki `index.html`, Electron pencere rengi) | ✅ | ✅ kaynakta (2.1.0 APK ile çıkar) | `boot-surface.test.ts` dört kaynağı token'a kilitler |
| Çökme ekranı: sakin kart, tek eylem | ✅ | ⏳ | Mobilde yok: ErrorBoundary / çökme ekranı yok. |
| Giriş: ışıklı sayfa, kenarsız kart, alan-düzeyi doğrulama (hata alanın altında, `role=alert` + odak hatalı alana gider), mod geçişinde başlık geçişi + kayıt alanları açılır, kısa pencerede güvenli ortalama | ✅ | ◑ | giriş + `common.errors/validation` + güncelleme/görsel bildirim metinleri "siz/Lütfen"den "sen"e (marka kuralı; ortak katalog mobile de yansır); tek terim "parola", tek fiil "Hesap aç"; mobil `mobile:auth.*` ayrı, Dalga 4 Mobil eksik: hatalı alana odak taşınmıyor; metin hâlâ "Hesap oluştur" (masaüstü "Hesap aç"). |
| Hesap değiştirme örtüsü opak (eski hesabın sohbeti arkadan görünmez) | ✅ | ✅ |  |
| Güncelleme rozeti kenarsız yeşil; indirme çubuğu `progressbar` | ✅ masaüstü | — | |

**Kanıt:** `apps/web/harness-shell.html?scene=…` gerçek bileşenleri gerçek store/query
önbelleğiyle 23 durumda gösterir (ağ beklemede tutulur, canlı API'ye gidilmez);
`apps/web/src/harness/shell/verify.mjs` sistem Chrome'uyla 71 kontrol (token, font, hover/
basılı/odak, rail hapı + rozet geometrisi, daralt, komut menüsü aç/kapa + klavye, azaltılmış
hareket, çekmece + gerçek CDP dokunma kaydırması, alan doğrulaması + odak/duyuru, yükleme
hatası → Tekrar dene → gerçek yeniden çekim (kanallar + DM), telefon bildirim/hap çakışması,
sen'li metin taraması, TR+EN, temiz konsol).

**Açık:** `apps/web/public/site.webmanifest` hâlâ eski turuncu `theme_color`/`background_color`
(meta `theme-color` siyaha çekildi); pencere çerçevesi dışı. Seçili satırda mention rozetinin
rengi (mercan) tasarım dokümanının §1.5'teki "okunmamış rozeti pembe" cümlesiyle çelişiyor —
CountBadge atomuyla tutarlı olarak mercan seçildi, founder kararına açık.

## 2026-10-20 — M16 Dalga 3: sohbet yüzeyi (masaüstü + web; dal `feat/m16-ui-chat`, YAYINLANMADI)

Mesajlaşma yüzeyi Koyu Masa diline taşındı; yapı aynı, stil sistemden. Mobil karşılığı Dalga 4
(mobil sohbet taraması) — aşağıdaki ⛔'lar o dalganın görevidir.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Baloncuksuz satır; hover = yüzey tonu (#171717, 200ms), satır yüksekliği hover'da DEĞİŞMEZ | ✅ | ✅ | sanallaştırma sözleşmesi tarayıcıda ölçüldü |
| Hover araç çubuğu raised tonda, opaklık+görünürlükle solarak gelir; tepki/yanıtla/düzenle(kendi)/daha fazla, ipuçlu | ✅ | — (mobilde eylem sayfası) | klavye: avatar/ada Tab ile gelince çubuk görünür |
| Mercan yalnız "sana dair": seni anan satır (mercan iz + yıkama), senin tepkin, "YENİ" çipi | ✅ | ✅ |  |
| Tepkiler hap; seninki accent-soft, diğerleri yıkama (hover'lı satırda kaybolmaz); tepki ekle hapı hover'da | ✅ | ✅ (mevcut) | |
| Okunmamış ayracı: mercan çizgi + dolu "YENİ" çipi | ✅ | ✅ | kalıcı kuyruktaki gönderiler ilk sayfadan önce listedeyken ayraç kayboluyordu — düzeltildi |
| Yazıyor satırı: 3 nefes alan nokta, composer'ın alt boşluğunda (liste zıplamaz) | ✅ sunucu kanalı · ◑ DM/grup (akışta, aynı 20px) | ✅ |  |
| İskelet yükleme (liste, eski sayfa, sabitler, arama, davet kartı) | ✅ | ◑ | Mobil eksik: sabitlenmiş mesajlar iskelet yerine dönen gösterge; davet kartı yok. |
| Hata durumları: liste yüklenemedi (başlık + ayrıntı + yeniden dene), sabitler yüklenemedi (+ yeniden dene), arama hatası, silinmiş ek, açılamayan görsel | ✅ | ◑ | Mobil eksik: sabitlenmiş mesajlar yüklenemezse tekrar dene yok. |
| Kenarsız kartlar (bağlantı + davet önizlemesi) yıkama tonunda, görsel çözülünce solarak gelir (sanal satır yeniden bağlanınca tekrar oynamaz) | ✅ | ◑ | Mobil eksik: davet önizleme kartı yok. |
| Gün ayraçları · ↑ ile düzenle · engelli DM composer'ı · görüntüleyici yakınlaştırma · görsel ızgarası · karakter sayacı | ✅ | ✅ | ayrıntı üstteki yaşayan matriste |

**Kanıt:** `apps/web/harness-chat.html` gerçek bileşenleri (masaüstü ChatView, ChatDataProvider,
ortak liste/satır/composer, sabitler, arama, ekler, gömüler) sahte API ile çizer;
`apps/web/src/harness/chat/verify-chat.mjs` sistem Chrome'unda 95 ölçülü kontrol (token
renkleri, Inter/Onest, hover/odak/basılı, animasyonların başlayıp bitmesi, klavye yolları,
azaltılmış hareket, 0 konsol hatası, modellenmemiş API çağrısı yok).

## 2026-10-20 — M16 Dalga 3: ses / arama yüzeyleri "Koyu Masa"da (masaüstü + web)

Dal `feat/m16-ui-voice`. Yalnız görünüm ve etkileşim; medya mantığı, FSM ve
çağrı denetleyicisi değişmedi. Mobil karşılıkları Dalga 4'te (⏳).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Tek çağrı kontrol dili (`CallControl`: nötr / açık-mercan / kapalı-pembe / ayrıl-dolu pembe / kabul-yeşil) — ses paneli, DM kutusu, arama hapı, sahne çubuğu, gelen arama aynı düğmeyi kullanır | ✅ | ◑ | renk tek başına anlam taşımaz: ikon + ad + `aria-pressed`. Denetim düzeltmesi: ses panelinin ve DM kutusunun ayrıl / kapat / iptal düğmesi "kapalı" (sessiz mikrofon) tonundaydı; artık her yüzeyde dolu pembe (`call-leave-tone.test.ts`) Mobil farkı: kabul düğmesi mercan (tasarım sistemi §5.1), masaüstü yeşil. |
| Ses paneli / DM kutusu: kenarsız yüzey kartı, canlı durum noktası (bekleyen durum nefes alır), durum satırı geçişli | ✅ | ◑ | Denetim düzeltmesi: DM kutusunun durum satırı ("Görüntülü bağlantı kuruldu") ve "Başka cihazda aramadasın" başlığı gerçek 240px kenar çubuğunda kesiliyordu; artık iki satıra sarıyor (harness 240px'te TR+EN ölçüyor) Mobil eksik: durum satırı geçişsiz değişiyor. |
| Konuşma ışığı mercan: kenar çubuğu avatarında halka + yumuşak parıltı, karoda kenar içi parıltı (videonun ÜSTÜNDE) | ✅ | ✅ | eski yeşil halka kalktı |
| Sahne karolarında klavye odağı görünür: beyaz kenar + siyah iç çizgi, videonun ÜSTÜNDE (konuşma ışığından farklı) | ✅ | — (mobilde klavye odağı yok) | Denetim düzeltmesi: odak halkası videonun altında boyanıyordu, kamera/paylaşım karosunda hiç görünmüyordu; harness gerçek pikselleri ölçüyor |
| Ekran paylaşan kişinin satırında "CANLI" hapı; paylaşım karosunda ölçülen çözünürlük ("1080p" — çözülen kareden, istenen değerden değil) | ✅ | ⏳ | Mobilde yok: paylaşım karosunda CANLI hapı ve ölçülen çözünürlük yok. |
| Sahne: saf siyah zemin + tek mercan ışık, kenarsız taban kartı; sahne çubuğu cam hap, "ayrıl" geniş dolu pembe; PiP köşeye yayla kayar | ✅ | ◑ | VideoStage sıcak gradyanı kaldırıldı (Dalga 2 bilinen açığı) Mobil eksik: sahne zemini #0d0d0d (saf siyah değil), ayrıl geniş hap değil disk. |
| Gelen arama kartı: nefes alan mercan hale, etiketli üç daire, odak kart içine (Enter yanlışlıkla yanıtlamaz) | ✅ | ✅ | azaltılmış harekette hale durur |
| Kaynak seçici: iskelet yükleme, seçili kart mercan, ses seçimi radyo satırları (ok tuşlarıyla), kalite bölmeli seçim (ok tuşlarıyla) | ✅ | — (mobilde seçici yok) | Dalga 1'in üç ses seçeneği mantığı aynen. Denetim düzeltmesi: tek sütunda ses seçimi 1280×800 varsayılan pencerede ekranın altında kalıyordu; artık iki bölme (solda kaynaklar kendi kaydırmasıyla, sağda ses + kalite sabit), açıklama yalnız seçili seçenekte görünür (diğerleri ekran okuyucuda kalır). 1280×800 ve 940×560'ta üç seçenek kaydırmadan görünür |
| Kamera önizleme iskeletle başlar, aygıt seçimi `Select` atomu; aygıt ayarları radyo grupları | ✅ | ✅ |  |
| Aramaya ekle: yükleniyor iskeleti, hata + tekrar dene, "eşleşen arkadaş yok" | ✅ | ✅ | eskiden yüklenirken "eklenecek arkadaş yok" diyordu |
| Kişi başı ses + yayın sesi sürgüsü tasarım sisteminin `Slider` atomu | ✅ | ✅ (zaten kendi sürgüsü) | |
| Birlikte izle bandı, sıra paneli ve video seçici kenarsız | ✅ | ✅ |  |
| Dev-only harness `/harness-voice.html` + `src/harness/voice/verify.mjs` (95 kontrol, headless Chrome; `?lng=en` ya da `?lng=tr`, `?windows=N`) | ✅ web dev sunucusu | — | build'e girmez |

**Kapılar:** desktop typecheck · desktop test · app-ui test · i18n parite · web
typecheck/build · desktop build · eslint; harness doğrulaması varsayılan,
masaüstü seçici, hata/izin yok, azaltılmış hareket, 240px kenar çubuğu (TR+EN), karo klavye
odağı (piksel örneği) ve 1280×800 / 940×560 seçici kiplerinde 0 konsol hatası/uyarısı — tek
istisna azaltılmış hareket kipinde framer-motion'ın yalnız dev build'de yazdığı
"Reduced Motion enabled" bildirimi (üretimde `NODE_ENV` ile silinir).

## 2026-10-20 — M16 Dalga 3: kimlik her yerde (masaüstü + web; dal `feat/m16-ui-profile`, YAYINLANMADI)

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Avatar + banner kırpma editörü | ✅ | ✅ | `ImageCropDialog` + saf geometri (`lib/image-crop`, maske hep dolu) + dosya hattı (`lib/image-file`: bayttan tür, piksel bütçesi, hareketli GIF/WebP tespiti) |
| Profil kartı Koyu Masa (8:3 banner, cam eylem diskleri, iç panel, iskelet + hata/tekrar dene) | ✅ | ✅ | önizlemeler kartın kendi `ProfileIdentityPreview` işaretlemesini kullanır |
| Avatar: xl/2xl boy, foto belirme geçişi (önbellekte atlanır), durum noktası halkası `--avatar-ring` değişkenini izler, çevrilmiş durum etiketi | ✅ | — | eklemeli primitive değişikliği |
| Avatar büyütme: imlece doğru yakınlaştırma, ok/±/0 klavye, açılış/kapanış animasyonu | ✅ | ✅ |  |
| Üye menüsü: "Moderasyon" bölüm etiketi, rol seçimi gerçek `menuitemcheckbox` | ✅ | — | |
| Özel durum: üye listesi önizlemesi + kesin temizlenme saati | ✅ | ◑ | Mobil eksik: kesin temizlenme saati gösterilmiyor. |
| Banner yedek rengi: eski sıcak taban (`#1a0806`) kalktı, kişinin tonu + tek mercan ışık | ✅ | ✅ |  |
| Profil kartı pencereye sığar: en fazla Radix'in ölçtüğü yükseklik, orta bölüm kayar (alt kenar solar), DM kutusu / "Profili düzenle" sabit | ✅ | — (mobilde tam ekran sayfa) | 1280×800 ve 940×560'ta 8 kartın hepsi ekran içinde |
| Tehlikeli onaylar (at/yasakla/arkadaşlıktan çıkar/engelle, hesap silme) İptal'e odaklı açılır; açılışta Enter hiçbir şey yapmaz | ✅ | — | yasaklama sebebi alanına odaklanıp tek Enter'la yasaklıyordu |
| Hesap silme + kaydedilmemiş-değişiklik uyarısı ortak tehlike kabuğunda (ikon diski, sonuç maddeleri, darda alt sayfa) | ✅ | — | `ConfirmLayer` kaldırıldı; tek onay görünümü |
| Kullanıcı/moderasyon diyalogları her açılışta temiz (vazgeçilen taslak, eski hata, son süre seçimi geri gelmez) | ✅ | — | özel not sorgusu yalnız diyalog açıkken çalışır |
| Kırpma önizlemesi: async WebP (`toBlob`) — sürüklerken uzun görev yok; yüklenirken/hatada mevcut foto kalır, sütun söner | ✅ | ✅ | eski `toDataURL` 54–79 ms uzun görev üretiyordu |
| Avatar foto geçişi yalnız gerçek ilk yüklemede; çözülmüş URL ilk karede opak (sanal mesaj listesinde kanal değişiminde yanıp sönme yok), `src` değişimi baş harfe düşmeden yer değiştirir | ✅ | — | `packages/ui` eklemeli |

**Doğruluk düzeltmesi:** yasaklama metni "Yasağı sunucu ayarlarından kaldırabilirsin" diyordu;
masaüstünde yasak listesi/kaldırma ekranı YOK (API `GET/DELETE /groups/:id/bans` var). Metin
artık bunu vaat etmiyor; yasak kaldırma arayüzü ayrı bir iş.

**Kanıt:** `apps/web/harness-profile.html` (yalnız geliştirme) gerçek bileşenleri sahte taşıma
katmanıyla çizer; headless Chrome ile 0 konsol hatası, token/hover/odak/animasyon/azaltılmış
hareket kontrolleri.

## 2026-10-20 — M16 Dalga 3: ayarlar alanı Koyu Masa'da (masaüstü + web)

Dal `feat/m16-ui-settings`. Ayarlar katmanı ve tüm bölümleri, sunucu ayarları sekmeleri,
kanal/kategori/davet diyalogları, yıkıcı onaylar, Arkadaşlar, DM, grup sohbeti ve Son
Aramalar yeni sistemde. Mobil karşılıklar Dalga 4 ekran taramasında (aşağıdaki ⏳ satırları
o dalganın iş listesidir).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Ayarlar tam ekran katman (açılış/kapanış hareketi, kayan mercan seçim hapı, ok tuşlarıyla gezinme, ESC ipucu) | ✅ | — (mobil zaten tam ekran yığın) | Dar web ≤899px master/detail korunur; detay sayfası yandan gelir |
| Kaydedilmemiş profil taslağı yerel bölümlere geçişte de korunur | ✅ (hata düzeltmesi) | ✅ (`beforeRemove`) | Eskiden Mikrofon/Sesler/Dil gibi yerel bölüme tıklamak taslağı uyarısız siliyordu |
| Takma ad satır-içi düzenleyicide Esc yalnız düzenlemeyi iptal eder | ✅ (hata düzeltmesi) | — | Eskiden Esc tüm ayarları kapatıyordu |
| Ayarlar içinden açılan onaylar katmanın ÜSTÜNDE (diğer oturumları kapat, engeli kaldır) | ✅ (hata düzeltmesi) | — | Engeli kaldır onayı ayarların arkasında görünmez açılıyordu |
| Başarısız sistem ayarı / oturum kapatma / üye atma / istek kabul hataları söylenir | ✅ | ✅ | Eskiden sessizce yutuluyordu (§26) |
| Web'de tepsi / açılışta başlat anahtarları gösterilmez | ✅ | — | Web köprüsü bunları hiç uygulamıyordu; anahtarlar geri sekiyordu |
| Sunucu ayarları: kaydedilmemiş-değişiklik çubuğu (Genel + rol düzenleyici), kapatma/sekme değişimi reddedilip çubuk uyarır | ✅ | ⏳ | Genel sekmesi artık kaydedince kapanmıyor; çubuk kaybolur Mobilde yok: sunucu/rol ayarlarında kaydedilmemiş-değişiklik çubuğu ve çıkış koruması yok. |
| Rol rengi: hazır renkler + özel renk (renk seçici + doğrulanan #hex) + canlı önizleme, izinler anahtar satırı | ✅ | ◑ | Mobil eksik: özel #hex renk yok (yalnız hazır renkler). |
| Üyeler sekmesinde arama, rol menüsü onay kutulu | ✅ | ◑ | 100+ üyede `useDeferredValue` + `content-visibility` Mobil eksik: üye araması yok. |
| Emoji yükleyici: sürükle-bırak, önizleme, canlı ad doğrulama, kullanım göstergesi | ✅ | ✅ | Mobil: seçilen görsel önizlemesi, yazarken ad doğrulaması, kullanım çubuğu (`app/(app)/server-emoji.tsx`); sürükle-bırak yerine görsel seçici. |
| Diyaloglarda canlı doğrulama + karakter sayacı; davet bağlantısı yapıştırınca kod gösterimi | ✅ | ⏳ | Mobilde yok: doğrulama yalnız gönderirken, karakter sayacı yok. |
| Panoya kopyala: kopyalandı durumu + duyuru, kopyalanamazsa söylenir ve değer seçili gelir | ✅ | — (mobil paylaşım sayfası) | |
| Arkadaşlar: sekme çubuğu, arama, durum satırı, iskelet/boş/hata | ✅ | ◑ | Mobil eksik: arkadaş araması yok. |
| Grup sohbeti yükleniyor iskeleti + başlıklı hata; DM/grup başlıkları 64px | ✅ | ✅ |  |
| Rol / üye / sunucu ayarları yüklenemezse hata + yeniden dene (eskiden "henüz rol yok, oluştur" ya da sessizce salt-okunur Genel sekmesi) | ✅ (denetim düzeltmesi) | ✅ | Roller yüklenmezse Üyeler sekmesi bunu söyler Mobil: kanal ayarları / rol düzenleyici / üye rolleri zaten hata + tekrar dene gösteriyordu; sunucu ayarlarının rol listesi yüklenirken ve hatada "henüz rol yok" diyordu — `feat/m16-final-fixes`'te düzeltildi (`resolveListLoadState`, testli). |
| Sunucu taslağı başka yerden değişirse: temiz form yeni değeri izler, kirli form "başka yerden değişti" der + "Son hâlini yükle" | ✅ (denetim düzeltmesi) | ⏳ | Eskiden uzak düzenleme formu sahte-kirli yapıp diyaloğu kilitliyordu Mobilde yok: "başka yerden değişti" durumu ele alınmıyor. |
| Rol düzenleyici dar ekranda alt alta (sarılan rol hapları + tam genişlik düzenleyici) | ✅ (390px) | — | Konteyner sorgusu: diyalog genişliğine bakar |
| Kaydedilmemiş-çubuk uyarısı klavye odağını korur, sebebi aynı canlı bölgede duyurur | ✅ (denetim düzeltmesi) | — | |
| Ayarlar katmanı ve güncelleme bildirimi içindeki ipuçları (tooltip) görünür | ✅ (denetim düzeltmesi) | — | İpucu her katmanın üstünde (z-150) |
| Tek hata bloğu: ayarlar, Arkadaşlar, Son Aramalar, grup sohbeti; oturum hataları Türkçe | ✅ | ✅ |  |
| Dar ayarlar listesinde görünür klavye odağı (mercan halka) | ✅ | — | |

**Kanıt:** `apps/web/harness-settings.html` (yalnız geliştirme, build'e girmez) gerçek
bileşenleri bellek-içi sahte API ile çalıştırır; Playwright + sistem Chrome senaryoları
(ayarlar, sunucu ayarları, diyaloglar, arkadaş/DM/grup/aramalar, güncellemeler, 390px,
azaltılmış hareket) 0 konsol hatası/uyarısıyla geçti. Denetim turu düzeltmeleri aynı sayfada 86 kontrolle
yeniden sürüldü (zorla başarısız okumalar `?failReads=`, uzak düzenleme `__harness.remote`).

**Bilinen açık:** `MessageList` DM ve grup akışında da "#Ad kanalına hoş geldin" girişi
gösteriyor (sohbet alanı sahibinin dosyası). Profil bölümünün kendi kaydet/vazgeç akışı
ayrı sahipte; ayarlar katmanındaki kaydedilmemiş-değişiklik çubuğu ona bağlanmadı.

## 2026-10-20 — M16 Dalga 4: mobil atom kiti (Reanimated + gesture-handler + expo-blur)

Dal `feat/m16-mobile-kit`, YAYINLANMADI. Native bağımlılıklar Dalga 1'in runtime 2.1.0
APK döngüsüne bağlı — bu dal kendi başına OTA olarak gidemez (Reanimated/gesture-handler/
expo-blur native modül). Ekranlar henüz taşınmadı; değişen ortak bileşenler aşağıda.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Basış = ton (120ms içeri / 200ms dışarı) + buton ölçeği (0.97, ikon 0.92); satır yalnız ton | ✅ CSS + framer `pressable` | ✅ `ui/Touchable` | UI iş parçacığında; donanım klavyesi/D-pad odağında 2px mercan `outline` |
| Button 7 varyant × 3 boy (+ yükleniyor genişliği korur, meşgul ≠ devre dışı) | ✅ | ✅ `ui/Button` | Eski `components/Button` adaptör: eski `primary` → `accent`, `ghost` → `outline` (anlam korunur) |
| IconButton (aç/kapa duyurusu, uzun bas → ipucu, köşe rozeti); açık durum = mercan yıkama + mercan mürekkep, her durumun kendi basılı tonu | ✅ | ✅ `ui/IconButton` | `label` zorunlu (erişilebilir ad + ipucu). İpucu pencere koordinatında yerleşir: ortalı, ekran içinde kalır, üstte yer yoksa alta döner (`placeTooltip` testli). Açık durum masaüstü `bg-accent-surface` ve mobil `StageControlBar` ile aynı dil |
| Badge / CountBadge (0'da yok, 99+, tabular) / Chip (radyo/onay/kaldırılabilir) | ✅ | ✅ `ui/Badge`, `ui/Chip` | `UnreadCountBadge` API'si aynen, kit `CountPill` ile çiziliyor |
| Switch 44×24 konum yayı · Checkbox (karışık) · RadioGroup (seçili satır mercan yıkama) · Slider · Segmented (kayan hap) | ✅ | ✅ | Slider gesture-handler + Reanimated, dikey kaydırmayı çalmaz, TalkBack ayarlanabilir |
| TextField: yüzey → odakta raised ton, mercan imleç/seçim; hata = alan zemini pembe yıkama + 13px satır (çerçeve yok) | ✅ | ✅ | Mercan imleç `ui/Text` `TextInput`'ta, uygulamanın BÜTÜN alanlarında |
| Avatar: adlı boylar, 2px halka, konuşma halkası, URL başına yükleme hatası → baş harf, expo-image önbellek + geçiş · AvatarStack (−%30, +N) | ✅ | ✅ | `uri` zorunluluğu ve kapsam testi aynen |
| İskelet: wash-strong blok + opaklık nabzı (1 → .5 → 1, 2s, masaüstü `animate-pulse` ile aynı eğri; tek paylaşılan değer, azaltılmış harekette durağan) · EmptyState nötr/hata | ✅ `animate-pulse` | ✅ | Liste iskeletleri tek "Yükleniyor" olarak duyurulur (`mobile:ui.loading`). Önceki mobil zemin `surfaceRaised` idi → `wash-strong` (her kap tonunda görünür) |
| Toast kuyruğu (`toast()`, aynı anahtar = değiştir, en fazla 3, yana kaydır = kapat, parmak üstündeyken süre durur) · Banner (form/ekran uyarısı) | ✅ | ✅ `ui/Toast` + kökte ve her Sheet'te `<Toaster/>` | Android'de her RN `Modal` ayrı pencere: kuyruğu en son açılan host çizer, böylece açık sheet'in ÜSTÜNDE görünür (TalkBack bir kez okur). Henüz hiçbir ekran `toast()` çağırmıyor; `ImageActionSheet`/`ImageViewer` `ToastAndroid`'de KALMALI ya da ImageViewer `<Modal>`'ı kendi `<Toaster/>`'ını almalı — yoksa "Kaydedildi" görünmez |
| Sürüklenebilir sheet: yaylı açılış, hız projeksiyonlu durak seçimi, fırlat/sürükle = kapat, yukarı lastik, perde konumdan türetilir, klavye kaçınma, geri tuşu; kapatma bir İSTEK (çağıran reddederse kart bırakıldığı yerden geri yaylanır) | ✅ Dialog/Sheet | ✅ `ui/Sheet` | `ActionSheet`/`ActionRow` aynı API ile Sheet üstünde → 6 çağrı yeri değişmeden geçti. Kalan ~20 elle yazılmış RN `<Modal>` sheet'i ekran dalgasında |
| Cam yüzey | ✅ `backdrop-filter` | ◑ `ui/Glass` | iOS gerçek bulanıklık; Android yalnız `blurTarget` verilirse (expo-blur Modal pencereleri arasında bulanıklaştıramıyor), yoksa opak `glass-strong` |

**Doğrulama:** typecheck, lint, 62+ test dosyası (yeni: `kit-math` snap/sürgü/sayaç/renk,
`toast-store`, `motion-presets` masaüstü `pressable`/`toastPop`/`bannerDrop`/`popIn`
kaynağına karşı — basış yayı 520→521 mutasyonuyla kırmızıya döndüğü görüldü),
`expo export --platform android`. **Cihazda/emülatörde dokunma, sürükleme ve TalkBack
denemesi YAPILMADI** — AVD'deki tek kurulu yapı release 2.1.0 (versionCode 11, Metro'dan
JS yükleyemez, `demli://ui-kit` `__DEV__` dışında ana sayfaya yönlenir) ve bu adımda APK
kurmak yasaktı. **Merge/yayın KAPISI:** 2.1.0 debug/dev-client yapısında AVD `demli-debug`
üzerinde `demli://ui-kit`'in her bölümü ve durumu (basılı, D-pad odağı, devre dışı, meşgul,
hata, boş, yükleniyor, azaltılmış hareket) + kitin dokunduğu canlı ekranlar (giriş/profil
alanları, ayar satırları, ana sayfa Segmented, üye/sunucu/görsel ActionSheet'leri, sohbet
iskeleti) ekran görüntüsüyle; çok duraklı sheet'i içerik kaydırılmışken sürükleme, sheet
içinde klavye açık alan, not modunda kapatmanın menüye dönmesi, sheet içinden tost,
TalkBack ile Slider/Switch/Sheet, tost kaydırma.

## 2026-10-20 — M16 Dalga 4: mobil kabuk ve gezinme (Koyu Masa)

Dal `feat/m16-mobile-shell` (`feat/m16-mobile-kit` üstünde), YAYINLANMADI. Kit gibi native
bağımlılıklara (Reanimated/gesture-handler/expo-blur) dayanır → 2.1.0 APK döngüsüyle çıkar.
`app.json` açılış ekranı `#1a0806` → `#000000`, görsel 200 → 112dp: yalnız yeni APK'da etkili
(OTA'da eski kahverengi native splash'ten siyaha geçiş kalır).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Açılış: siyah sayfa, işaret native splash'le aynı yerde/boyda, tek mercan parıltı, gerçek aşama çubuğu | ✅ (M16 kabuk dalı) | ✅ | İki montajda (sağlayıcı öncesi/sonrası) varış animasyonu bir kez oynar, çubuk kesintisiz. Takılma → "Tekrar dene / Yeniden başlat" kit düğmeleri |
| Giriş: parıltı + kenarsız kart, alan ALTINDA doğrulama (pembe yıkama), sunucu reddi bant, kayıt alanları yerinde açılır | ✅ (M16 kabuk dalı) | ✅ | `sign-in-validation` saf + test. Klavye: KAV yerine IME yüksekliği. Birincil düğme beyaz (masaüstüyle aynı). Doğum tarihi alanı TextField reçetesinde (`error` desteği; add-account ve yaş doğrulamada da görünür) |
| Alt gezinme: yüzen cam hap, mercan gösterge konum yayıyla kayar, mürekkep geçişi, Ana Sayfa okunmamış + Arkadaşlar bekleyen istek sayacı | — (masaüstünde alt sekme yok) | ✅ | Klavye açıkken iner. Arkadaşlar sekme sayacı YENİ (aynı sayı İstekler segmentinde ve Sen sekmesinde) |
| Ana sayfa ada çerçevesi: siyah sayfa + ray, panel taban tonunda radius-24 ada; panel değişimi solarak | ✅ (AppShell adaları) | ✅ | |
| Ray: 48px yuvarlak-kare kutu, kenar hapı (seçili 36 mercan / okunmamış 8 beyaz / boş), basışta 0.92, ilk yüklemede kutu iskeleti | ✅ (GroupRail RailPill) | ✅ | Masaüstüyle aynı üç durum ve yükseklik (`shell-math` testli). Sayı rozeti köşede (sayılmamış okunmamış "1+") |
| Tek satır dili (ShellRow): boşta dolgu yok, basışta ton, seçili mercan yıkama, okunmamış beyaz kenar pipi (bahsetmede mercan), sessiz %55 | ✅ (`shellRow`) | ✅ | DM, grup sohbeti, kanal, üye, arkadaş, komut paleti ve arama satırları. Pip ve rozetin ÇIKIŞ animasyonu yok (sanal liste hücresinde geç kaldırılan görünüm = Fabric "view already has a parent" deseni) |
| Kanal satırı sayı rozeti: düz okunmamış NÖTR, yalnız bahsetme MERCAN; sayılmamışta "1+" yok (yalnız pip); "yalnız bahsetmeler" susturmasında sayı yok | ✅ (ChannelItem) | ✅ | Denetim düzeltmesi: mobil her okunmamışı mercan + "1+" gösteriyordu, ray kutusuyla zıt sinyal. `channelRowBadge` saf + test. DM rozeti mercan kalır (DM = sana yazılmış) |
| Bağlı olduğun ses kanalı: mercan glif + tam mürekkep ad (yıkama değil — yıkama "sohbetini okuduğun kanal" demek) | ✅ (ChannelItem `isVoiceTarget`) | ✅ | Skaler seçici (yalnız katıl/ayrıl'da değişir, §27); TalkBack "Bağlısın" |
| Bölüm başlıkları cümle düzeninde 13px (büyük harf yok) | ✅ (SectionHeading) | ✅ | Mobil `ui/SectionHeading` |
| Kanal listesi yüklenemedi → hata durumu + tekrar dene (eskiden "metin kanalı yok" yalanı) | ✅ | ✅ | Kategori oku döner, açılan kategori solarak gelir (katlanınca anında gider); sıralama reddi kapatılabilir Banner |
| "Metin kanalı yok" yalnız sunucuda GERÇEKTEN metin kanalı yoksa; tüm metin kanalları kategorideyse üst "Metin kanalları" bölümü hiç çizilmez | ✅ | ✅ | Denetim düzeltmesi (M18 kategorili sunucular). `uncategorizedTextSection` saf + test |
| DM listesi: DM'ler gelene kadar iskelet (grup sohbetleri önce boş dönse bile "Direkt mesaj yok" demez); DM veya grup sohbeti yüklenemezse liste durur, üstte tehlike bandı + tekrar dene | ✅ | ✅ | Denetim düzeltmesi: grup sohbeti hatası hiç okunmuyordu. `dmListStates` saf + test |
| Ana sayfa şeritleri (bağlantı, yaş hatırlatması) kit Banner'ında; yaş doğrulama kit Sheet'inde | ✅ | ✅ | Kenarlıksız (eski çizgili şerit + elle yazılmış Modal kaldırıldı). Bağlantı bandı sohbet ekranlarında da aynı bileşen |
| Arkadaşlar: çevrimiçi/çevrimdışı bölümleri, her segmentte iskelet/hata/boş durum, istek hatası artık "istek yok" görünmüyor (kısmi hatada bant), eylem hataları tost | ✅ (Çevrimiçi/Tümü sekmeleri) | ✅ | Ekle: başarı Banner'ı |
| Sen: profil kartı (üstte mercan ışık, yüklenirken iskelet), gruplu kartlar, bekleyen istek sayısı | ✅ (profil kartı reçetesi) | ✅ | |
| Komut paleti: yazarken en üst sonuç mercan, klavyenin git/Enter tuşu onu çalıştırır | ✅ (cmdk) | ✅ | `primaryPaletteItem` saf + test; canlı girdiden yeniden hesaplanır |
| Kanal arama: başlangıç/kısa/iskelet/hata+tekrar/sonuç yok durumları, eşleşen metin vurgulu | ✅ (`highlightQuery`) | ✅ | Sonraki sayfa hatası mevcut sonuçları korur, altta tekrar dene |
| Uygulama içi bildirim: cam kart, sekmesiz varış (yay, zıplama yok), yukarı kaydır = kapat, parmak üstündeyken süre durur | ✅ (toast) | ✅ | TalkBack'e duyurulur. Denetim düzeltmesi: yana kaydırma/OS iptali sonrası süre yeniden kuruluyor (`onFinalize`; eskiden kart sonsuza dek kalıyordu) — `bannerRelease` saf + test |
| Güncelleme hapları (OTA hazır, isteğe bağlı APK) cam hap, alt kromun (sekme çubuğu + çağrı sırasında ses çubuğu) üstünde; APK indirmesi gerçek ilerlemeyle | ✅ | ✅ | Zorunlu OTA/APK ekranları açılış yüzeyinde; OTA için uydurma yüzde yok (expo-updates oran vermiyor) |
| Alt krom geometrisi: çağrı sırasında yeni-DM düğmesi, güncelleme hapı, son liste satırları ve ray "+" kutusu ses çubuğunun ALTINDA kalmaz | — | ✅ | Denetim düzeltmesi: yüzen sekme çubuğu sahneleri tam boya uzattı, eski boşluk yalnız hapı aşıyordu. Tek kaynak `lib/bottom-chrome` (ses çubuğu da kendini onunla konumlar) — `bottom-chrome.test` dikdörtgen çakışmasını sabitler |
| Hesap değiştirme örtüsü: siyah sayfa + işaret | ✅ | ✅ | Çıkışta animasyon YOK (bilerek: Fabric "view already has a parent" P0'ı tam bu anda yaşanmıştı). Oturum ağacı `LayoutAnimationConfig skipExiting` ile sarılı: geçişte söküldüğünde içindeki hiçbir `exiting` görünümü hayatta tutmaz. **Cihazda doğrulanmadı** — 2.1.0 APK öncesi AVD'de hesap değiştir + DM okundu yolu denenmeli |
| Native başlıklar sayfa tonunda, çizgisiz | ✅ | ✅ | Tüm oturum açık ekranların başlığı `colors.app` |

**Doğrulama:** `pnpm --filter @demli/mobile typecheck · lint · test` (68 dosya / 744 test; yeni:
`shell-math`, `sign-in-validation`, `primaryPaletteItem`, denetim turunda `bottom-chrome`,
`home-list-rules`, `in-app-banner-gesture`), `pnpm --filter @demli/i18n test`,
`npx expo export --platform android`. **Cihazda/emülatörde görsel ve dokunma denemesi
YAPILMADI** (bu adımda APK/emülatör yasak) — radyal parıltı (`experimental_backgroundImage`),
`boxShadow` halesi, hap göstergesi, ray hapı ve sekme çubuğunun klavyeyle inişi ilk APK'da
AVD `demli-debug` üzerinde ekran görüntüsüyle doğrulanmalı.

## 2026-10-20 — M16 Dalga 4: mobil sohbet taraması (dal `feat/m16-mobile-chat`, YAYINLANMADI)

`feat/m16-mobile-kit` üstüne. Yapı aynı (tek `ChatThread`: metin kanalı, sesli kanal
sohbeti, düz grup sohbeti, DM), stil Koyu Masa'dan. Native bağımlılık eklenmedi (kitin
Reanimated/gesture-handler'ı) → kitle aynı APK döngüsüne bağlı. Dalga 3 masaüstü sohbet
tablosundaki "⛔ M16 Dalga 4" mobil hücreleri bu dalla kapanıyor (birleştirmede çevrilecek).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Baloncuksuz satır; basış = ton (110ms gecikmeli, kaydırma satırları yakıp söndürmez) | ✅ | ✅ | `MessageBubble`; yükselme/zıplama yok. Android: sohbeti sürüklemek klavyeyi kapatır (`on-drag`; `interactive` yalnız iOS), satıra dokunmak da kapatır; tepki hapı/bağlantı klavye açıkken ilk dokunuşta çalışır |
| Mercan yalnız "sana dair": seni anan satır (mercan kenar + %6 yıkama), senin tepkin, YENİ çizgisi, atlanan mesajın mercan parlaması (sönerek) | ✅ | ✅ | |
| Gün ayraçları (Bugün / Dün / uygulama dilinde tarih, yıl yalnız farklıysa); ayraç grubu yeniden başlatır | ✅ | ✅ | `chat/thread-rows.ts` saf + testli (gece yarısında gruplama kırılır, daha eski sayfa varken en eski yüklü mesaja ayraç konmaz) |
| Okunmamış çizgisi: mercan iz + dolu "YENİ" çipi | ✅ | ✅ | Çip metni katalogda büyük harf (RN `textTransform` Türkçe İ'yi bozar) |
| Yanıt: avatar sütunundan alıntıya dirsek çizgisi + mini avatar; dokun → hedefe kaydır + parlama | ✅ (dirseksiz) | ✅ | Alıntı satırı ve composer yanıt şeridi `@Ad` gösterir, `<@id>` değil (`client-core` `messagePreviewText`, testli; 120 karakter kesiminin yarıladığı bahsetme atılır). Masaüstü yanıt çubuğu hâlâ ham `replyPreviewText` → ⛔ masaüstü takibi |
| Sağa kaydır = yanıtla (eşikte haptik, dikey hareket önce iptal eder) + ekran okuyucu eylemi | — (fare) | ✅ | Composer'a odak verir. Engellediğin kişiyle DM'de kaydırma, Yanıtla ve Düzenle hiç sunulmaz; açık yanıt/düzenleme taslağı düşer (`chat/message-affordances.ts` testli) |
| Uzun bas sayfası kit Sheet'inde: mesaj önizlemesi, hızlı tepkiler (seninkiler seçili), Yanıtla/Kopyala/Sabitle/Düzenle, Sil **aynı sayfada onay adımıyla** | ✅ menü + onay diyaloğu | ✅ | Sistem `Alert`'i kalktı; kopyala/sil/sabitle sonucu tost — sayfa kapanırken tost alttaki pencereye bir kez çizilir (kapanan sayfa tost konağını hemen bırakır). Hızlı tepki hücreleri pencere genişliğinden (40–44dp, `chat/reaction-row-math.ts` testli): 360dp'de 7 emoji + "daha fazla", 393dp+ tam palet; "daha fazla" hiç düşmez. Önizleme `<@id>`/`**` değil okunduğu gibi (`@Ad`, spoiler gizli) |
| Tepkiler hap; + hapı tam seçiciyi açar | ✅ | ✅ | |
| Durumlar: iskelet · ilk sayfa hatası (başlık + neden + yeniden dene) · boş (yeri adlandırır) · eski sayfa iskeleti / satır içi yeniden dene · geçmişin başı başlığı (kanal/grup/DM kartı) | ✅ | ✅ | Önceden ilk sayfa hatası "Henüz mesaj yok" diyordu (yalan durum) |
| "En sona git" hapı: yukarıdayken gelen başkalarının mesajlarını sayar ("3 yeni mesaj") | ? (bu dalda ölçülmedi) | ✅ | |
| Yazıyor: 3 nefes alan nokta, yüksekliği sabit (liste zıplamaz) | ✅ | ✅ | |
| Varlık (presence) tikinde tüm sohbet yeniden çizilmez | ? (bu dalda ölçülmedi) | ✅ | Satır kendi yazarının durumunu okur; satırlar alan bazlı karşılaştırmayla memo (§27). Önceden `ChatThread` `presence`'a abone olduğu için her durum değişimi tüm görünür satırları yeniden çiziyordu |
| Composer: kenarsız alan (r18), odakta bir ton yukarı + iç çizgi; yanıt/düzenleme şeridi ve ekler alanın İÇİNDE; gönder tonu hazırlığa göre | ✅ | ✅ | |
| Bahsetme listesi: "Üyeler" başlığı, yazılan önek kalın (Türkçe I/İ/ı güvenli) | ✅ (`aria-activedescendant`) | ✅ | Eşleştirme de Türkçe-güvenli: ortak `rankMentionCandidates` artık I/İ/ı/i'yi aynı harf sayıyor (`@is`→İsmail, `@ır`→Irmak, `@ış`→Işık; önceden düz `toLowerCase` bunları düşürüyordu, masaüstü dahil). Katlama `client-core/mentions.ts` `foldMentionChar`, kalın önek aynı katlamayı kullanır; ikisi de testli |
| Karakter sayacı (son 200, son 20'de pembe) | ✅ | ✅ | |
| Yükleme: çip üstünde canlı yüzde + çubuk (`progressbar`), işleniyor göstergesi, hata = yeniden dene | ✅ | ✅ | |
| DM'de engellediğin kişi: composer yerine dürüst durum + "Engeli kaldır" (profilinkiyle aynı onay) | ✅ | ✅ | Engel listesi yalnız DM açıkken çekilir; karşı tarafın engeli asla gösterilmez |
| Çoklu görsel = eşit kare ızgara (2/4 → 2 sütun, diğerleri 3); tek görsel oranını korur; yüklenirken nabız | ✅ | ✅ | Kutu bayt yüklenmeden kesin (§27) |
| Görüntüleyici: parmakların altında yakınlaştır (1–4×), momentumlu kaydır (kenarda direnir, kenar dışında bırakılınca yayla geri döner), çift dokun, mesajın görselleri arasında kaydır + "2 / 3", dikey kaydırarak kapat, tek dokun = denetimleri gizle; önceki/sonraki/kaydet/kopyala/kapat düğmeleri | ✅ | ✅ | `attachments/viewer-math.ts` testli; görüntüleyici kendi `<Toaster/>`'ını taşır (kaydet/kopyala sonucu görselin üstünde). Kanal medya ızgarası da aynı görüntüleyiciyi açar. Görüntüleyici ve sheet pencereleri JS dokunuşunu kendi kökünde bitirir (`MODAL_RESPONDER_BARRIER`): görsele uzun basmak arkadaki satırın mesaj sayfasını açmaz |
| Ses eki = dosya kartı + oynatma ilerleme çizgisi | ✅ | ✅ | |
| Emoji seçici ve ek menüsü kit Sheet'inde (sürükle/kapat, geri tuşu); kategori çubuğu altta | ✅ | ✅ | `Sheet`'e geriye uyumlu `scrollRef` eklendi |
| Bağlantı önizlemesi kenarsız yüzey kartı (r16), basış bir ton yukarı | ✅ | ✅ | |
| Sabitlenmiş mesajlar sayfası | ✅ | ◑ hâlâ eski RN `Modal` | bu dalın sahiplik dışında (`PinnedMessagesSheet`) |

**Denetim turu (2026-10-20):** 9 hasmane bulgudan 8'i kodda düzeltildi (yukarıdaki satırlar); 9.'su (cihaz kanıtı) aşağıda.

**Doğrulama:** `pnpm --filter @demli/mobile typecheck` · `test` (68 dosya, 729 test) · `@demli/client-core` (621) ·
`lint` · `pnpm --filter @demli/i18n test` (TR/EN parite) · `npx expo export --platform
android`. **Cihazda/emülatörde DENENMEDİ** — founder kuralı: bu makinede emülatör çalıştırılmıyor, cihaz testlerini founder yayından sonra kendisi yapıyor. Aşağıdaki liste founder cihaz testinin kontrol listesidir. Merge/yayın kapısı (AVD
`demli-debug`, kitin dev-client yapısı): uzun liste kaydırma + eski sayfa yükleme, kaydırırken
satır yanıp sönmemesi, sağa kaydır-yanıtla ile dikey kaydırmanın çakışmaması ve uzun basın
hâlâ çalışması, mesaj sayfası → sil onayı, yanıt dirseğinin hizası, görüntüleyicide
sıkıştır/çift dokun/kaydır/kapat ve kaydet tostu, yükleme yüzdesi, emoji sayfasında kategori
değişince başa dönme, TalkBack ile satır eylemleri ("Yanıtla"), azaltılmış hareket; denetim turundan: 360dp telefonda hızlı tepki satırı, kopyala tostunun bir kez (altta) görünmesi, yakınlaştırılmış görseli kenardan taşırıp bırakma, görsele 1 sn basılı tutma (mesaj sayfası açılmamalı), klavye açıkken sohbeti sürükleme/satıra dokunma, engellenen DM'de kaydırma (tepki yok).

## 2026-10-20 — M16 Dalga 4: mobil arama yüzeyleri (sesli oda · özel arama · birlikte izleme)

Dal `feat/m16-mobile-voice` (`feat/m16-mobile-kit` üstünde), YAYINLANMADI. Kitin native
bağımlılıklarına bağlı → aynı runtime 2.1.0 APK döngüsü. Medya/FSM mantığı değişmedi; yalnız
çizim, durumlar ve hareket. Masaüstü karşılığı Dalga 3'ün ses/arama dalında (ayrı iş).

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Konuşma göstergesi: karo kenarında 2px mercan halka + içe düşen mercan parıltı, ton adımında (200ms) açılıp kapanır; TalkBack "X, konuşuyor" okur | Dalga 3 | ✅ | Eskiden yeşil (`online`) 2px kenar. Sahne karosu, ızgara, şerit ve PiP aynı `SpeakingFrame`'i kullanır. Yalnız o görünüm canlanır, video yeniden çizilmez |
| Karo dili: kenarsız, radius 16, saf siyah zemin, ad/mikrofon hapı (`scrim` + iç çizgi imzası), basınca beyaz yıkama (yükselme/ölçek yok) | Dalga 3 | ✅ | Odak karosunun ikinci (mercan) halkası kaldırıldı — konuşma halkasıyla yarışıyordu |
| Kamerası kapalı karo: nötr `surface` zemin + avatarın arkasında kişinin renk tonunda soluk ışık (%16, masaüstü karo diskiyle aynı ton `hsl(h 60% 50%)`); PiP zeminleri de aynı | ✅ | ✅ | Eskiden tam kaplayan doygun kişi-başı gradyan: kamerasız oda doygun bloklara dönüyor, mercan konuşma halkası ve pembe tehlike tonuyla karışıyordu, masaüstüyle de uyuşmuyordu. PiP'teki "Kamera kapalı" yazısı artık her tonda `surface` üstünde |
| PiP videosu kendi katmanlarının ALTINDA: konuşma halkası, ad şeridi ve kapat düğmesi kameralı PiP'te de görünür | — | ✅ | `zOrder` 2 (`setZOrderOnTop`) → 1 (`setZOrderMediaOverlay`): video ana tam ekran yüzeyinin üstünde, pencerenin altında. Izgaradaki yerel kamera karosuyla aynı katmanlama. **Cihazda doğrulanmadı** |
| Alt dok — tek tehlike dili: susturulmuş / sağırlaştırılmış = pembe YIKAMA, Ayrıl/Kapat = DOLU pembe disk, açık kamera/paylaşım = mercan yıkama, kapalı kamera nötr (asla kırmızı) | Dalga 3 | ✅ | Eskiden kapalı kamera da kırmızıydı. Dok bir "masa kenarı" paneli (surface, üst radius 24, kenarsız); sesli oda ve özel arama aynı `ControlDock` + `VoiceControls`. Özel aramada kırmızı diskin etiketi artık ne yaptığını söyler (çalarken "İptal", canlıyken "Aramadan ayrıl") |
| Sahne içi çubuk: cam hap (`glass-strong`), veil diskler, aynı tehlike dili; çubuğa dokunmak çubuğu GİZLEMEZ (parmak üstündeyken sabit, bırakınca gizlenme sayacı yeniden başlar) | Dalga 3 | ✅ | Uzun basınca ipucu çıkar (kesilmesin diye `ui/Glass` sarmalayıcısı kullanılmadı; Android'de görünüm aynı). Eskiden çubuk aç/kapa dokunuşunu yakalayan görünümün içindeydi: her basış çubuğu da gizliyor, ipucu sönmüş çubuğun içinde açılıyordu |
| Gelen arama: arayanın arkasında mercan radyal ışık, YALNIZ çalarken 1.4s nefes alır (bağlanıyor/bitti/koltuk uzakta = sabit ışık); Reddet dolu pembe, Kabul dolu MERCAN, Görüntülü nötr | Dalga 3 | ✅ | Tasarım sistemi §5.1 "Katıl mercan / Reddet tehlike" — eski yeşil kabul düğmesi markadan çıktı. Azaltılmış harekette ışık sabit. Örtü yumuşak açılır/kapanır |
| Özel arama başlığı: çalarken nefes alan mercan nokta, cevaplanınca yeşil "canlı" nokta + tabular süre; küçült ve kişi ekle disk | Dalga 3 | ✅ | Kişi ekle 360dp'de başlığa yer kalsın diye etiketli düğmeden diske geçti (uzun basınca adı). TalkBack süreyi her saniye OKUMAZ: yalnız aşama değişince (çalıyor → bağlanıyor → aramada) bir kez duyurulur; satıra odaklanınca "Aramada, 0:42" |
| Mini çubuklar (sesli oda · arama · "X seni arıyor"): yüzen cam çubuk, gölgesiz; alttan yükselir / üstten iner, hızlı adımda çıkar | Dalga 3 | ✅ | Ses çubuğundaki "🔊" emoji başlıktan çıktı (glif). Arama çubuğunda koltuk alma = mercan `Button` (yükleniyor durumu var) |
| Koltuk uzakta bandı: bilgi bandı (sonucu söyler), mercan "Buraya al / Geri katıl", pembe yıkamalı "Kapat" | Dalga 3 | ✅ | Kaynak-değişmez testleri (`seat-model.test.ts`) aynen geçiyor |
| Bildirimler (yalnız kalma geri sayımı, ses hatası) kit Banner'ı: iner/çekilir; geri sayım her saniye yeniden OKUNMAZ | ✅ VoicePanel | ✅ | `Banner`'a geriye uyumlu `live` özelliği eklendi |
| Oda durum satırı: bağlanırken/yeniden bağlanırken nefes alan nokta, durum kendi renginde, kişi sayısı soluk | ✅ | ✅ | Eski spinner + düz nokta |
| Sahne boş/yükleniyor/hata: katılırken iki karo iskeleti (bir kez "Sese katılınıyor" okunur), katılma başarısızsa hata bloğu + "Tekrar katıl" | Dalga 3 | ✅ | Yeni metinler `voice.joinFailedTitle/Subtitle`, `voice.rejoin` (TR+EN) |
| Kişi başı ses: kit Sheet + Slider (UI iş parçacığı, %5 adım, %100 çentiği, değer hapı, TalkBack ayarlanabilir), kişinin yüzü başlıkta | ◑ %100 | ✅ %200 | PanResponder sürgüsü emekli. `Slider`'a geriye uyumlu `marks` eklendi |
| Ses çıkışı seçici: yüzey çipi (rota + aşağı ok) → kit Sheet radyo satırları (seçili = mercan yıkama + tik), hoparlör yankı uyarısı bilgi bandı | — | ✅ | Mantık aynı: açınca rota tazelenir, seçim `noteUserAudioRoutePick` + `setOutputDevice` |
| Kişi ekle (gruba yükseltme): kit Sheet; iskelet, arkadaş listesi yüklenemezse hata bloğu + "Tekrar dene" ("Arama sürüyor. Listeyi yeniden yükleyebilirsin."), boş blok, istek sürerken diğer satırlar %40 + o satırda dönen gösterge; yükseltme reddedilirse tost ("Arama sürüyor. Tekrar deneyebilirsin.") | Dalga 3 | ✅ | Eskiden hata sessizce yutuluyordu; yükleme hatası da "eklenecek arkadaş yok" diyordu |
| Son aramalar: kartsız satırlar, ilk yükleme iskelet, hata bloğu + tekrar dene, sonraki sayfa iskelet satır, geri ara diski | Dalga 3 | ✅ | |
| Ekran paylaşımı + tam ekran: veil diskler (PiP açık = mercan), başlık hapı, film sesi kit Slider (sürüklerken kontroller sabit kalır, sonra yeniden sayar) | Dalga 3 | ✅ | Tam ekran Modal'ı artık kendi `GestureHandlerRootView`'ını taşıyor. Yatay kilit mantığı aynı |
| Kamera önizleme + paylaşım kalitesi: kit Sheet; önizleme iskeleti → ilk karede belirerek açılma, hata bloğu + tekrar dene, ön/arka kayan Segmented; çözünürlük/FPS radyo çipleri, Android "tüm ekran" bilgi bandı | ✅ | ✅ | `screen-share-fps-offer.test.ts` aynen geçiyor |
| Birlikte izleme: kenarsız bant + hayalet diskler (bitir = pembe yıkama), red = tehlike bandı, film üstünde veil diskler, sıra ve video seçici kit Sheet (şimdi oynuyor mercan yıkama, film sesi radyo çipleri, arama iskeleti, sonuç yok/boş sıra bloğu, Koyu Masa alanı) | Dalga 3 | ✅ | |

**Doğrulama:** `pnpm --filter @demli/mobile typecheck` · `lint` · `test` · `pnpm --filter
@demli/i18n test` · `npx expo export --platform android` (sonuçlar dal raporunda). **Cihazda /
emülatörde YAPILMADI**: denetim sonrası düzeltme turunda AVD `demli-debug` bu ortamda açılmadı
(emülatör açılışta sessizce kapanıyor), 2.1.0 dev-client APK'sı yok, ve çok kişilik durumlar (gelen
arama, paylaşım, birlikte izleme) ikinci bir hesap ister. Ekran görüntüsü kanıtı YOK. **Merge/yayın KAPISI:** 2.1.0
dev-client yapısında AVD `demli-debug` + gerçek telefon: sesli odaya katıl (iskelet → ızgara),
konuşurken mercan halka, sustur/sağırlaştır pembe yıkama, kamera önizleme (izin reddi dahil),
paylaşım kalitesi, ekran paylaşımı izle + tam ekran + film sesi sürgüsü, uzun basış → kişi başı
ses, ses çıkışı seçici; DM araması: giden çalma (nefes alan nokta), gelen arama ışığı + üç düğme,
mini çubuk giriş/çıkış, koltuk uzakta bandı, kişi ekle; birlikte izleme bant/sıra/seçici;
azaltılmış hareket açıkken nefes/parıltı/geçişlerin durduğu; TalkBack ile dok ve sürgüler;
kamerası kapalı karo ışığı (çeşitli tonlar), tam ekran paylaşımda KAMERALI PiP'te mercan halka + ad
şeridi + kapat düğmesi görünüyor mu (`zOrder` 1), sahne çubuğunda uzun basış ipucu ve art arda
basışlarda çubuğun açık kalması, TalkBack'te süre okunmaması, çevrimdışı "Kişi ekle" hata bloğu.

## 2026-10-20 — M16 Dalga 4: mobil kimlik + ayarlar ekranları (dal `feat/m16-mobile-profile`, YAYINLANMADI)

`feat/m16-mobile-kit` üstüne. Kitin native bağımlılıkları (Reanimated, gesture-handler)
yüzünden bu dal da 2.1.0 APK döngüsüne bağlı; tek başına OTA olarak gidemez.

| Özellik | Masaüstü/Web | Mobil | Not |
|---|---|---|---|
| Avatar / afiş KIRPMA editörü: daire / 8:3 maske hep dolu, odak noktasında pinch, sürükle, çift dokun 2×, yakınlaştırma sürgüsü + −/+, sıfırla, canlı önizleme, sunucu boyutunda dışa aktarım | ✅ `ImageCropDialog` (dal `feat/m16-ui-profile`) | ✅ `components/profile/ImageCropEditor` | Aynı geometri modeli ve aynı sayılar: maske 1:1 / 8:3, zoom 1–4, çıktı 512² / 1200×450 (`lib/image-crop.ts`, masaüstü `lib/image-crop.ts`'in worklet kopyası — her jest karesi UI iş parçacığında). Maske dışı karartma tek SVG (even-odd), dokunurken üçte-bir kılavuzu. Önizleme profil kartı + mesaj satırını AYNI paylaşılan değerlerden kare hızında çiziyor. Seçim → yönü normalize edilmiş çalışma kopyası (uzun kenar ≤2048), dışa aktarım sınır içine yuvarlanmış kırpma + yeniden kodlama (EXIF yok); PNG kapı aşarsa JPEG'e, sonra küçük kenara iner. TalkBack: sahne "ayarlanabilir" (yukarı/aşağı = zoom) + işlemler menüsünde kaydır/sıfırla. Sayısal geometri testi `lib/__tests__/image-crop.test.ts` (500 rastgele pinch/sürükle adımında maske dolu kalıyor). |
| Hareketli GIF afiş: hareketli kalsın ya da kırpıp sabitle | ✅ | ✅ | GIF 5 MB altındaysa önce seçim ekranı; "Hareketli kalsın" baytları olduğu gibi gönderir. GIF avatar ilk karesiyle kırpılır ve bunu söyler. |
| Profil düzenleyici = canlı kart (8:3 afiş, üstüne binen avatar, ad/bio yazdıkça) · görsel menüsü (yeni / bu değişikliği geri al / kaldır) | ✅ | ✅ | Kaldırma kaydette uygulanır (`avatarUrl:null` / `bannerUrl:null` — `UpdateMeInput.bannerUrl` client-core'a masaüstü dalıyla AYNI metinle eklendi). |
| Kaydet çubuğu: adım adım ilerleme ("Fotoğraf yükleniyor · 1/3"), kısmi hata dürüst, Tekrar dene yalnız kalanları gönderir | ✅ | ✅ | İlerleme İSTEK başına (fetch yükleme ilerlemesi vermiyor; bayt yüzdesi uydurulmadı). Hata iki ayrı durum (`lib/profile-save.ts`, testli): hiçbir adım inmediyse "Değişikliklerin kaydedilemedi · Hepsi bu ekranda duruyor"; bir kısmı indiyse adım adım "Fotoğraf kaydedildi · Profil bilgileri kaydedilemedi". Masaüstü `ProfileSettings` hâlâ tek "savePartial" cümlesi kullanıyor (aynı hata sınıfı, o dalın alanı). Kaydedilmemiş değişiklikle çıkış: Kaydet ve çık / Değişiklikleri at / Düzenlemeye devam sheet'i. |
| Profil kartı (kullanıcı modalı): 8:3 afiş + veil kontroller, sayfa halkalı avatar, özel durum balonu, iletişim karoları + "neden arayamazsın" satırı, Hakkında/Üyelik/Roller kartları, yüklenirken iskelet, hata + tekrar dene | ✅ | ✅ | Arkadaşlıktan çıkar / engelle / engeli kaldır tasarlı onay sheet'inde (meşgul + hata yerinde). |
| Avatar ışık kutusu: odak noktasında pinch, dokunulan yere çift dokun, sınırlı kaydırma, aşağı kaydır = kapat, açılış/kapanış hareketi | ✅ | ✅ | Reanimated + gesture-handler'a taşındı (eski PanResponder yerine). Arka plan dokunuşu görüntünün KARDEŞİ — ebeveyn olsaydı çift dokunuşun ilk dokunuşunda kapanıyordu. |
| Ayarlar: kimlik kartı + Koyu Masa ayar kartları (Hesap, Uygulama, Bildirimler, Mikrofon, Ses profili, Yankı engelleyici, Görüntü, Sesler, Titreşim, Hakkında) | ✅ | ✅ | Mantık değişmedi (Dalga 1 AEC onayı, ses profili, yankı engelleyici). Güncelleme denetimi sonucu tostla; çıkış onaylı ve nereye düşeceğini söylüyor. `ChipSelect` mercan yıkamalı haplar, `ToggleRow` kit onay kutusu, kulaklık adımı altın yıkamalı satır içi panel. |
| Özel durum (canlı önizleme), engellenenler, etkin oturumlar (bu cihaz üstte), hesap değiştir (görünür satır menüsü), hesap ekle (giriş/oluştur anahtarı) | ✅ | ✅ | Hepsinde iskelet / hata + tekrar dene / açıklamalı boş durum; yıkıcı adımlar sheet'te. Ayarlar kimlik kartı, özel durum önizlemesi ve kendi profil kartın SEÇTİĞİN durumu çiziyor (DND pembe, görünmez = başkalarının gördüğü gibi çevrimdışı; `lib/presence-view.ts`, testli) — önceden sabit "çevrimiçi" idi. |
| Sunucu / kanal / kategori / rol / üye rolleri / emoji / denetim kaydı yönetim ekranları | ✅ | ✅ | Ayar kartları, rol önizlemesi (hap + rol renginde ad), salt-okunur uyarısı, emoji kullanım çubuğu, denetim kaydında işlem tonlu rozetler, silmeler tehlike alanında sheet ile. Kanal ayarları / rol düzenleyici / üye rolleri yükleme HATASINDA "bulunamadı" değil hata + Tekrar dene gösteriyor; "bulunamadı" yalnız başarılı ama varlıksız yanıtta (`lib/load-state.ts`, testli). Üye rollerinde rol listesi kendi sorgusuna bağlı: yüklenirken iskelet, hatada tekrar dene, "henüz rol yok" yalnız boş başarılı yanıtta. |
| Sunucu oluştur/katıl, davet (kopyala → tost + titreşim), davetle katılma, grup sohbeti oluştur (2 adım) / ayrıntılar / davet bağlantıları | ✅ | ✅ | Grup daveti iki-dokunuşlu iptal deseni ve sahip-yalnız kuralı korundu (bağlama testleri yeşil). |
| Üye menüsü yıkıcı satırları | ✅ | ✅ | Onay artık AYNI sheet'in içinde (ikinci Modal Android'de sunulmuyor — mevcut kural). Onaylı işlem (at / yasakla / engelle / engeli kaldır / arkadaşlıktan çıkar / sesten at) YERİNDE çalışıyor: tehlike düğmesi döner, sheet istek sürerken kapanmayı reddeder, hata sheet içinde Banner olarak çıkar ve tekrar basmak yeniden dener; sheet yalnız başarıda kapanır (bağlama testi `user-menu-wiring`). Onaysız satırlar (istek, yok say, süre ladder'ı) önce kapanır, hatası tehlike tostu. Hesap değiştiricide kaldırma onayı menünün `onClosed`'unda açılıyor (aynı yarış). |
| Sunucu afişi yükleme + "kimler davet edebilir" | ✅ | ⛔ | Bu dalın dışında kaldı (satır 1049 #160 hâlâ açık): mobilde sunucu afişinin GÖSTERİLDİĞİ bir yüzey yok (kabuk ajanının alanı). |

**Doğrulama:** `pnpm --filter @demli/mobile typecheck` · `lint` · `test` (64 dosya, 694 test;
yeni 13 geometri testi dahil) · `pnpm --filter @demli/i18n test` (TR/EN parite) · `npx expo export --platform android`
(Hermes paketi; `--no-bytecode` paketinde kırpma yardımcılarının worklet olarak derlendiği
`__workletHash` ile görüldü). **Cihazda/emülatörde dokunma DENENMEDİ** (bu adımda APK/emülatör
yasaktı). **Merge/yayın KAPISI (2.1.0 dev-client, AVD `demli-debug` + gerçek telefon):**
kırpma editöründe pinch/sürükle/çift dokun/sürgü, maskenin hiç boş kenar göstermemesi,
dışa aktarılan avatarın önizlemeyle aynı kare olması (dikey/yatay/EXIF döndürülmüş foto),
GIF afiş iki yol, kaydet çubuğu adımları + uçak modunda kısmi hata ve tekrar dene,
kaydedilmemiş çıkış sheet'i (geri tuşu + jest), ışık kutusunda çift dokun + aşağı kaydır,
TalkBack ile kırpma sahnesi işlemleri, ayar anahtarları, onay sheet'lerinin klavye/geri
tuşuyla davranışı.

## 2026-10-20 — M16 Dalga 4 mobil satırları kodda doğrulandı (dal `feat/m16-final-fixes`)

Dalga 3 tablolarındaki "⏳ / ⛔ Dalga 4" mobil hücreleri birleşen mobil dallarına (kit, kabuk,
sohbet, ses, profil) göre tek tek KAYNAKTA doğrulandı — dalların kendi bölümlerindeki iddialara
güvenilmedi. 39 satır ✅ oldu (açılış ekranı kaynakta hazır, 2.1.0 APK ile çıkar); yarım kalanlar ◑ ve notunda eksik ne olduğu yazıyor; yapılmayanlar
(çökme ekranı, paylaşım karosunda CANLI hapı, sunucu/rol ayarlarında kaydedilmemiş çubuğu, canlı
doğrulama + sayaç, "başka yerden değişti") ⏳ kaldı. Bu doğrulama cihazda değil kodda yapıldı;
yukarıdaki dalların cihaz kapıları hâlâ açık. Kişi başı ses masaüstü %100 tavanı satırı en üstteki
tabloda ("Kişi başı ses / yayın sesi tavanı").

## 2026-10-20 — Push güvenilirliği (dal `fix/push-reliability`)

Saha bulgusu: uygulaması kapalı bir Android'e DM atıldı, bildirim düşmedi. Üretimde ticket/receipt
FCM'e kadar "ok" — yani hat Google'a ulaşıyor; hangi mesajın push ürettiği ise LOGDAN
ANLAŞILAMIYORDU ve receipt hiç okunmadığı için ölü token'lar (o cihazın 4 token'ından 2'si) hiç
budanmıyordu. Bu dal o körlüğü kapatır ve dokunma yönlendirmesini sunucunun gerçekten gönderdiği
veriye bağlar; cihazdaki asıl kök neden (OEM pil yönetimi / kanal / izin) için aşağıdaki loglar ve
izin şeridi şart.

| Özellik | Masaüstü | Mobil | Not |
|---|---|---|---|
| Push dispatch logu (tür, alıcı, kapı sonrası, token, ticket) | — | ✅ (sunucu) | `[push] dispatch {...}` — her notify/notifyAlways için TEK satır; içerik yok, token yalnız sha256/12 parmak izi (`pushTokenFingerprint`). api + realtime aynı servisi kullanır. |
| Expo receipt kontrolü + ölü token budama | — | ✅ (sunucu) | `packages/notifications/src/push-receipts.ts`: gönderimden ~15 dk sonra, bellek içi + sınırlı (10k), yeniden başlatmada kaybolur (bilinçli). `DeviceNotRegistered` budanır; InvalidCredentials/MessageTooBig/MessageRateExceeded/MismatchSenderId loglanır, budanmaz. |
| Push teslim özellikleri (kanal, öncelik, TTL, gruplama) | — | ✅ (sunucu) | Her push `messages-v2` (2.0.0 ve 2.1.0 ikisi de bu kanalı açıyor; zil de aynı HIGH kanalda — yeni kanal eski kurulumu "Diğer" kanalına düşürürdü), `priority: high`. TTL: mesaj 3 gün, arkadaşlık 7 gün, zil = zil süresi. DM artık konuşma başına tek bildirim (`dm:<id>` etiketi, son satır görünür) — kanal patlamasıyla aynı kural. Düz grup sohbeti push'u kendi ekranına (`groupChatId`) ve sohbet adıyla gider. |
| Bildirime dokununca doğru yer | — | ✅ (OTA) | Saf yönlendirici `apps/mobile/src/push/notification-target.ts` (`parseNotificationTarget` → `notificationHref` / `callRingDecision`). DM → o DM (akış + karşı taraf + isim hazır); kanal/mention → o kanal; grup sohbeti → grup sohbeti; zil → hâlâ çalıyorsa gelen-arama katmanı (soğuk açılışta `resyncActiveCall` ile), bittiyse DM; cevapsız arama → DM, rota yoksa Son aramalar. Sunucu verisi → mobil rota sözleşmesi `packages/notifications/src/__tests__/mobile-tap-contract.test.ts` ile kilitli. Mesaja kaydırma: push'un mesajı en yenisi, sohbet zaten orada açılıyor (ayrıca iş yapılmadı). |
| Bildirim izni kapalı şeridi + ayarlara git | — | ✅ (OTA) | Ana sayfa şeridi (`NotificationPermissionBanner`) izin kesin "hayır" iken; tek eylem: istenebiliyorsa "İzin ver", değilse "Ayarları aç". Oturum boyunca kapatılabilir. Ayarlar satırıyla aynı mağaza (`push/permission-store.ts`). |
| Push token'ı her açılışta / ön plana dönüşte / izin sonrası yeniden kayıt | — | ✅ (OTA) | Eskiden oturum başına bir kez; Ayarlar'dan izin veren kullanıcının token'ı bir sonraki girişe kadar sunucuya gitmiyordu. Ön plan yenilemesi 60 sn kısmalı ve izin penceresi AÇMAZ. |

⚠️ Cihaz doğrulaması AÇIK (founder kuralı — emülatör/uygulama bu dalda çalıştırılmadı). Başka
cihazda cevaplanan zilin SESSİZ `call_ended` push'unu istemcide kapatmak hâlâ yok (üstteki 🚧 satır).
