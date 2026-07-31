// @vitest-environment jsdom
/**
 * The watch-party video picker, mounted for real (M20 wave 3).
 *
 * What only a mount can show, and all of it is about SPENDING or NOT spending a
 * shared daily search budget:
 *
 *  - a deployment with search off renders no search affordance at all, so there
 *    is no button whose whole job the server refuses (§35);
 *  - typing does not search — only Enter or the button does;
 *  - a pasted LINK never searches, it submits, so the common case is free;
 *  - the three refusals produce three DIFFERENT sentences, because two of them
 *    do not clear today and one may clear in a minute;
 *  - a picked result is rendered as text and passes its metadata through.
 */
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage } from "@demli/i18n";
import type { i18n as I18n } from "i18next";
import {
  IDLE_WATCH_SEARCH,
  WatchVideoPicker,
  type WatchPickerResult,
  type WatchPickerSearchState,
} from "./WatchVideoPicker";
import { mount, press } from "../test/dom";

const RESULTS: WatchPickerResult[] = [
  {
    videoId: "dQw4w9WgXcQ",
    title: "A perfectly ordinary video",
    channelTitle: "Some Channel",
    durationSeconds: 213,
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
  },
  {
    videoId: "aaaaaaaaaaa",
    title: "Another one",
    channelTitle: "Other Channel",
    durationSeconds: null,
    thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg",
  },
];

let i18n: I18n;

beforeEach(async () => {
  i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
});

interface RenderOptions {
  searchEnabled: boolean | null;
  search?: WatchPickerSearchState;
  onSearch?: (query: string) => void;
  onSubmit?: (input: {
    videoRef: string;
    title?: string;
    durationSeconds?: number;
  }) => void;
  mode?: "start" | "change" | "queue";
}

function renderPicker(options: RenderOptions): void {
  mount(
    <I18nextProvider i18n={i18n}>
      <WatchVideoPicker
        open
        onOpenChange={() => undefined}
        mode={options.mode ?? "queue"}
        searchEnabled={options.searchEnabled}
        search={options.search ?? IDLE_WATCH_SEARCH}
        onSearch={options.onSearch ?? (() => undefined)}
        onResetSearch={() => undefined}
        onSubmit={options.onSubmit ?? (() => undefined)}
      />
    </I18nextProvider>,
  );
}

function field(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("the picker rendered no input");
  return input;
}

/** Type into the controlled input the way React's onChange expects. */
function type(value: string): void {
  const input = field();
  press(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(): void {
  press(() => {
    field().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

function searchButton(): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Search",
    ) ?? null
  );
}

describe("WatchVideoPicker — search off means no search box", () => {
  it("renders no search button when the deployment has search disabled", () => {
    renderPicker({ searchEnabled: false });
    expect(searchButton()).toBeNull();
    // …and the field asks for the thing that DOES work.
    expect(field().getAttribute("placeholder")).toBe("https://www.youtube.com/watch?v=…");
    expect(field().getAttribute("aria-label")).toBe("YouTube link");
  });

  it("renders no search button while capabilities are still loading", () => {
    // `null` is "not yet" — the affordance must appear once, not flicker in.
    renderPicker({ searchEnabled: null });
    expect(searchButton()).toBeNull();
  });

  it("renders the search box when the deployment can search", () => {
    renderPicker({ searchEnabled: true });
    expect(searchButton()).not.toBeNull();
    expect(field().getAttribute("placeholder")).toBe("Search YouTube, or paste a link");
  });

  it("never searches when search is off — an unparseable string is a bad link", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: false, onSearch });
    type("cat videos");
    pressEnter();
    expect(onSearch).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "not a YouTube video link",
    );
  });
});

