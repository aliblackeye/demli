import { LenisProvider } from "../atoms/LenisProvider";
import { SiteNav } from "../organisms/SiteNav";
import { Hero } from "../organisms/Hero";
import { Features } from "../organisms/Features";
import { Reviews } from "../organisms/Reviews";
import { Pricing } from "../organisms/Pricing";
import { SiteFooter } from "../organisms/SiteFooter";
import { FloatingCta } from "../organisms/FloatingCta";
import { ProgressiveBlur } from "../atoms/ProgressiveBlur";

/**
 * Ana sayfa şablonu — bölümler referans sırasıyla eklenir:
 * Nav, Hero, Features, Reviews, Pricing, Footer (+ yüzen CTA, blur katmanları).
 */
export function HomeTemplate() {
  return (
    <LenisProvider>
    {/* authored: sayfa zemini body'nin SAF SİYAHI — sarmalayıcı boyamaz */}
    <div className="relative">
      <SiteNav />
      <main className="relative">
        <Hero />
        <Features />
        <Reviews />
        <Pricing />
      </main>
      <SiteFooter />
      <FloatingCta />
      <ProgressiveBlur position="top" height={120} />
      <ProgressiveBlur position="bottom" height={180} />
    </div>
    </LenisProvider>
  );
}
