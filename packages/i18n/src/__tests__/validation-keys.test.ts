/**
 * Every validation key the form mapper can emit must EXIST in both catalogs.
 *
 * The TR⇄EN parity test next door proves the two languages agree with each
 * other; it cannot notice a key that is missing from both. That gap matters
 * here specifically: `issue-to-error.ts` returns a key, i18next silently falls
 * back to rendering the raw key when it is unknown, and the user sees
 * `validation.reservedUsername` under the username field — which is the same
 * "the form will not tell me what is wrong" failure this layer was built to fix,
 * wearing a different hat.
 *
 * `VALIDATION_KEYS` is the mapper's own exhaustive list, and a client-core test
 * proves every protocol validation code maps into it. So this file closes the
 * chain: protocol code → mapper key → translated sentence, in both languages.
 */

import { describe, expect, it } from "vitest";
import { VALIDATION_KEYS } from "@demli/client-core";
import enCommon from "../locales/en/common.json";
import trCommon from "../locales/tr/common.json";

/** Resolve a dotted key against a nested catalog. */
function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

describe.each([
  { name: "en", catalog: enCommon as unknown },
  { name: "tr", catalog: trCommon as unknown },
])("$name common catalog", ({ catalog }) => {
  it("translates every key the validation mapper can emit", () => {
    const missing = VALIDATION_KEYS.filter((key) => lookup(catalog, key) === undefined);
    expect(missing).toEqual([]);
  });

  it("has no empty validation string", () => {
    const blank = VALIDATION_KEYS.filter((key) => (lookup(catalog, key) ?? "").trim() === "");
    expect(blank).toEqual([]);
  });
});

describe("validation message interpolation", () => {
  it("uses {{min}} / {{max}} exactly where the mapper supplies them", () => {
    // A message that says "Use at least characters" is worse than no message.
    const withMin = ["validation.tooShort", "validation.numberTooSmall"];
    const withMax = ["validation.tooLong", "validation.numberTooBig"];
    for (const key of withMin) {
      expect(lookup(enCommon, key)).toContain("{{min}}");
      expect(lookup(trCommon, key)).toContain("{{min}}");
    }
    for (const key of withMax) {
      expect(lookup(enCommon, key)).toContain("{{max}}");
      expect(lookup(trCommon, key)).toContain("{{max}}");
    }
  });
});
