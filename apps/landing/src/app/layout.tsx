import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Appzen — AI Telehealth App for Smarter Health",
  description: "Appzen — AI Telehealth App for Smarter Health",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Referansla aynı aileler: Inter (gövde) + Stack Sans Headline (başlık) */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Stack+Sans+Headline:wght@400..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
