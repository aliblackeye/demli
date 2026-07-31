import { useTranslation } from "@demli/i18n";
import demliMark from "../assets/demli-mark-512.png";
import { APP_URL } from "../env";
import { useLiveWhileVisible } from "../lib/motion";

/**
 * Asymmetric split, not a centred stack: copy on the left, the brand mark as the
 * visual anchor on the right. Three text elements only (headline, lead, actions)
 * so the whole pitch and both buttons sit inside the first viewport.
 *
 * The mark is imported at 512px because it renders up to ~272 CSS px here and a
 * 2x display would visibly soften the 256px header asset. It is `alt=""` and the
 * whole visual column is `aria-hidden`: the rings and the bloom are decoration,
 * and the brand name is already in the header and the h1's sentence.
 *
 * `fetchPriority="high"` — this is the page's LCP element on desktop, and it is
 * the only image above the fold.
 *
 * ── The one signature loop ──────────────────────────────────────────────────
 * Two `hero__pulse` rings expand out of the mark and fade, half a cycle apart.
 * This is a voice app and the mark is its icon, so the page's single continuous
 * motion is sound leaving that icon — not a decorative shimmer bolted onto a
 * logo. The two static rings underneath stay static: they are the composition,
 * the pulses are the motion.
 *
 * `.hero__orbit` exists purely to own the scroll parallax, because an element
 * can only run one `transform` animation at a time and the wrapper above it is
 * already spending its transform on the entry.
 */
export function Hero(): JSX.Element {
  const { t } = useTranslation("landing");
  const visualRef = useLiveWhileVisible<HTMLDivElement>();

  return (
    <section className="hero">
      <div className="shell hero__inner">
        <div className="hero__copy">
          <h1 className="hero__title">{t("hero.title")}</h1>
          <p className="hero__lead">{t("hero.lead")}</p>
          <div className="hero__actions">
            <a className="btn btn--accent btn--lg" href={APP_URL}>
              {t("cta.openApp")}
            </a>
            <a className="btn btn--ghost btn--lg" href="#download">
              {t("cta.download")}
            </a>
          </div>
        </div>

        <div className="hero__visual" aria-hidden="true" ref={visualRef}>
          <span className="hero__orbit">
            <span className="hero__ring hero__ring--outer" />
            <span className="hero__ring hero__ring--inner" />
            <span className="hero__pulse hero__pulse--a" />
            <span className="hero__pulse hero__pulse--b" />
            <img
              className="hero__mark"
              src={demliMark}
              width={512}
              height={512}
              alt=""
              fetchPriority="high"
            />
          </span>
        </div>
      </div>
    </section>
  );
}
