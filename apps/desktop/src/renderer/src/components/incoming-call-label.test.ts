/**
 * The incoming-call dialog's accessible name is a catalog sentence, not
 * `${caller} — ${subtitle}` glued in code (pre-release i18n audit): word order
 * and punctuation belong to each language, not to the component.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createI18n, createMemoryStorage } from "@demli/i18n";

describe("IncomingCallDialog accessible name", () => {
  it("is built from the catalog, with no punctuation glued in code", () => {
    const code = readFileSync(
      fileURLToPath(new URL("./IncomingCallDialog.tsx", import.meta.url)),
      "utf8",
    );
    expect(code).toContain('t("desktop:call.incomingDialogLabel"');
    expect(code).not.toMatch(/aria-label=\{`[^`]*\$\{[^`]*\}\s*—/);
  });

  it("reads caller then call kind in both languages", async () => {
    const tr = await createI18n({ lng: "tr", storage: createMemoryStorage() });
    const en = await createI18n({ lng: "en", storage: createMemoryStorage() });
    expect(
      tr.t("desktop:call.incomingDialogLabel", { caller: "Burak", subtitle: "Gelen sesli arama" }),
    ).toBe("Burak — Gelen sesli arama");
    expect(
      en.t("desktop:call.incomingDialogLabel", { caller: "Burak", subtitle: "Incoming voice call" }),
    ).toBe("Burak — Incoming voice call");
  });
});
