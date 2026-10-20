// @vitest-environment jsdom
/**
 * A picture whose signed URL resolved but whose BYTES failed (expired
 * signature, 403/404, a dropped connection) used to sit at opacity 0 under a
 * pulse that never stopped — a loading state that was really an error. It now
 * shows the error tile, and "retry" re-signs the URL instead of reusing the
 * cached one that just failed.
 *
 * The AttachmentTile render is real; only the network (the batch URL endpoint)
 * and the icon set are stubbed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage, type i18n as I18n } from "@demli/i18n";
import type { Attachment } from "@demli/types";
import type { AttachmentTile as AttachmentTileComponent } from "./AttachmentTile";

let signCount = 0;
const getAttachmentUrls = vi.fn(async (_channelId: string, ids: string[]) => {
  signCount += 1;
  return {
    urls: ids.map((id) => ({
      attachmentId: id,
      url: `https://storage.test/${id}?sig=${signCount}`,
      urlExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })),
  };
});

vi.mock("../lib/api-client", () => ({ api: { getAttachmentUrls } }));
vi.mock("./ImageActionItems", () => ({ hasImageActions: () => false, ImageActionItems: () => null }));
vi.mock("lucide-react", async (importOriginal) => {
  const icons = await importOriginal<Record<string, unknown>>();
  const Icon = (): JSX.Element => <svg />;
  return Object.fromEntries(Object.keys(icons).map((name) => [name, Icon]));
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let i18n: I18n;
let AttachmentTile: typeof AttachmentTileComponent;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  i18n = await createI18n({ lng: "tr", storage: createMemoryStorage() });
  ({ AttachmentTile } = await import("./AttachmentTile"));
}, 60_000);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const image = (id: string): Attachment =>
  ({
    id,
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 1000,
    width: 400,
    height: 300,
    filename: "a.png",
  }) as unknown as Attachment;

async function flush(): Promise<void> {
  // The URL layer batches inside a 16 ms window, then awaits the request.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function renderTile(props: Partial<Parameters<typeof AttachmentTileComponent>[0]> & { attachment: Attachment }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <AttachmentTile channelId="c1" {...props} />
      </I18nextProvider>,
    );
  });
  await flush();
  return host;
}

function fail(img: HTMLImageElement | null): void {
  act(() => {
    img?.dispatchEvent(new Event("error"));
  });
}

describe("AttachmentTile when the image bytes fail", () => {
  it("swaps the endless pulse for an error with a retry", async () => {
    const el = await renderTile({ attachment: image("a1") });
    const img = el.querySelector("img");
    expect(img?.getAttribute("src")).toContain("a1?sig=");
    expect(el.querySelector('[role="alert"]')).toBeNull();

    fail(img);

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(i18n.t("desktop:attachments.loadFailed"));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".animate-pulse")).toBeNull();
    expect(alert?.querySelector("button")?.textContent).toContain(i18n.t("desktop:chat.retry"));
  });

  it("retry re-signs the URL instead of reusing the one that failed", async () => {
    const el = await renderTile({ attachment: image("a2") });
    const firstSrc = el.querySelector("img")?.getAttribute("src");
    fail(el.querySelector("img"));
    const before = getAttachmentUrls.mock.calls.length;

    act(() => {
      el.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    });
    await flush();

    expect(getAttachmentUrls.mock.calls.length).toBe(before + 1);
    const img = el.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).not.toBe(firstSrc);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("an optimistic (local bytes) tile shows the error too, and retry reloads them", async () => {
    const el = await renderTile({ attachment: image("a3"), localUrl: "blob:local-a3" });
    fail(el.querySelector("img"));
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    act(() => {
      el.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    });
    expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:local-a3");
  });
});
