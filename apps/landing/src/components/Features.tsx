import type { CSSProperties } from "react";
import { useTranslation } from "@demli/i18n";
import { useLiveWhileVisible, useRevealOnce } from "../lib/motion";

/**
 * A 1+2 bento, not three equal cards: voice gets the tall cell because voice is
 * the product's first priority (CLAUDE.md §6), screen-share and chat share the
 * column beside it. Exactly three cells for exactly three claims, so the grid
 * never has a blank tile to pad.
 *
 * Everything named here already ships (CLAUDE.md §35 — no roadmap dressed up as
 * a feature): reconnect, the DM-call-to-group upgrade, per-user volume, device
 * selection, call history, stream quality, search, mentions, unread markers.
 *
 * The three cells arrive in sequence the first time the grid reaches the fold
 * (60ms apart, once, never replayed) so the eye is walked lead-cell-first
 * instead of being handed three finished boxes at the same instant.
 */

/**
 * Bar heights for the audio motif, as a fraction of the strip's height.
 */
const WAVE = [0.34, 0.62, 0.28, 0.85, 0.47, 0.95, 0.4, 0.72, 0.31, 0.58, 0.24, 0.8, 0.44, 0.66];

/**
 * Cycle length per bar, picked round-robin. Five deliberately unrelated periods:
 * with ONE shared duration the strip re-synchronises every cycle and starts
 * reading as a chorus line, which is exactly what a level meter never does.
 */
const WAVE_PERIODS = ["1180ms", "1460ms", "1020ms", "1340ms", "1620ms"];

export function Features(): JSX.Element {
  const { t } = useTranslation("landing");
  const bentoRef = useRevealOnce<HTMLUListElement>();
  const waveRef = useLiveWhileVisible<HTMLDivElement>();

  return (
    <section className="section">
      <div className="shell">
        <ul className="bento reveal-group" ref={bentoRef}>
          <li className="bento__cell bento__cell--lead">
            {/*
             * An audio level strip, not a mock-up of the app: it says "someone is
             * talking" in one glance, which is the one claim this cell makes.
             * The per-bar height, phase and period ride CSS custom properties so
             * the animation stays in the stylesheet and off the main thread, and
             * the whole strip is paused whenever it is not on screen.
             */}
            <div className="wave" aria-hidden="true" ref={waveRef}>
              {WAVE.map((height, index) => (
                <span
                  className="wave__bar"
                  key={index}
                  style={
                    {
                      "--h": height,
                      "--i": index,
                      "--d": WAVE_PERIODS[index % WAVE_PERIODS.length],
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <h2 className="bento__title bento__title--lead">{t("features.voice.title")}</h2>
            <p className="bento__body">{t("features.voice.body")}</p>
            <p className="bento__note">{t("features.voice.note")}</p>
          </li>

          <li className="bento__cell bento__cell--share">
            <h2 className="bento__title">{t("features.share.title")}</h2>
            <p className="bento__body">{t("features.share.body")}</p>
          </li>

          <li className="bento__cell">
            <h2 className="bento__title">{t("features.chat.title")}</h2>
            <p className="bento__body">{t("features.chat.body")}</p>
          </li>
        </ul>
      </div>
    </section>
  );
}
