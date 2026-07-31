// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isExternalHttpUrl, openExternalUrl } from "./external-link";

/**
 * The shared "open this outside the app" seam.
 *
 * Two guarantees matter here and they pull in opposite directions:
 *
 *  1. DESKTOP — `window.open` is denied outright by the main process, so a link
 *     MUST go through the preload bridge or it silently does nothing.
 *  2. WEB — there is no bridge to require; `window.open` is the correct and only
 *     mechanism, and the shared components must keep working without one.
 *
 * So the seam prefers the bridge and falls back. Both paths are covered below,
 * plus the scheme gate that runs before either.
 */

interface TestWindow {
  open: ReturnType<typeof vi.fn>;
  demli?: unknown;
}

function testWindow(): TestWindow {
  return window as unknown as TestWindow;
}

beforeEach(() => {
  // jsdom's real window.open is a "not implemented" stub that logs — replace it.
  testWindow().open = vi.fn();
  delete testWindow().demli;
});

afterEach(() => {
  delete testWindow().demli;
  vi.restoreAllMocks();
});

describe("isExternalHttpUrl", () => {
  it("accepts absolute http(s) addresses", () => {
    expect(isExternalHttpUrl("https://example.test/a?b=c#d")).toBe(true);
    expect(isExternalHttpUrl("http://example.test/")).toBe(true);
  });

  it("refuses non-http(s) schemes and unparseable strings", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "demli://join/abc",
      "mailto:a@b.test",
      "//example.test/protocol-relative",
      "/relative",
      "example.test",
      "",
    ]) {
      expect(isExternalHttpUrl(url)).toBe(false);
    }
    expect(isExternalHttpUrl(undefined)).toBe(false);
    expect(isExternalHttpUrl(123)).toBe(false);
  });
});

describe("openExternalUrl — desktop (bridge present)", () => {
  it("routes through the bridge and does NOT call window.open", () => {
    const open = vi.fn(async () => true);
    testWindow().demli = { externalLinks: { open } };

    expect(openExternalUrl("https://example.test/page")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.test/page");
    // The desktop window-open handler is an unconditional deny, so a window.open
    // here would be a dead link. This assertion is the regression guard.
    expect(testWindow().open).not.toHaveBeenCalled();
  });

  it("never hands a non-http(s) url to the bridge", () => {
    const open = vi.fn(async () => true);
    testWindow().demli = { externalLinks: { open } };

    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(openExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("swallows a rejected bridge call instead of leaking an unhandled rejection", async () => {
    const open = vi.fn(async () => {
      throw new Error("main refused");
    });
    testWindow().demli = { externalLinks: { open } };

    expect(openExternalUrl("https://example.test/")).toBe(true);
    // Let the rejection settle; an unhandled one would fail the run.
    await Promise.resolve();
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("openExternalUrl — web (no bridge)", () => {
  it("falls back to a noopener window.open", () => {
    expect(openExternalUrl("https://example.test/page")).toBe(true);
    expect(testWindow().open).toHaveBeenCalledWith(
      "https://example.test/page",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("falls back when a bridge exists but has no externalLinks namespace", () => {
    // An older preload, or a partial test stub — the shared UI must not break.
    testWindow().demli = { appInfo: { platform: "web", version: "0.0.0" } };
    expect(openExternalUrl("https://example.test/")).toBe(true);
    expect(testWindow().open).toHaveBeenCalledTimes(1);
  });

  it("still refuses non-http(s) urls on the fallback path", () => {
    expect(openExternalUrl("javascript:alert(1)")).toBe(false);
    expect(openExternalUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(openExternalUrl("/relative")).toBe(false);
    expect(testWindow().open).not.toHaveBeenCalled();
  });

  it("reports false when the browser blocks the open", () => {
    testWindow().open = vi.fn(() => {
      throw new Error("popup blocked");
    });
    expect(openExternalUrl("https://example.test/")).toBe(false);
  });
});
