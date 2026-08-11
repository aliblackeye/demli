import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Appzen — AI Telehealth App for Smarter Health",
  description: "Appzen — AI Telehealth App for Smarter Health",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Fontlar referansın birebir woff2 dosyalarından self-host (fonts.css) */}
      <body>{children}</body>
    </html>
  );
}
