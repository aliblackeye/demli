import { SUPPORTED_LOCALES, useTranslation, type Locale } from "@demli/i18n";
import { changeLocale } from "../i18n";

/**
 * TR / EN segmented toggle. The initial value comes from the shared detection
 * chain (persisted choice → browser language → "en"); picking one here persists
 * it to localStorage through the i18n instance's languageChanged hook.
 *
 * `aria-pressed` rather than a radio group: two mutually exclusive toggles are
 * simpler to operate with a keyboard and need no fieldset/label plumbing.
 */
export function LanguagePicker(): JSX.Element {
  const { t, i18n } = useTranslation("landing");
  const active = i18n.resolvedLanguage ?? i18n.language;

  const select = (locale: Locale): void => {
    if (locale === active) return;
    void changeLocale(i18n, locale);
  };

  return (
    <div className="lang" role="group" aria-label={t("nav.language")}>
      {SUPPORTED_LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          className="lang__btn"
          aria-pressed={locale === active}
          onClick={() => select(locale)}
        >
          {locale}
        </button>
      ))}
    </div>
  );
}
