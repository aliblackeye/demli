# Public'e Açılmadan Önce: Sır Süpürme — Ne Öğrendik

**Kapanış tarihi:** 2026-07-31 · **Durum:** kapandı, depo public'e açıldı.

Bu belge bir kontrol listesi değil, bir **ders kaydı**. Bir depoyu public yapmadan önce
yapılan denetimin ne bulduğunu ve — daha önemlisi — **hangi araçların temiz dediği hâlde
temiz olmadığını** anlatır. Aynı hataya düşecek bir sonraki kişi için burada.

> Bu belge bilerek **operasyonel detay içermez**: dosya adı, commit SHA'sı, hesap adı yok.
> İlk hâli hepsini içeriyordu ve public bir depoda o, bir hazine haritasıdır — "şu dosyada
> parola okunuyor" cümlesi, temizlik yapılmış olsa bile fork'lara ve arşivlere bakmaya
> davettir. Bulguların kendisi kapatıldı; kalan değer yöntemde.

---

## 1. Asıl bulgu: grep bir PNG okuyamaz

Denetimin bulduğu tek gerçek sızıntı bir **ekran görüntüsündeydi**. Bir ajan, adb ile
sürülen bir arayüz probe'unda kullanıcı adını ve parolayı **aynı alana** yazmıştı; maskeli
parola kutusu boş kalmış, kullanıcı adı kutusu sırrı düz metin basmıştı. İkinci bir karede
canlı bir davet kodu vardı.

Bunu hiçbir desen taraması bulamazdı. Bulan şey **görselleri tek tek açıp bakmak** oldu.

Sonuç: sızan kimlik bilgisinin sahibi hesap üretimde donduruldu (kurtarma penceresinin
**dışında** — pencere içinde dondurmak işe yaramazdı, parolayı bilen yeniden aktive
ederdi), oturumları silindi, davet iptal edildi.

**Kural:** bir depoda commit'lenmiş her görsel, desen taramasının kör noktasıdır. Ya hepsini
gözle aç, ya da o dizini hiç yayınlama. İkincisi seçildi: ajan raporları dizini geçmişten
tamamen çıkarıldı (~1650 commit → ~1550, 100+ görsel).

---

## 2. Yeşil yanan üç bozuk kapı

Bu turun asıl dersi burada. Üç ayrı sefer bir kapı "temiz" dedi ve üçünde de yanılıyordu.
Üçü de aynı aileden: **kapı, korumak istediği şeye bakmıyordu.**

### 2.1 Süpürücü kendi adına takıldı

Sır taramasının ilk adımı "adı secret'a benzeyen izlenen dosya var mı" diye bakıyordu — ve
süpürücünün **kendi dosya adında** "secret" geçtiği için kendini yakalıyordu. Kapı kalıcı
olarak kırmızıydı.

Hep kırmızı yanan bir kapı, okunmayan kapıdır. Gerçek bir isabet, zaten var olan gürültünün
içinde tek bir satır olurdu. Düzeltme: hariç tutmayı **role göre** yap (testler, denetim
belgesi), asla **uzantıya göre** — bir ara "kaynak dosyalar secret olmaz" diye uzantı
filtresi denendi ve `config/secrets.json` gibi gerçek bir sır deposunu sessizce geçirdi.

### 2.2 Süpürücü çalışma ağacını okuyordu, geçmişi değil

Ekran görüntüsü adımı `git ls-files` kullanıyordu — yani **bugünkü indeksi**. Sızdıran
görselleri git'ten çıkardığım gün adım "temiz" demeye başladı. Risk hiç değişmemişti:
public bir deponun bir kez tuttuğu her blob bir `git show` uzaklıktadır.

**Kural:** geçmişi hedefleyen bir kontrol `git log --all` / `git rev-list --all` okumalı.
Çalışma ağacına bakan bir kontrol, silme işlemini düzeltme sanır.

### 2.3 `git filter-repo` çalıştı, veri hâlâ oradaydı

