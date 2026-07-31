import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@demli/types";
import {
  canCopyImage,
  canSaveImage,
  imageActionTarget,
  imageFileName,
  runImageCopy,
  runImageSave,
  type ImageActionTarget,
} from "./image-actions";

type ImagesBridge = Window["demli"]["images"];

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "3f9a7c21-0000-4000-8000-000000000001",
    messageId: "m1",
    channelId: "c1",
    uploaderId: "u1",
    kind: "image",
    mime: "image/png",
    sizeBytes: 1234,
    width: 800,
    height: 600,
    durationMs: null,
    // Local time on purpose — the name mirrors what the user's clock showed.
    createdAt: new Date(2026, 6, 27, 14, 32, 51).toISOString(),
    ...overrides,
  } as Attachment;
}

const target: ImageActionTarget = {
  url: "https://abcdef.supabase.co/storage/v1/object/sign/a/b.png?token=x",
  mime: "image/png",
  fileName: "demli-image-20260727-143251-3f9a.png",
};

function bridge(overrides: Partial<ImagesBridge>): ImagesBridge {
  return {
    saveSupported: true,
    copySupported: true,
    save: async () => ({ status: "canceled" }),
    copy: async () => ({ status: "copied" }),
    ...overrides,
  } as ImagesBridge;
}

/** Install a fake `window.demli.images` for the capability checks. */
function installBridge(images: ImagesBridge | null): void {
  (globalThis as { window?: unknown }).window = images
    ? { demli: { images } }
    : { demli: {} };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/**
 * A build that pinned no storage origin has a fail-closed download allow-list in
 * main, so both actions would fail on click. The bridge says so up front and the
 * menu entries must disappear rather than become dead buttons (CLAUDE.md §35).
 */
describe("capability gates", () => {
  it("offers both actions on a normally-pinned desktop build", () => {
    installBridge(bridge({}));
    expect(canSaveImage()).toBe(true);
    expect(canCopyImage()).toBe(true);
  });

  it("offers NEITHER action when the build pinned no storage origin", () => {
    installBridge(bridge({ saveSupported: false, copySupported: false }));
    expect(canSaveImage()).toBe(false);
    expect(canCopyImage()).toBe(false);
  });

  it("keeps save while hiding copy on a browser without ClipboardItem", () => {
    installBridge(bridge({ saveSupported: true, copySupported: false }));
    expect(canSaveImage()).toBe(true);
    expect(canCopyImage()).toBe(false);
  });

  it("offers nothing when there is no bridge at all", () => {
    installBridge(null);
    expect(canSaveImage()).toBe(false);
    expect(canCopyImage()).toBe(false);
  });
});

describe("imageFileName", () => {
  it("builds a sortable name from the attachment's own timestamp", () => {
    expect(imageFileName(attachment())).toBe("demli-image-20260727-143251-3f9a.png");
  });

  it("uses the extension of the real MIME", () => {
    expect(imageFileName(attachment({ mime: "image/jpeg" }))).toMatch(/\.jpg$/);
    expect(imageFileName(attachment({ mime: "image/webp" }))).toMatch(/\.webp$/);
    expect(imageFileName(attachment({ mime: "image/gif" }))).toMatch(/\.gif$/);
  });

  it("keeps two images uploaded in the SAME second apart", () => {
    const first = imageFileName(attachment({ id: "aaaa1111-0000-4000-8000-000000000001" }));
    const second = imageFileName(attachment({ id: "bbbb2222-0000-4000-8000-000000000002" }));
    expect(first).not.toBe(second);
  });

  it("falls back to now instead of producing NaN for a broken timestamp", () => {
    const name = imageFileName(attachment({ createdAt: "not-a-date" }));
    expect(name).not.toContain("NaN");
    expect(name).toMatch(/^demli-image-\d{8}-\d{6}-3f9a\.png$/);
  });

  it("carries the mime and generated name into the bridge payload", () => {
    const payload = imageActionTarget(attachment(), "https://x.supabase.co/a.png");
    expect(payload).toEqual({
      url: "https://x.supabase.co/a.png",
      mime: "image/png",
      fileName: "demli-image-20260727-143251-3f9a.png",
    });
  });
});

describe("runImageSave", () => {
  it("says NOTHING when the user cancels the save dialog", async () => {
    const save = vi.fn(async () => ({ status: "canceled" }) as const);
    const notice = await runImageSave(bridge({ save }), target);
    expect(save).toHaveBeenCalledOnce();
    expect(notice).toBeNull();
  });

  it("reports success once the file is written", async () => {
    const notice = await runImageSave(
      bridge({ save: async () => ({ status: "saved", fileName: "holiday.png" }) }),
      target,
    );
    expect(notice).toEqual({ tone: "ok", key: "desktop:attachments.saved" });
  });

  it("reports a plain failure line for a refused URL", async () => {
    const notice = await runImageSave(
      bridge({ save: async () => ({ status: "error", reason: "blocked_url" }) }),
      target,
    );
    expect(notice).toEqual({ tone: "error", key: "desktop:attachments.saveFailed" });
  });

  it("never lets a thrown bridge error reach the UI raw", async () => {
    const notice = await runImageSave(
      bridge({
        save: async () => {
          throw new Error("Error invoking remote method: boom");
        },
      }),
      target,
    );
    expect(notice).toEqual({ tone: "error", key: "desktop:attachments.saveFailed" });
  });
});

describe("runImageCopy", () => {
  it("reports success", async () => {
    const notice = await runImageCopy(bridge({ copy: async () => ({ status: "copied" }) }), target);
    expect(notice).toEqual({ tone: "ok", key: "desktop:attachments.copied" });
  });

  it("distinguishes an undecodable format from a generic failure", async () => {
    const unsupported = await runImageCopy(
      bridge({ copy: async () => ({ status: "error", reason: "unsupported_format" }) }),
      target,
    );
    expect(unsupported).toEqual({ tone: "error", key: "desktop:attachments.copyUnsupported" });

    const generic = await runImageCopy(
      bridge({ copy: async () => ({ status: "error", reason: "download_failed" }) }),
      target,
    );
    expect(generic).toEqual({ tone: "error", key: "desktop:attachments.copyFailed" });
  });

  it("never lets a thrown bridge error reach the UI raw", async () => {
    const notice = await runImageCopy(
      bridge({
        copy: async () => {
          throw new Error("boom");
        },
      }),
      target,
    );
    expect(notice).toEqual({ tone: "error", key: "desktop:attachments.copyFailed" });
  });
});
