import { I18nProvider } from "../atoms/I18nProvider";
import { LenisProvider } from "../atoms/LenisProvider";
import { SiteNav } from "../organisms/SiteNav";
import { Hero } from "../organisms/Hero";
import { Features } from "../organisms/Features";
import { Reviews } from "../organisms/Reviews";
import { SiteFooter } from "../organisms/SiteFooter";
import { FloatingCta } from "../organisms/FloatingCta";
import { ProgressiveBlur } from "../atoms/ProgressiveBlur";

/**
 * Ana sayfa şablonu — bölüm sırası: Nav, Hero, Features, Reviews, Footer
 * (+ yüzen CTA, blur katmanları). Founder kararı: Pricing bölümü yok —
 * ücretsizlik hero hapında ve metinlerde anlatılır.
 */
export function HomeTemplate() {
  return (
    <I18nProvider>
      <LenisProvider>
        {/* authored: sayfa zemini body'nin SAF SİYAHI — sarmalayıcı boyamaz */}
        <div className="relative">
          <SiteNav />
          <main className="relative">
            <Hero />
            <Features />
            <Reviews />
          </main>
          <SiteFooter />
          <FloatingCta />
          <ProgressiveBlur position="top" height={120} />
          <ProgressiveBlur position="bottom" height={180} />
        </div>
      </LenisProvider>
    </I18nProvider>
  );
}
