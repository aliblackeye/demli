/**
 * Guard for the Hermes plural regression (found in the emulator smoke run).
 *
 * Our catalogs use i18next's v4 plural form (`key_one` / `key_other`) with NO
 * base key — correct, and what desktop/web resolve against. i18next picks its
 * plural resolver ONCE at init, from whether `Intl.PluralRules` exists. Hermes
 * ships without it, so on device i18next silently dropped to v3 handling, which
 * looks for `key` / `key_plural`, matched nothing, and rendered the RAW KEY:
 * users saw "chat.memberSummary" instead of "3 kişi · 2 çevrimiçi" in every
 * channel header, and "search.resultCount" in channel search.
 *
 * The fix is a pure-JS polyfill imported at the top of `app/_layout.tsx`. Node
 * has `Intl.PluralRules` natively, so a runtime assertion here would pass even
 * with the polyfill deleted — it would guard nothing. What actually breaks the
 * app is the IMPORT going missing or sliding below another import that pulls in
 * i18next first, so that is what this asserts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "../../../app/_layout.tsx");

describe("Hermes plural polyfill", () => {
  it("is imported by the root layout BEFORE any other import", () => {
    const source = readFileSync(ENTRY, "utf8");
    const imports = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));

    expect(imports[0]).toBe('import "intl-pluralrules";');
  });

  it("resolves the v4 plural suffixes our catalogs are written in", () => {
    // Sanity-check the assumption the catalogs rely on: `one` for 1, `other`
    // beyond it. If a future i18next/CLDR change broke this, the suffixes in
    // every mobile catalog entry would stop matching.
    const rules = new Intl.PluralRules("en");
    expect(rules.select(1)).toBe("one");
    expect(rules.select(3)).toBe("other");
  });
});
