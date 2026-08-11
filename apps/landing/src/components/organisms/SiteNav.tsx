"use client";

import Image from "next/image";
import { PillLink } from "../atoms/PillLink";

/**
 * [Section] Nav — ölçülen yapı (1280px):
 * fixed, tam genişlik, padding 24px 24px 0, içerik ortalanır.
 * Hap çubuk: 520×59, bg rgba(23,23,23,0.72) + backdrop blur(10px),
 * radius 16, padding 12px 12px 12px 24px, iç flex gap 36.
 * Sol: logo 35×35 + sekmeler (Features, Pricing); sağ: Download App.
 */
export function SiteNav() {
  return (
    <nav className="fixed inset-x-0 top-0 z-[6] flex items-center justify-center px-4 pt-4 tb:px-6 tb:pt-6">
      <div className="relative w-full tb:w-auto">
        <nav className="flex flex-col items-center justify-center rounded-[16px] backdrop-blur-[10px]">
          <div className="relative z-10 flex w-full items-center justify-center gap-9 rounded-[16px] bg-[rgba(23,23,23,0.72)] px-4 py-3 tb:w-auto tb:pl-6 tb:pr-3">
            <div className="flex w-full items-center justify-between tb:w-[484px]">
              <div className="flex items-center justify-start gap-9">
                <a
                  href="./"
                  className="flex h-8 w-8 items-center justify-center gap-[10px] tb:h-[35px] tb:w-[35px]"
                >
                  <Image
                    src="/images/logo.png"
                    alt="Appzen"
                    width={35}
                    height={35}
                    className="h-8 w-8 object-contain object-left tb:h-[35px] tb:w-[35px]"
                  />
                </a>
                {/* Mobilde sekmeler yok (referans: hamburger da yok) */}
                <ul className="hidden items-center justify-end pr-4 tb:flex">
                  <li>
                    <PillLink href="./#features" label="Features" />
                  </li>
                  <li>
                    <PillLink href="./#pricing" label="Pricing" />
                  </li>
                </ul>
              </div>
              <PillLink href="./#download" label="Download App" variant="secondary" />
            </div>
          </div>
        </nav>
      </div>
    </nav>
  );
}
