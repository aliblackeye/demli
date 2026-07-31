/**
 * TR ⇄ EN key parity (CLAUDE.md §4: "key parity enforced by tests").
 *
 * Every user-facing string in this app has to exist in BOTH languages. A missing
 * key does not throw at runtime — i18next silently falls back to the raw key, so
 * a half-translated feature ships looking fine in one language and shows
 * `pins.unpin` in the other. That is exactly the class of bug a compile/test gate
 * catches for free and a human review does not.
 *
 * Compares the leaf-key SETS of each namespace (not the values — translations
 * differ by definition, and interpolation placeholders are covered separately
 * below because a `{{name}}` dropped in one language is a broken sentence).
 */

import { describe, expect, it } from "vitest";
import enCommon from "../locales/en/common.json";
import enDesktop from "../locales/en/desktop.json";
import enLanding from "../locales/en/landing.json";
import enMobile from "../locales/en/mobile.json";
import trCommon from "../locales/tr/common.json";
import trDesktop from "../locales/tr/desktop.json";
import trLanding from "../locales/tr/landing.json";
import trMobile from "../locales/tr/mobile.json";

type Catalog = Record<string, unknown>;

/** Flatten a nested catalog into `a.b.c` → value. */
function flatten(node: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  for (const [key, value] of Object.entries(node as Catalog)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** Every `{{placeholder}}` used in a string, as a sorted set. */
function placeholders(value: string): string[] {
  return [...new Set(value.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [])]
    .map((token) => token.replace(/[{}\s]/g, ""))
    .sort();
}

const NAMESPACES: { name: string; en: Catalog; tr: Catalog }[] = [
  { name: "common", en: enCommon, tr: trCommon },
  { name: "desktop", en: enDesktop, tr: trDesktop },
  { name: "mobile", en: enMobile, tr: trMobile },
  { name: "landing", en: enLanding, tr: trLanding },
];

describe.each(NAMESPACES)("$name catalog", ({ en, tr }) => {
  const enFlat = flatten(en);
  const trFlat = flatten(tr);

  it("has no key present in EN but missing in TR", () => {
    const missing = [...enFlat.keys()].filter((key) => !trFlat.has(key));
    expect(missing).toEqual([]);
  });

  it("has no key present in TR but missing in EN", () => {
    const missing = [...trFlat.keys()].filter((key) => !enFlat.has(key));
    expect(missing).toEqual([]);
  });

  it("uses the same interpolation placeholders in both languages", () => {
    // A translated sentence that drops `{{name}}` renders "Pinned by " — valid
    // i18next, nonsense to a reader. Comparing the placeholder sets catches it.
    const mismatched: { key: string; en: string[]; tr: string[] }[] = [];
    for (const [key, enValue] of enFlat) {
      const trValue = trFlat.get(key);
      if (trValue === undefined) continue;
      const a = placeholders(enValue);
      const b = placeholders(trValue);
      if (a.join("|") !== b.join("|")) mismatched.push({ key, en: a, tr: b });
    }
    expect(mismatched).toEqual([]);
  });
});