describe("WatchVideoPicker — the quota is spent deliberately or not at all", () => {
  it("does NOT search while typing", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: true, onSearch });
    type("c");
    type("ca");
    type("cat");
    type("cat videos");
    // Four keystrokes, zero requests. A debounce would still have fired one per
    // pause; the rule here is stricter than a debounce on purpose.
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("searches on Enter", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: true, onSearch });
    type("cat videos");
    pressEnter();
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("cat videos");
  });

  it("searches on the button", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: true, onSearch });
    type("cat videos");
    press(() => searchButton()?.click());
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("cat videos");
  });

  it("does not re-search an unchanged query — a second Enter is free", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: true, onSearch });
    type("cat videos");
    pressEnter();
    pressEnter();
    pressEnter();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("searches again once the query actually changed", () => {
    const onSearch = vi.fn();
    renderPicker({ searchEnabled: true, onSearch });
    type("cats");
    pressEnter();
    type("dogs");
    pressEnter();
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch).toHaveBeenLastCalledWith("dogs");
  });

  it("a pasted LINK submits without spending a search", () => {
    const onSearch = vi.fn();
    const onSubmit = vi.fn();
    renderPicker({ searchEnabled: true, onSearch, onSubmit });
    type("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    pressEnter();
    expect(onSearch).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      videoRef: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("a bare video id is a link too, and also costs nothing", () => {
    const onSearch = vi.fn();
    const onSubmit = vi.fn();
    renderPicker({ searchEnabled: true, onSearch, onSubmit });
    type("dQw4w9WgXcQ");
    pressEnter();
    expect(onSearch).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ videoRef: "dQw4w9WgXcQ" });
  });

  it("an empty field does nothing at all", () => {
    const onSearch = vi.fn();
    const onSubmit = vi.fn();
    renderPicker({ searchEnabled: true, onSearch, onSubmit });
    pressEnter();
    expect(onSearch).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("WatchVideoPicker — three refusals, three sentences", () => {
  const failureCopy = (failure: "disabled" | "quota" | "unavailable" | "unknown"): string => {
    renderPicker({
      searchEnabled: true,
      search: { status: "error", query: "cats", results: [], failure },
    });
    return document.querySelector("[role='alert']")?.textContent ?? "";
  };

  it("says search is off for this server, permanently", () => {
    expect(failureCopy("disabled")).toContain("Video search is off on this server");
  });

  it("says the day's searches are used up, and that it resets", () => {
    const copy = failureCopy("quota");
    expect(copy).toContain("Today's searches are used up");
    // The user needs to know this one clears — otherwise it reads like "disabled".
    expect(copy).toContain("resets overnight");
  });

  it("says it is temporary and worth retrying", () => {
    const copy = failureCopy("unavailable");
    expect(copy).toContain("not answering right now");
    expect(copy).toContain("Try again shortly");
  });

  it("gives all four DISTINCT copy", () => {
    const copies = [
      failureCopy("disabled"),
      failureCopy("quota"),
      failureCopy("unavailable"),
      failureCopy("unknown"),
    ];
    expect(new Set(copies).size).toBe(4);
    for (const copy of copies) expect(copy.length).toBeGreaterThan(0);
  });

  it("every refusal still points at the path that works", () => {
    for (const failure of ["disabled", "quota", "unavailable", "unknown"] as const) {
      expect(failureCopy(failure).toLowerCase()).toContain("link");
    }
  });
});

describe("WatchVideoPicker — results", () => {
  const withResults: WatchPickerSearchState = {
    status: "done",
    query: "cats",
    results: RESULTS,
    failure: null,
  };

  it("lists each hit with its channel and duration", () => {
    renderPicker({ searchEnabled: true, search: withResults });
    const text = document.body.textContent ?? "";
    expect(text).toContain("A perfectly ordinary video");
    expect(text).toContain("Some Channel");
    expect(text).toContain("3:33"); // 213s
    // The second hit has no duration: its line is the channel alone.
    expect(text).toContain("Other Channel");
  });

  it("loads covers from the thumbnail host the CSP allows", () => {
    renderPicker({ searchEnabled: true, search: withResults });
    const sources = [...document.querySelectorAll("img")].map((node) => node.getAttribute("src"));
    expect(sources.length).toBe(RESULTS.length);
    for (const src of sources) expect(src).toMatch(/^https:\/\/i\.ytimg\.com\//);
  });

  it("picking a hit submits its id, title and duration", () => {
    const onSubmit = vi.fn();
    renderPicker({ searchEnabled: true, search: withResults, onSubmit });
    const row = [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("A perfectly ordinary video"),
    );
    press(() => row?.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      videoRef: "dQw4w9WgXcQ",
      title: "A perfectly ordinary video",
      durationSeconds: 213,
    });
  });

  it("omits durationSeconds entirely when it is unknown", () => {
    const onSubmit = vi.fn();
    renderPicker({ searchEnabled: true, search: withResults, onSubmit });
    const row = [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Another one"),
    );
    press(() => row?.click());
    // Not `durationSeconds: null` — the schema takes a number or nothing, and a
    // fabricated 0 would render as a real duration.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      videoRef: "aaaaaaaaaaa",
      title: "Another one",
    });
  });

  it("renders a hostile result title as literal text", () => {
    renderPicker({
      searchEnabled: true,
      search: {
        status: "done",
        query: "x",
        results: [
          {
            videoId: "bbbbbbbbbbb",
            title: '<img src=x onerror="alert(1)">',
            channelTitle: "<script>alert(2)</script>",
            durationSeconds: 5,
            thumbnailUrl: "https://i.ytimg.com/vi/bbbbbbbbbbb/mqdefault.jpg",
          },
        ],
        failure: null,
      },
    });
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelectorAll("script").length).toBe(0);
    // Only the ONE cover image the component itself renders.
    expect(document.querySelectorAll("img").length).toBe(1);
  });

  it("says so when a search came back with nothing", () => {
    renderPicker({
      searchEnabled: true,
      search: { status: "done", query: "asdkjhasd", results: [], failure: null },
    });
    expect(document.body.textContent).toContain('No results for "asdkjhasd"');
  });

  it("disables the search button while a search is in flight", () => {
    renderPicker({
      searchEnabled: true,
      search: { status: "searching", query: "cats", results: [], failure: null },
    });
    type("cats");
    expect(searchButton()?.hasAttribute("disabled")).toBe(true);
  });
});

describe("WatchVideoPicker — the DRM limit is stated where it is asked", () => {
  it("keeps the Netflix/Disney+ note on every mode", () => {
    for (const mode of ["start", "change", "queue"] as const) {
      renderPicker({ searchEnabled: true, mode });
      expect(document.body.textContent).toContain("Netflix");
    }
  });

  it("names the verb for the mode it is serving", () => {
    renderPicker({ searchEnabled: true, mode: "queue" });
    expect(document.body.textContent).toContain("Add a video to the queue");
  });
});