Yeniden yazımdan sonra doğrulama adımı **89 görselin hâlâ ulaşılabilir** olduğunu söyledi.
Sebep: bir editör aracının bıraktığı yerel `refs/` girdisi o nesneleri tutuyordu ve
filter-repo onu `Unexpected object of type tree, skipping` deyip atlamıştı — uyarı akıp
gitmişti.

**Kural:** filter-repo'nun çıktısına değil, kendi doğrulamana güven. Yeniden yazımdan sonra
`git for-each-ref` ile **tüm ref namespace'lerini** say, `reflog expire` + `gc --prune=now`
çalıştır, sonra `git rev-list --all --objects` ile hedefi tekrar ara.

---

## 3. Uzaktaki kopya: yerel temizlik yetmez

En son ve en sinsi bulgu. Yerel geçmiş tamamen temizlendikten, force-push yapıldıktan ve
her kontrol yeşil olduktan **sonra**, GitHub hâlâ eski geçmişin tamamını sunuyordu.

Sebep: kapatılmış bir pull request'in `refs/pull/<n>/head` ref'i. Bu ref'i **depo sahibi
silemez**; force-push onu etkilemez; ve yerel hiçbir tarama onu göremez, çünkü `refs/pull/*`
klonlanmaz. `git ls-remote` ile görünüyordu, `git fetch` ile de indiriliyordu: yüzlerce
rewrite-öncesi commit.

**Kural:** yeniden yazılmış bir geçmişi push ettikten sonra `git ls-remote origin` çalıştır
ve **beklemediğin her ref'i** sorgula. Bir PR ref'i varsa, tek kesin çözüm depoyu silip
yeniden oluşturmak ve yalnız yeni geçmişi push etmektir. (Sır taraması artık bu adımı
içeriyor — bkz. `scripts/scan-secrets.sh`.)

Buna ek olarak: force-push sonrası eski nesneler bir süre "unreachable" olarak sunucuda
kalabilir ve SHA bilen biri erişebilir. Depoyu yeniden oluşturmak bunu da bitirir.

---

## 4. Temiz çıkanlar (doğrulanmış negatifler)

Denetim şunları aradı ve **bulamadı** — kaydı burada, çünkü "bakılmadı" ile "bakıldı, yok"
arasındaki fark bir sonraki denetim için değerlidir:

Geçmişte izlenen `.env`/keystore/anahtar dosyası yok (yalnız `*.example`) · üretim sunucusunun
IP adresi geçmişe hiç girmemiş · commit mesajlarında sır veya kişisel veri yok · yüksek
entropili dize taraması yalnız kod tanımlayıcıları döndürdü · `.gitignore` canlı sır
dosyalarının hepsini gerçekten kapsıyor (tek tek `git check-ignore -v` ile denendi) ·
izlenip sonra ignore'lanmış dosya yok · dokümanlardaki davet linkleri örnek değerler.

Kişisel e-posta adresleri ayrı bir yeniden yazımla commit meta verisinden çıkarıldı ve
GitHub'ın noreply adresine çevrildi (katkılar hesaba bağlı kalsın diye sayısal-id biçimi).

---

## 5. Yöntem — tekrarlanabilir hâli

Bir sonraki sefer sırasıyla:

1. `bash scripts/scan-secrets.sh` — geçmişteki yolları, içerik desenlerini, IP'leri,
   `.gitignore` deliklerini ve **uzak ref'leri** tarar. Çıktısındaki "review aid" adımlarını
   okumadan geçme; ikili dosya sayısı sıfır değilse iş bitmemiştir.
2. Görselleri **gözle** aç. İstisnasız.
3. Gerekiyorsa `bash scripts/scrub-history.sh` — yedek alır, yeniden yazar, doğrular ve
   push etmeden durur.
4. Yeniden yazımdan sonra: tüm ref namespace'lerini say, `gc --prune=now`, hedefi tekrar ara.
5. Push'tan sonra `git ls-remote origin` — beklenmeyen ref var mı?
6. Depo public olduktan sonra `git config user.email`'in kişisel adrese dönmediğini
   doğrula, yoksa bir sonraki commit onu geri getirir.
