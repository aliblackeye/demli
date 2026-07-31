import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, setLocale } from "../create-i18n.js";
import { createMemoryStorage, type LocaleStorage } from "../storage.js";

const asLooseT = (t: unknown) => t as (key: string, opts?: { name?: string }) => string;

describe("createI18n", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("honors an explicit lng and loads that catalog", async () => {
    const i18n = await createI18n({ lng: "tr" });
    expect(i18n.language).toBe("tr");
    expect(asLooseT(i18n.t)("common:system.member_joined", { name: "Ali" })).toBe(
      "Ali sunucuya katıldı",
    );
  });

  it("resolves a persisted locale from storage over device detection", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    const i18n = await createI18n({ storage: createMemoryStorage("tr") });
    expect(i18n.language).toBe("tr");
  });

  it("ignores an unsupported stored value and detects instead", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    const i18n = await createI18n({ storage: createMemoryStorage("de") });
    expect(i18n.language).toBe("en");
  });

  it("falls back to the detected device locale when nothing is stored", async () => {
    vi.stubGlobal("navigator", { languages: ["tr-TR"] });
    const i18n = await createI18n({ storage: createMemoryStorage(null) });
    expect(i18n.language).toBe("tr");
  });

  it("persists user-driven language changes through the storage adapter", async () => {
    const setSpy = vi.fn();
    const storage: LocaleStorage = { get: () => "en", set: setSpy };
    const i18n = await createI18n({ storage });
    expect(i18n.language).toBe("en");

    await setLocale(i18n, "tr");
    expect(i18n.language).toBe("tr");
    // languageChanged listener (attached after init) persisted only the change.
    expect(setSpy).toHaveBeenCalledWith("tr");
    expect(setSpy).not.toHaveBeenCalledWith("en");
  });

  it("interpolates both catalogs with the resolved locale", async () => {
    const en = await createI18n({ lng: "en" });
    const tr = await createI18n({ lng: "tr" });
    expect(asLooseT(en.t)("common:system.member_left", { name: "Mert" })).toBe(
      "Mert left the server",
    );
    expect(asLooseT(tr.t)("common:system.member_left", { name: "Mert" })).toBe(
      "Mert sunucudan ayrıldı",
    );
  });
});
