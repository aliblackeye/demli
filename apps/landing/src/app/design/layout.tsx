"use client";

/**
 * Koyu Masa design system — sayfalandırılmış kabuk: sol menü + içerik.
 * Sayfalar: Genel bakış / Temeller / Atomlar / Moleküller / Organizmalar /
 * Ekranlar. Menü sistemin kendi reçetesiyle (panel + seçili satır).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Onest } from "next/font/google";
import { T } from "@/design/tokens";

const onest = Onest({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"] });

const SAYFALAR = [
  ["/design", "Genel bakış"],
  ["/design/temeller", "Temeller"],
  ["/design/atomlar", "Atomlar"],
  ["/design/molekuller", "Moleküller"],
  ["/design/organizmalar", "Organizmalar"],
  ["/design/ekranlar", "Ekranlar"],
] as const;

export default function DesignLayout({ children }: { children: React.ReactNode }) {
  const yol = usePathname();
  return (
    <div className="min-h-screen bg-black">
      <div className="mx-auto flex w-full max-w-[1280px] gap-2 px-4 py-4 tb:px-6">
        {/* Sol menü — sistemin panel reçetesi */}
        <aside className="sticky top-4 hidden h-[calc(100vh-32px)] w-56 shrink-0 flex-col rounded-[24px] bg-base p-3 tb:flex">
          <Link href="/design" className={onest.className + " px-3 pb-1 pt-2 text-[18px] font-semibold leading-[1.15] text-white"}>
            Koyu Masa<span style={{ color: T.accent }}>.</span>
          </Link>
          <p className="px-3 pb-4 text-[12px] font-medium leading-[16px] text-text-dim">design system v1 · onay turu</p>
          <nav className="flex flex-col gap-0.5">
            {SAYFALAR.map(([href, ad]) => {
              const aktif = yol === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center rounded-[12px] px-3 py-2.5 transition-colors duration-200"
                  style={{ background: aktif ? T.accentSoft : "transparent" }}
                  onMouseEnter={(e) => { if (!aktif) e.currentTarget.style.background = "#171717"; }}
                  onMouseLeave={(e) => { if (!aktif) e.currentTarget.style.background = "transparent"; }}
                >
                  <span className="text-[15px] font-medium leading-[19.6px] tracking-[-0.28px]" style={{ color: aktif ? T.accentStrong : "#a3a3a3" }}>{ad}</span>
                </Link>
              );
            })}
          </nav>
          <p className="mt-auto px-3 pb-1 text-[11px] leading-[15px] text-[#404040]">
            src/design/ — tokens · atoms · molecules · organisms · ekranlar
          </p>
        </aside>

        {/* Mobil üst menü */}
        <div className="fixed inset-x-0 top-0 z-20 flex gap-1 overflow-x-auto border-b border-white/[0.06] bg-black/90 px-3 py-2 backdrop-blur-[10px] tb:hidden">
          {SAYFALAR.map(([href, ad]) => {
            const aktif = yol === href;
            return (
              <Link key={href} href={href} className="shrink-0 rounded-[10px] px-3 py-1.5 text-[13px] font-medium leading-[17px]" style={{ background: aktif ? T.accentSoft : "transparent", color: aktif ? T.accentStrong : "#a3a3a3" }}>
                {ad}
              </Link>
            );
          })}
        </div>

        <main className="min-w-0 flex-1 rounded-[24px] bg-[#050505] px-6 pb-24 pt-14 tb:px-10 tb:pt-8">{children}</main>
      </div>
    </div>
  );
}
