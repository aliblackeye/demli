/**
 * Compile-time key safety (ADR 0009 §2). Augments i18next's `CustomTypeOptions`
 * so `t(...)` only accepts keys that exist in the `en` catalogs, across all
 * three namespaces. Typos and missing keys become type errors.
 *
 * Importing this module (a side effect, done from index.ts) is what makes the
 * augmentation visible to every consumer of `@demli/i18n`. `desktop`/`mobile`
 * start empty, so their keys type-error until waves I2/I3 add them — an
 * intentional guardrail.
 */

import type { Resources } from "./resources.js";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: Resources;
    // t(...) returns string, never null (init sets returnNull: false).
    returnNull: false;
  }
}
