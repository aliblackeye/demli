import { useTranslation } from "@demli/i18n";
import { APP_URL, DOWNLOAD_ANDROID_URL, DOWNLOAD_WINDOWS_URL } from "../env";
import { useRevealOnce } from "../lib/motion";

/**
 * Honest platform matrix (CLAUDE.md §35 — no dead buttons):
 *
 *  - Windows / Android really ship. Their hrefs are stable getdemli.com
 *    endpoints that devops redirects to the real artifacts (the electron-updater
 *    feed file, and the fixed APK link), so a new release never needs this page
 *    rebuilt. Verified live: both answer 302 to api.getdemli.com/dl/...
 *  - macOS and iOS are a sentence, NOT a tile with a greyed-out button. A card
 *    that looks like the two working ones but cannot be clicked is a dead button
 *    wearing a disguise; a plain line says the same thing without the tease.
 *  - Linux is covered by the browser-client line, which works today.
 *
 * The intro column and the action list are deliberately a different layout
 * family from the bento above it: nothing on this page repeats a shape.
 *
 * Two reveal groups rather than one: the intro column and the action list sit
 * side by side above 56rem, and revealing them as a single block would make the
 * right column wait on the left one for no reason. Each arrives on its own.
 */
export function Downloads(): JSX.Element {
  const { t } = useTranslation("landing");
  const introRef = useRevealOnce<HTMLDivElement>();
  const listRef = useRevealOnce<HTMLUListElement>();

  return (
    <section className="section section--band" id="download">
      <div className="shell download">
        <div className="download__intro reveal-group" ref={introRef}>
          <h2 className="section__title">{t("download.title")}</h2>
          <p className="section__lead">{t("download.lead")}</p>
          <p className="download__soon">{t("download.soon")}</p>
        </div>

        <ul className="download__list reveal-group" ref={listRef}>
          <li>
            {/* The whole row is the link, so the click target is the row and not
                just the label sitting at its right edge. */}
            <a className="plat" href={DOWNLOAD_WINDOWS_URL}>
              <span className="plat__text">
                <span className="plat__name">{t("download.windows.name")}</span>
                <span className="plat__note">{t("download.windows.note")}</span>
              </span>
              <span className="plat__action">{t("download.windows.action")}</span>
            </a>
          </li>
          <li>
            <a className="plat" href={DOWNLOAD_ANDROID_URL}>
              <span className="plat__text">
                <span className="plat__name">{t("download.android.name")}</span>
                <span className="plat__note">{t("download.android.note")}</span>
              </span>
              <span className="plat__action">{t("download.android.action")}</span>
            </a>
          </li>
          <li className="download__browser">
            <span>{t("download.browserNote")}</span>{" "}
            <a className="text-link" href={APP_URL}>
              {t("cta.openApp")}
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}
