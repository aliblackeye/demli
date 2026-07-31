import { useTranslation } from "@demli/i18n";
import demliMark from "../assets/demli-mark-256.png";
import { APP_URL } from "../env";
import { LanguagePicker } from "./LanguagePicker";

/**
 * Sticky, single-line header: brand left, language + the one primary action
 * right. Height is ~68px (mark 40px + 14px of block padding), inside the 80px
 * cap a nav has before it starts eating the hero.
 *
 * The skip link is the first focusable element on the page and is visually
 * hidden until it takes focus — keyboard users should not have to tab through
 * the language toggle to reach the content.
 *
 * The mark is `alt=""`: the wordmark next to it already says "Demli", and a
 * screen reader announcing the brand twice is noise, not information.
 */
export function SiteHeader(): JSX.Element {
  const { t } = useTranslation("landing");

  return (
    <header className="site-header">
      <a className="skip-link" href="#main">
        {t("nav.skip")}
      </a>
      <div className="shell site-header__inner">
        <span className="brand">
          <img className="brand__mark" src={demliMark} width={40} height={40} alt="" />
          <span className="brand__name">Demli</span>
        </span>
        <div className="header-actions">
          <LanguagePicker />
          <a className="btn btn--accent btn--sm" href={APP_URL}>
            {t("cta.openApp")}
          </a>
        </div>
      </div>
    </header>
  );
}
