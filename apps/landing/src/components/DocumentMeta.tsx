import { useEffect } from "react";
import { useTranslation } from "@demli/i18n";

/**
 * Keeps <title>, the meta description and <html lang> in step with the active
 * locale. index.html ships Turkish defaults for crawlers and the pre-hydration
 * paint; this corrects them once the visitor's language is resolved.
 */
export function DocumentMeta(): null {
  const { t, i18n } = useTranslation("landing");
  const locale = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    document.title = t("meta.title");
    document.documentElement.lang = locale;

    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = t("meta.description");
  }, [t, locale]);

  return null;
}
