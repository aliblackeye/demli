/**
 * Call accessibility labels are whole sentences from the catalog, never glued
 * together in code (pre-release i18n audit).
 *
 * A label built as `${a}, ${b}` or `${t("add")}: ${name}` hardcodes Turkish/
 * English punctuation and word order into the component — a screen reader then
 * reads whatever order the code happened to pick, in every language. The
 * catalog owns the sentence; the component only passes the parts.
 *
 * Source-level for the "no glue" half (mounting these screens drags in
 * expo-router, LiveKit and every store), real i18n for the "says the right
 * thing" half.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(join(HERE, file), "utf8");

/** Every accessibilityLabel={...} expression in a file (up to the matching brace). */
function labelExpressions(code: string): string[] {
  const out: string[] = [];
  const marker = "accessibilityLabel={";
  let at = code.indexOf(marker);
  while (at !== -1) {
    let depth = 1;
    let i = at + marker.length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
    }
    out.push(code.slice(at + marker.length, i - 1));
    at = code.indexOf(marker, i);
  }
  return out;
}

describe("call a11y labels carry no hardcoded punctuation", () => {
  it.each(["InCallView.tsx", "AddPersonSheet.tsx", "RecentCallRow.tsx"])("%s", (file) => {
    for (const expr of labelExpressions(source(file))) {
      // A template literal that joins parts with punctuation is exactly the bug.
      expect(expr, `${file}: ${expr.trim()}`).not.toMatch(/`[^`]*\}\s*[,:;—·-]\s*\$\{/);
      expect(expr, `${file}: ${expr.trim()}`).not.toMatch(/`[^`]*\$\{[^`]*\}[,:;—·-]/);
    }
  });
});

describe("the catalog sentences", () => {
  let tr: I18n;
  let en: I18n;
  beforeAll(async () => {
    tr = await createI18n({ lng: "tr", storage: createMemoryStorage() });
    en = await createI18n({ lng: "en", storage: createMemoryStorage() });
  });

  it("phase + duration", () => {
    expect(tr.t("mobile:call.phaseWithDuration", { phase: "Aramada", duration: "02:14" })).toBe(
      "Aramada, 02:14",
    );
    expect(en.t("mobile:call.phaseWithDuration", { phase: "In call", duration: "02:14" })).toBe(
      "In call, 02:14",
    );
  });

  it("add a friend to the call", () => {
    expect(tr.t("mobile:call.a11yAddFriend", { name: "Burak" })).toBe("Aramaya ekle: Burak");
    expect(en.t("mobile:call.a11yAddFriend", { name: "Burak" })).toBe("Add Burak to the call");
  });

  it("recent-call row, with and without a time", () => {
    expect(tr.t("mobile:recentCalls.rowLabel", { name: "Mert", summary: "Cevapsız arama" })).toBe(
      "Mert, Cevapsız arama",
    );
    expect(
      en.t("mobile:recentCalls.rowLabelWithTime", { name: "Mert", summary: "Missed call", time: "14:05" }),
    ).toBe("Mert, Missed call, 14:05");
  });

  it("names are not HTML-escaped (labels are spoken, not rendered as HTML)", () => {
    expect(en.t("mobile:call.a11yAddFriend", { name: "Ali & Can" })).toBe("Add Ali & Can to the call");
  });
});
