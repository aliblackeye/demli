import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@demli/ui";
import {
  applyLanguagePreference,
  getLanguagePreference,
  useAppTranslation,
  type LanguagePreference,
} from "../lib/i18n";

/**
 * Language settings section. Three choices — System default / Türkçe / English —
 * applied live via `setLocale` and persisted. "System default" clears the stored
 * choice so the app follows the OS language (see lib/i18n).
 */
export function LanguageSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [pref, setPref] = useState<LanguagePreference>(() => getLanguagePreference());

  const options: { value: LanguagePreference; label: string }[] = [
    { value: "system", label: t("desktop:settings.language.system") },
    { value: "tr", label: t("language.tr") },
    { value: "en", label: t("language.en") },
  ];

  const choose = (next: LanguagePreference): void => {
    setPref(next);
    void applyLanguagePreference(i18n, next);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-fg-faint">
        {t("desktop:settings.language.description")}
      </p>
      <div role="radiogroup" aria-label={t("desktop:settings.nav.language")} className="space-y-2">
        {options.map((option) => {
          const active = pref === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(option.value)}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded-lg border px-4 py-3 text-left text-sm transition-colors motion-instant",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                active
                  ? "border-accent/60 bg-app text-fg ring-1 ring-accent/40"
                  : "border-stroke bg-surface text-fg-muted hover:bg-raised hover:text-fg",
              )}
            >
              <span className="font-medium">{option.label}</span>
              {active && <Check className="size-4 text-accent" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
