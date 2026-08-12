import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

/** Onaylı meta (brand-system §7): TR birincil; dil değişimi istemci tarafında. */
export const metadata: Metadata = {
  title: "Demli — arkadaş grubunun sesli evi",
  description:
    "Sesli odalar, ekran paylaşımı, görüntülü arama ve sohbet — hepsi açık, ücretli kademe yok. Reklam yok, algoritma yok, davetle girilir.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      {/* Fontlar referansın birebir woff2 dosyalarından self-host (fonts.css) */}
      <body>{children}</body>
    </html>
  );
}
