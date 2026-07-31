import { useTranslation } from "@demli/i18n";
import demliMark from "../assets/demli-mark-256.png";
import { APP_URL, GITHUB_URL } from "../env";

/**
 * Brand + the one honest status sentence on the left, navigation on the right.
 *
 * The "actively being built" line lives HERE rather than as a pill above the
 * hero headline: it is true and worth saying, but a version/early-access badge
 * is the first thing that makes a launch page look templated, and it is not
 * what a visitor needs before they know what the product is.
 *
 * The GitHub link renders only when VITE_GITHUB_URL is set. The repository is
 * private today, so a "view the source" link would 404 — it appears the day the
 * repo goes public and the env var is filled in, with no code change.
 */
export function SiteFooter(): JSX.Element {
  const { t } = useTranslation("landing");
  // Computed at render, not baked at build: a static page can sit on a CDN for
  // a year and must not show a stale copyright year.
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="shell site-footer__inner">
        <div className="site-footer__brand">
          <span className="brand">
            <img className="brand__mark" src={demliMark} width={28} height={28} alt="" />
            <span className="brand__name brand__name--sm">Demli</span>
          </span>
          <p className="site-footer__note">{t("footer.note")}</p>
        </div>

        <div className="site-footer__end">
          <nav className="site-footer__links">
            <a className="site-footer__link" href={APP_URL}>
              {t("cta.openApp")}
            </a>
            <a className="site-footer__link" href="#download">
              {t("cta.download")}
            </a>
            {GITHUB_URL ? (
              <a
                className="site-footer__link"
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
              >
                {t("openSource.action")}
              </a>
            ) : null}
          </nav>
          <p className="site-footer__rights">{t("footer.rights", { year })}</p>
        </div>
      </div>
    </footer>
  );
}
