import { afterEach, describe, expect, it, vi } from "vitest";
import { detectDeviceLocale } from "../detect.js";

type IntlLike = { DateTimeFormat: () => { resolvedOptions: () => { locale: string } } };

function stubIntlLocale(locale: string): void {
  vi.stubGlobal("Intl", {
    DateTimeFormat: () => ({ resolvedOptions: () => ({ locale }) }),
  } satisfies IntlLike);
}

function stubIntlThrows(): void {
  vi.stubGlobal("Intl", {
    DateTimeFormat: () => {
      throw new Error("Intl unavailable");
    },
  } satisfies IntlLike);
}

describe("detectDeviceLocale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers navigator.languages and takes the primary subtag", () => {
    vi.stubGlobal("navigator", { languages: ["tr-TR", "en-US"], language: "en-US" });
    expect(detectDeviceLocale()).toBe("tr");
  });

  it("falls back to navigator.language when languages is empty", () => {
    vi.stubGlobal("navigator", { languages: [], language: "TR-tr" });
    expect(detectDeviceLocale()).toBe("tr");
  });

  it("uses Intl (Hermes/Node, JS-only) when navigator has no language", () => {
    vi.stubGlobal("navigator", undefined);
    stubIntlLocale("tr-TR");
    expect(detectDeviceLocale()).toBe("tr");
  });

  it("falls back to 'en' for an unsupported locale", () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    expect(detectDeviceLocale()).toBe("en");
  });

  it("falls back to 'en' when nothing is available", () => {
    vi.stubGlobal("navigator", undefined);
    stubIntlThrows();
    expect(detectDeviceLocale()).toBe("en");
  });

  it("normalizes underscore-delimited locales", () => {
    vi.stubGlobal("navigator", undefined);
    stubIntlLocale("tr_TR");
    expect(detectDeviceLocale()).toBe("tr");
  });
});
