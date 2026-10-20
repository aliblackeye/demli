// @vitest-environment jsdom
/**
 * The avatar photo fade (packages/ui UserAvatar) may run ONLY for a genuine
 * first load. Two audit findings (M16 Dalga 3) pinned here:
 *
 * - In the virtualized message list, `measureElement` reads layout in the row's
 *   ref, which runs AFTER the avatar's own ref. When "already cached" was
 *   decided in the img ref, the layout read had already computed the photo at
 *   opacity 0 and the flip to 1 transitioned: every cached avatar blinked on
 *   each channel switch. A URL decoded once must render opaque, with no
 *   transition class, on its very first frame — even under a layout-reading
 *   parent ref.
 * - The crop editor's live preview changes `src` on every zoom step. Once a
 *   photo has shown, a new `src` must swap in place at full opacity — never
 *   dropping back to the initials.
 *
 * jsdom never loads images, so `complete` / `naturalWidth` and the load event
 * are driven by hand, exactly as a browser would report them.
 */
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserAvatar, resetDecodedAvatarCache } from "@demli/ui";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** URLs the fake browser reports as already decoded when an <img> mounts. */
const browserCache = new Set<string>();

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get(this: HTMLImageElement) {
      return browserCache.has(this.getAttribute("src") ?? "");
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get(this: HTMLImageElement) {
      return browserCache.has(this.getAttribute("src") ?? "") ? 128 : 0;
    },
  });
});

beforeEach(() => {
  resetDecodedAvatarCache();
  browserCache.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: JSX.Element): void {
  act(() => root?.render(node));
}

function img(): HTMLImageElement {
  const el = host?.querySelector("img");
  if (!el) throw new Error("no <img>");
  return el;
}

function load(el: HTMLImageElement): void {
  browserCache.add(el.getAttribute("src") ?? "");
  act(() => {
    el.dispatchEvent(new Event("load"));
  });
}

const A = "https://cdn.example/avatars/a.webp";
const B = "https://cdn.example/avatars/b.webp";

/**
 * A row whose ref reads layout, like TanStack's `measureElement`: it records
 * the photo's classes at the moment the layout read happens.
 */
function MeasuredRow({ src, seen }: { src: string; seen: string[] }): JSX.Element {
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      const photo = node?.querySelector("img");
      if (photo) seen.push(photo.className);
    },
    [seen],
  );
  return (
    <div ref={ref}>
      <UserAvatar name="Ece Yılmaz" src={src} />
    </div>
  );
}

describe("UserAvatar photo fade", () => {
  it("a first load starts transparent and fades in once decoded", () => {
    render(<UserAvatar name="Ece Yılmaz" src={A} />);
    expect(img().className).toContain("opacity-0");
    expect(img().className).not.toContain("transition-opacity");
    load(img());
    expect(img().className).toContain("opacity-100");
    expect(img().className).toContain("transition-opacity");
  });

  it("a URL decoded before is opaque with NO transition at a layout-reading parent's ref", () => {
    render(<UserAvatar name="Ece Yılmaz" src={A} />);
    load(img());
    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);

    const seen: string[] = [];
    render(<MeasuredRow src={A} seen={seen} />);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("opacity-100");
    expect(seen[0]).not.toContain("transition-opacity");
    expect(img().className).not.toContain("transition-opacity");
  });

  it("an image already in the HTTP cache at mount snaps opaque without a fade", () => {
    browserCache.add(B);
    render(<UserAvatar name="Ece Yılmaz" src={B} />);
    expect(img().className).toContain("opacity-100");
    expect(img().className).not.toContain("transition-opacity");
  });

  it("a new src after a shown photo swaps at full opacity (no initials flash)", () => {
    render(<UserAvatar name="Ece Yılmaz" src="blob:preview-1" />);
    load(img());
    const node = img();
    render(<UserAvatar name="Ece Yılmaz" src="blob:preview-2" />);
    // Same element, new URL still decoding: stays opaque so the old picture
    // keeps painting until the new one is ready.
    expect(img()).toBe(node);
    expect(img().getAttribute("src")).toBe("blob:preview-2");
    expect(img().className).toContain("opacity-100");
  });

  it("a failed URL falls back to the initials; the next URL is a first load again", () => {
    render(<UserAvatar name="Ece Yılmaz" src={A} />);
    load(img());
    render(<UserAvatar name="Ece Yılmaz" src={B} />);
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(host?.querySelector("img")).toBeNull();
    expect(host?.textContent).toBe("EY");
    render(<UserAvatar name="Ece Yılmaz" src="https://cdn.example/avatars/c.webp" />);
    expect(img().className).toContain("opacity-0");
  });
});
