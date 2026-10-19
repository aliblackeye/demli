import { useState } from "react";
import { RadioGroup, RadioItem } from "@demli/ui";
import {
  applyLanguagePreference,
  getLanguagePreference,
  useAppTranslation,
  type LanguagePreference,
} from "../lib/i18n";
import { SettingsBlock, SettingsGroup } from "./settings-kit";

/**
 * Language settings section. Three choices — System default / Türkçe / English —
 * applied live via `setLocale` and persisted. "System default" clears the stored
 * choice so the app follows the OS language (see lib/i18n).
 */
export function LanguageSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [pref, setPref] = useState<LanguagePreference>(() => getLanguagePreference());

  // Each language names itself in its own language (and is marked up as such,
  // so a screen reader pronounces "English" in English inside a Turkish UI).
  const options: { value: LanguagePreference; label: string; lang?: string }[] = [
    { value: "system", label: t("desktop:settings.language.system") },
    { value: "tr", label: t("language.tr"), lang: "tr" },
    { value: "en", label: t("language.en"), lang: "en" },
  ];

  const choose = (next: LanguagePreference): void => {
    setPref(next);
    void applyLanguagePreference(i18n, next);
  };

  return (
    <div className="space-y-3">
      <SettingsGroup title={t("desktop:settings.nav.language")} description={t("desktop:settings.language.description")}>
        <SettingsBlock className="p-1.5">
          <RadioGroup
            value={pref}
            onValueChange={(next) => choose(next as LanguagePreference)}
            aria-label={t("desktop:settings.nav.language")}
          >
            {options.map((option) => (
              <RadioItem key={option.value} value={option.value} label={option.label} lang={option.lang} />
            ))}
          </RadioGroup>
        </SettingsBlock>
      </SettingsGroup>
    </div>
  );
}
