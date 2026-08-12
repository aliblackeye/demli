"use client";

import { useTranslation } from "@demli/i18n";
import { changeLocale } from "../../lib/i18n";

/**
 * TR/EN geçişi — nav hapının diliyle aynı biçimde iki küçük sekme.
 * Aktif dil açık renkte; tıklanan dil kalıcı tercihe yazılır.
 */
export function LanguageToggle() {
  const { i18n } = useTranslation("landing");
  const aktif = i18n.language.startsWith("tr") ? "tr" : "en";
  const sinif = (dil: string) =>
    "px-1 text-[14px] font-medium leading-[19.6px] tracking-[-0.28px] transition-colors " +
    (aktif === dil ? "text-[#e5e5e5]" : "text-text-dim hover:text-text-secondary");
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" className={sinif("tr")} onClick={() => void changeLocale(i18n, "tr")}>
        TR
      </button>
      <span className="text-text-dim">/</span>
      <button type="button" className={sinif("en")} onClick={() => void changeLocale(i18n, "en")}>
        EN
      </button>
    </div>
  );
}
