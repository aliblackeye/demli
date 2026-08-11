import { SiteNav } from "../organisms/SiteNav";
import { Hero } from "../organisms/Hero";

/**
 * Ana sayfa şablonu — bölümler referans sırasıyla eklenir:
 * Nav, Hero, Features, Reviews, Pricing, Footer (+ yüzen CTA, blur katmanları).
 */
export function HomeTemplate() {
  return (
    <div className="relative bg-base">
      <SiteNav />
      <main className="relative">
        <Hero />
      </main>
    </div>
  );
}
