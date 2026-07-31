import { afterEach, describe, expect, it, vi } from "vitest";
import { railDownloadAction } from "./download-surface";

/**
 * The founder's rule for the rail download button, locked down:
 * a phone is offered ONLY the artifact it can install (and the click IS the
 * download), a desktop browser keeps the full picker, and a narrow window is
 * NOT a phone.
 *
 * Both inputs are stubbed the way the production code reads them:
 *   surface  → the platform bridge (`window.demli.appInfo.platform`)
 *   device   → the User-Agent (+ maxTouchPoints for the iPadOS-as-Mac case)
 */

const UA = {
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  ipadOS13:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
} as const;

function stub(options: {
  platform: string | undefined;
  ua: string;
  maxTouchPoints?: number;
  innerWidth?: number;
}): void {
  if (options.platform === undefined) {
    vi.stubGlobal("window", { innerWidth: options.innerWidth ?? 1440 });
  } else {
    vi.stubGlobal("window", {
      innerWidth: options.innerWidth ?? 1440,
      demli: { appInfo: { platform: options.platform } },
    });
  }
  vi.stubGlobal("navigator", {
    userAgent: options.ua,
    maxTouchPoints: options.maxTouchPoints ?? 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("railDownloadAction", () => {
  it("offers a phone ONLY its own build, as a direct download", () => {
    stub({ platform: "web", ua: UA.androidPhone, innerWidth: 375 });
    const action = railDownloadAction();
    expect(action.kind).toBe("direct");
    // Never the Windows installer — a phone cannot run it.
    if (action.kind !== "direct") throw new Error("expected a direct download");
    expect(action.platform).toBe("android");
    expect(action.url).toMatch(/^https:\/\/.+\/android$/);
  });

  it("renders nothing on iOS, where we have no build to hand over", () => {
    stub({ platform: "web", ua: UA.iphone, innerWidth: 375 });
    expect(railDownloadAction().kind).toBe("hidden");
  });

  it("treats an iPad reporting a Mac UA as a phone OS, not a desktop", () => {
    stub({ platform: "web", ua: UA.ipadOS13, maxTouchPoints: 5, innerWidth: 820 });
    // iPadOS ⇒ ios ⇒ no build ⇒ hidden. Critically NOT the Windows picker.
    expect(railDownloadAction().kind).toBe("hidden");
  });

  it("keeps the full picker for a desktop browser", () => {
    stub({ platform: "web", ua: UA.windowsChrome });
    expect(railDownloadAction().kind).toBe("dialog");

    stub({ platform: "web", ua: UA.mac, maxTouchPoints: 0 });
    expect(railDownloadAction().kind).toBe("dialog");
  });

  it("does NOT mistake a narrow desktop window for a phone", () => {
    // A desktop browser dragged to phone width: still a PC, still the picker —
    // the OS, not the viewport, decides which artifact can run here.
    stub({ platform: "web", ua: UA.windowsChrome, innerWidth: 360 });
    expect(railDownloadAction().kind).toBe("dialog");
  });

  it("renders nothing inside the installed desktop app", () => {
    stub({ platform: "win32", ua: UA.windowsChrome });
    expect(railDownloadAction().kind).toBe("hidden");
    // Even at a narrow width, and even on a touch device running Electron.
    stub({ platform: "win32", ua: UA.windowsChrome, innerWidth: 360, maxTouchPoints: 10 });
    expect(railDownloadAction().kind).toBe("hidden");
  });

  it("renders nothing when there is no bridge at all (early paint / test host)", () => {
    stub({ platform: undefined, ua: UA.androidPhone, innerWidth: 375 });
    expect(railDownloadAction().kind).toBe("hidden");
  });
});
