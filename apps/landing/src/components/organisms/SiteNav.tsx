"use client";

import Image from "next/image";
import { PillLink } from "../atoms/PillLink";

/**
 * [Section] Nav — authored CSS (audit2.txt):
 * nav: fixed z6, padding 24 0 0 (dt) / 24 24 0 (tb) / 16 16 0 (mobil).
 * Navbar konteyner: 544px (dt) / flex-1 max-520 (tb) / %100 (mobil).
 * Navigation Bar: gap 36, pad 12 12 12 24, radius 16, bg #171717b8,
 * blur(10px). Logo: 44 (dt) / 35 (tb) / 32 (mobil). Tabs: pr 16.
 */
export function SiteNav() {
  return (
    <nav className="fixed inset-x-0 top-0 z-[6] flex items-center justify-center px-4 pt-4 tb:px-6 tb:pt-6 dt:px-0">
      <div className="relative w-full tb:max-w-[520px] dt:w-[544px] dt:max-w-none">
        <nav className="flex flex-col items-center justify-center rounded-[16px] backdrop-blur-[10px]">
          <div className="relative z-10 flex w-full items-center justify-center gap-9 rounded-[16px] bg-[rgba(23,23,23,0.72)] py-3 pl-6 pr-3">
            <div className="flex w-full items-center justify-between">
              <div className="flex flex-1 items-center justify-start gap-9">
                <a
                  href="./"
                  className="flex h-8 w-8 items-center justify-center tb:h-[35px] tb:w-[35px] dt:h-11 dt:w-11"
                >
                  <Image
                    src="/images/logo.png"
                    alt="Appzen"
                    width={44}
                    height={44}
                    className="h-full w-full object-contain object-left"
                  />
                </a>
                {/* Mobilde sekmeler yok (referansta hamburger da yok) */}
                <ul className="hidden flex-1 items-center justify-end pr-4 tb:flex">
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
