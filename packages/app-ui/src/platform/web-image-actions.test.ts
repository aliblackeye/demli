import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebImagesBridge, webCopyImageSupported } from "./web-image-actions";

/**
 * The "copy image" menu entry is rendered ONLY when the surface can actually put
 * an image on the clipboard (CLAUDE.md §35 — no dead buttons). These tests pin
 * that predicate: every browser that lacks either half of the async clipboard
 * image API must report false, so the entry disappears instead of failing.
 */

interface FakeGlobal {
  ClipboardItem?: unknown;
  navigator?: { clipboard?: { write?: unknown } };
  isSecureContext?: boolean;
}

function scope(overrides: FakeGlobal): FakeGlobal {
  return overrides;
}

const clipboardItemCtor = function ClipboardItem(): void {};

describe("webCopyImageSupported", () => {
  it("is true on a modern Chromium-like browser", () => {
    const supported = webCopyImageSupported(
      scope({
        ClipboardItem: clipboardItemCtor,
        navigator: { clipboard: { write: () => undefined } },
        isSecureContext: true,
      }),
    );
    expect(supported).toBe(true);
  });

  it("is false without ClipboardItem (older Safari / Firefox)", () => {
    const supported = webCopyImageSupported(
      scope({
        navigator: { clipboard: { write: () => undefined } },
        isSecureContext: true,
      }),
    );
    expect(supported).toBe(false);
  });

  it("is false when clipboard.write is missing (read-only clipboard API)", () => {
    const supported = webCopyImageSupported(
      scope({
        ClipboardItem: clipboardItemCtor,
        navigator: { clipboard: {} },
        isSecureContext: true,
      }),
    );
    expect(supported).toBe(false);
  });

  it("is false with no navigator.clipboard at all (iOS 12 Safari)", () => {
    const supported = webCopyImageSupported(
      scope({ ClipboardItem: clipboardItemCtor, navigator: {}, isSecureContext: true }),
    );
    expect(supported).toBe(false);
  });

  it("is false in an insecure context", () => {
    const supported = webCopyImageSupported(
      scope({
        ClipboardItem: clipboardItemCtor,
        navigator: { clipboard: { write: () => undefined } },
        isSecureContext: false,
      }),
    );
    expect(supported).toBe(false);
  });

  it("does not require isSecureContext to be reported", () => {
    const supported = webCopyImageSupported(
      scope({
        ClipboardItem: clipboardItemCtor,
        navigator: { clipboard: { write: () => undefined } },
      }),
    );
    expect(supported).toBe(true);
  });

  it("is false in a bare node scope (no DOM at all)", () => {
    expect(webCopyImageSupported(scope({}))).toBe(false);
  });
});

describe("createWebImagesBridge", () => {
  const target = { url: "https://x.example.com/a.png", mime: "image/png", fileName: "a.png" };
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function respondWith(bytes: readonly number[]): void {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array(bytes).buffer]),
    })) as unknown as typeof fetch;
  }

  it("always reports save as available (the browser always has a way)", () => {
    expect(createWebImagesBridge().saveSupported).toBe(true);
  });

  it("REFUSES to save bytes that are not really an image", async () => {
    // The response type is the server's claim; a save turns it into a file on
    // the user's disk called "a.png". Trust the magic number instead.
    respondWith([...new TextEncoder().encode("<!doctype html><script>alert(1)</script>")]);
    await expect(createWebImagesBridge().save(target)).resolves.toEqual({
      status: "error",
      reason: "download_failed",
    });
  });

  it("REFUSES to save a Windows executable renamed to .png", async () => {
    respondWith([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    await expect(createWebImagesBridge().save(target)).resolves.toEqual({
      status: "error",
      reason: "download_failed",
    });
  });
});
