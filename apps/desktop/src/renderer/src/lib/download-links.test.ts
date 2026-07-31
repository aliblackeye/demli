import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_TARGETS,
  downloadTarget,
  openDownloadUrl,
  visibleDownloadTargets,
} from "./download-links";

/**
 * These lock the CLAUDE.md §35 honesty contract into the type-independent
 * runtime shape: a platform is clickable if and only if there is a real link
 * behind it, and platforms we have not started are never rendered.
 */
describe("download-links", () => {
  it("only marks a platform available when it has an https URL", () => {
    for (const target of DOWNLOAD_TARGETS) {
      expect(target.availability === "available").toBe(target.url !== null);
      if (target.url !== null) expect(target.url).toMatch(/^https:\/\//);
    }
  });

  it("ships Windows and Android as live links", () => {
    expect(downloadTarget("windows").availability).toBe("available");
    expect(downloadTarget("android").availability).toBe("available");
  });

  it("keeps macOS visible-but-disabled (pipeline exists, no artifact yet)", () => {
    const macos = downloadTarget("macos");
    expect(macos.availability).toBe("soon");
    expect(macos.url).toBeNull();
    expect(visibleDownloadTargets("desktop").map((t) => t.id)).toContain("macos");
  });

  it("hides platforms with no build and no plan instead of promising them", () => {
    expect(downloadTarget("linux").availability).toBe("none");
    expect(downloadTarget("ios").availability).toBe("none");
    expect(visibleDownloadTargets("desktop").map((t) => t.id)).not.toContain("linux");
    expect(visibleDownloadTargets("mobile").map((t) => t.id)).not.toContain("ios");
  });

  it("splits rows into the dialog's two sections", () => {
    expect(visibleDownloadTargets("desktop").map((t) => t.id)).toEqual(["windows", "macos"]);
    expect(visibleDownloadTargets("mobile").map((t) => t.id)).toEqual(["android"]);
  });
});

/**
 * The download buttons must go through the platform seam, not `window.open`:
 * the desktop window-open handler is an unconditional deny, so a raw
 * `window.open` here would be a dead button on the surface that matters most.
 */
describe("openDownloadUrl", () => {
  const windowStub = { open: vi.fn(), demli: undefined as unknown };

  beforeEach(() => {
    windowStub.open = vi.fn();
    windowStub.demli = undefined;
    vi.stubGlobal("window", windowStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the preload bridge when one is present (desktop)", () => {
    const open = vi.fn(async () => true);
    windowStub.demli = { externalLinks: { open } };

    openDownloadUrl("https://getdemli.com/download/windows");

    expect(open).toHaveBeenCalledWith("https://getdemli.com/download/windows");
    expect(windowStub.open).not.toHaveBeenCalled();
  });

  it("falls back to window.open with no bridge (web)", () => {
    openDownloadUrl("https://getdemli.com/download/android");

    expect(windowStub.open).toHaveBeenCalledWith(
      "https://getdemli.com/download/android",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("refuses a non-https download link on both paths", () => {
    const open = vi.fn(async () => true);
    windowStub.demli = { externalLinks: { open } };

    openDownloadUrl("http://getdemli.com/download/windows");
    openDownloadUrl("javascript:alert(1)");

    expect(open).not.toHaveBeenCalled();
    expect(windowStub.open).not.toHaveBeenCalled();
  });
});
