/**
 * Static i18next resource tree assembled from the JSON catalogs.
 *
 * `common` is owned by this package; `desktop`/`mobile` are skeletons ({}) that
 * waves I2/I3 fill in with no plumbing changes — just edit the JSON. The `en`
 * tree is the canonical shape used for compile-time key typing (i18next-env.ts).
 *
 * `resources` (everything) and `landingResources` (one namespace) are separate
 * exported bindings on purpose: a bundler drops the unused one along with the
 * JSON only it referenced. That is what keeps the public landing page from
 * shipping the ~170 KB desktop + mobile catalogs it has no use for.
 */

import enCommon from "./locales/en/common.json";
import enDesktop from "./locales/en/desktop.json";
import enLanding from "./locales/en/landing.json";
import enMobile from "./locales/en/mobile.json";
import trCommon from "./locales/tr/common.json";
import trDesktop from "./locales/tr/desktop.json";
import trLanding from "./locales/tr/landing.json";
import trMobile from "./locales/tr/mobile.json";

export const resources = {
  en: { common: enCommon, desktop: enDesktop, mobile: enMobile, landing: enLanding },
  tr: { common: trCommon, desktop: trDesktop, mobile: trMobile, landing: trLanding },
} as const;

/**
 * Just the `landing` namespace — the slice apps/landing initialises with (via
 * {@link createI18nFor}). Same catalogs, same parity test, none of the product
 * copy a marketing page would only be shipping as dead bytes.
 */
export const landingResources = {
  en: { landing: enLanding },
  tr: { landing: trLanding },
} as const;

/** Canonical namespace shapes (from `en`) for i18next type augmentation. */
export type Resources = (typeof resources)["en"];
