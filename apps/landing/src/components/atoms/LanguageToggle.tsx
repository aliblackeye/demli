"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@demli/i18n";
import { changeLocale } from "../../lib/i18n";

const DILLER = [
  { kod: "tr" as const, etiket: "Türkçe", kisa: "TR" },
  { kod: "en" as const, etiket: "English", kisa: "EN" },
];

/**
 * Dil seçici — nav hapıyla aynı dilde küçük bir dropdown: mevcut dil +
 * ok; menü koyu yüzeyde iki seçenek. Dışarı tıklama ve Escape kapatır.
 */
export function LanguageToggle() {
  const { i18n } = useTranslation("landing");
  const [acik, setAcik] = useState(false);
  const kok = useRef<HTMLDivElement | null>(null);
  const aktif = i18n.language.startsWith("tr") ? "tr" : "en";

  useEffect(() => {
    if (!acik) return;
    const tikla = (e: MouseEvent) => {
      if (kok.current && !kok.current.contains(e.target as Node)) setAcik(false);
    };
    const tus = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcik(false);
    };
    document.addEventListener("mousedown", tikla);
    document.addEventListener("keydown", tus);
    return () => {
      document.removeEventListener("mousedown", tikla);
      document.removeEventListener("keydown", tus);
    };
  }, [acik]);

  return (
    <div ref={kok} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={acik}
        onClick={() => setAcik((a) => !a)}
        className="flex items-center gap-1 rounded-[10px] px-2 py-1.5 text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] text-[#e5e5e5] transition-colors hover:bg-surface-2"
      >
        {DILLER.find((d) => d.kod === aktif)?.kisa}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
          className={"transition-transform duration-200 " + (acik ? "rotate-180" : "")}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="#a3a3a3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {acik ? (
        <ul
          role="listbox"
          className="absolute right-0 top-[calc(100%+8px)] z-20 min-w-[132px] rounded-[12px] bg-[rgba(23,23,23,0.92)] p-1 backdrop-blur-[10px] nav-pill-mobile-shadow"
        >
          {DILLER.map((d) => (
            <li key={d.kod} role="option" aria-selected={aktif === d.kod}>
              <button
                type="button"
                onClick={() => {
                  setAcik(false);
                  void changeLocale(i18n, d.kod);
                }}
                className={
                  "flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-[14px] font-medium leading-[16.8px] tracking-[-0.28px] transition-colors " +
                  (aktif === d.kod
                    ? "text-[#e5e5e5]"
                    : "text-text-secondary hover:bg-surface-2 hover:text-[#e5e5e5]")
                }
              >
                {d.etiket}
                {aktif === d.kod ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path d="m3 7.5 2.5 2.5L11 4.5" stroke="#ff8464" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
