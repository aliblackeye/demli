// @vitest-environment jsdom
/**
 * The queue panel, mounted for real (M20 wave 3).
 *
 * A pure test of `moveQueueItem` proves the arithmetic and nothing about the
 * panel. What only a mount can show:
 *
 *  - a viewer SEES the queue and gets no mutation control — the §35 rule of this
 *    feature, and the one a refactor is most likely to break by swapping an
 *    omission for a `disabled` prop;
 *  - the queue is reorderable with the KEYBOARD, i.e. the move buttons are real
 *    focusable buttons and not a drag-only affordance;
 *  - a queued title is rendered as TEXT, so a title containing markup stays a
 *    string on screen;
 *  - the callbacks carry `itemId`, not an index.
 */
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// lucide-react resolves its own react copy under the hoisted layout (see
// ../test/dom); every icon becomes an empty <svg>.
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
import { WatchQueuePanel, type WatchQueueEntry } from "./WatchQueuePanel";
import { mount, press } from "../test/dom";

const ITEMS: WatchQueueEntry[] = [
  {
    itemId: "item-a",
    videoId: "aaaaaaaaaaa",
    title: "First video",
    durationSeconds: 253,
    addedByName: "Ali",
  },
  {
    itemId: "item-b",
    videoId: "bbbbbbbbbbb",
    title: "Second video",
    durationSeconds: null,
    addedByName: "Burak",
  },
  {
    itemId: "item-c",
    videoId: "ccccccccccc",
    title: "Third video",
    durationSeconds: 3725,
    addedByName: "Mert",
  },
];

let i18n: I18n;

beforeEach(async () => {
  i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
});

interface Handlers {
  onPlayNow?: (itemId: string) => void;
  onRemove?: (itemId: string) => void;
  onReorder?: (itemIds: string[]) => void;
  onAdd?: () => void;
}

function renderPanel(
  options: {
    canControl: boolean;
    items?: WatchQueueEntry[];
    notice?: string | null;
  } & Handlers,
): void {
  mount(
    <I18nextProvider i18n={i18n}>
      <WatchQueuePanel
        items={options.items ?? ITEMS}
        nowPlaying={{ videoId: "nownownownw", title: "Playing right now" }}
        canControl={options.canControl}
        onPlayNow={options.onPlayNow ?? (() => undefined)}
        onRemove={options.onRemove ?? (() => undefined)}
        onReorder={options.onReorder ?? (() => undefined)}
        onAdd={options.onAdd ?? (() => undefined)}
        notice={options.notice ?? null}
      />
    </I18nextProvider>,
  );
}

/** Every button in the panel, by its accessible name. */
function buttonLabels(): string[] {
  return [...document.querySelectorAll("button")].map(
    (node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "",
  );
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe("WatchQueuePanel — a viewer sees the queue but cannot change it", () => {
  it("renders every queued title for a viewer", () => {
    renderPanel({ canControl: false });
    const text = document.body.textContent ?? "";
    expect(text).toContain("First video");
    expect(text).toContain("Second video");
    expect(text).toContain("Third video");
    // …and what is playing now, which is the panel's other job.
    expect(text).toContain("Playing right now");
  });

  it("gives a viewer NO mutation control — not even a disabled one", () => {
    renderPanel({ canControl: false });
    // The absence is the assertion: §35 forbids a disabled twin, so a viewer's
    // panel must contain no move / play-now / remove / add button at all,
    // whether enabled or not.
    expect(buttonLabels()).toEqual([]);
    expect(document.querySelectorAll("button[disabled]").length).toBe(0);
  });

  it("does not make a viewer's rows draggable", () => {
    renderPanel({ canControl: false });
    const draggable = document.querySelectorAll("li[draggable='true']");
    expect(draggable.length).toBe(0);
  });

  it("gives the host the controls the viewer was denied", () => {
    renderPanel({ canControl: true });
    const labels = buttonLabels();
    expect(labels).toContain("Add a video to the queue");
    expect(labels).toContain("Play this now: First video");
    expect(labels).toContain("Remove from queue: First video");
    expect(document.querySelectorAll("li[draggable='true']").length).toBe(ITEMS.length);
  });
});

describe("WatchQueuePanel — reordering works without a mouse", () => {
  it("offers real move buttons, so drag-and-drop is not the only path", () => {
    renderPanel({ canControl: true });
    const up = buttonByLabel("Move up: Second video");
    const down = buttonByLabel("Move down: Second video");
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    // Focusable and activatable by keyboard: a real <button>, not a div with a
    // pointer handler.
    expect(up?.tagName).toBe("BUTTON");
    expect(up?.hasAttribute("disabled")).toBe(false);
  });

  it("moving up sends the full reordered id list", () => {
    const onReorder = vi.fn();
    renderPanel({ canControl: true, onReorder });
    press(() => buttonByLabel("Move up: Second video")?.click());
    expect(onReorder).toHaveBeenCalledWith(["item-b", "item-a", "item-c"]);
  });

  it("moving down sends the full reordered id list", () => {
    const onReorder = vi.fn();
    renderPanel({ canControl: true, onReorder });
    press(() => buttonByLabel("Move down: Second video")?.click());
    expect(onReorder).toHaveBeenCalledWith(["item-a", "item-c", "item-b"]);
  });

  it("omits the move button at each end rather than disabling it", () => {
    renderPanel({ canControl: true });
    const labels = buttonLabels();
    expect(labels).not.toContain("Move up: First video");
    expect(labels).not.toContain("Move down: Third video");
    // The other direction is still offered at each end.
    expect(labels).toContain("Move down: First video");
    expect(labels).toContain("Move up: Third video");
  });

  it("a keyboard reorder can walk an item from the back to the front", () => {
    // Two presses, each against the list the previous one produced — the panel
    // is controlled, so the caller re-renders it with the new order.
    const orders: string[][] = [];
    const onReorder = (itemIds: string[]): void => {
      orders.push(itemIds);
    };
    renderPanel({ canControl: true, onReorder });
    press(() => buttonByLabel("Move up: Third video")?.click());

    const reordered = orders[0]?.map(
      (id) => ITEMS.find((item) => item.itemId === id) as WatchQueueEntry,
    );
    renderPanel({ canControl: true, items: reordered, onReorder });
    press(() => buttonByLabel("Move up: Third video")?.click());

    expect(orders[0]).toEqual(["item-a", "item-c", "item-b"]);
    expect(orders[1]).toEqual(["item-c", "item-a", "item-b"]);
  });
});

describe("WatchQueuePanel — operations name the item, not its position", () => {
  it("play-now reports the itemId", () => {
    const onPlayNow = vi.fn();
    renderPanel({ canControl: true, onPlayNow });
    press(() => buttonByLabel("Play this now: Third video")?.click());
    expect(onPlayNow).toHaveBeenCalledWith("item-c");
  });

  it("remove reports the itemId", () => {
    const onRemove = vi.fn();
    renderPanel({ canControl: true, onRemove });
    press(() => buttonByLabel("Remove from queue: Second video")?.click());
    expect(onRemove).toHaveBeenCalledWith("item-b");
  });

  it("the SAME id is reported after the list shifted underneath it", () => {
    // An auto-advance consumed the head between renders. A panel that reported
    // positions would now remove the wrong video.
    const onRemove = vi.fn();
    renderPanel({ canControl: true, items: ITEMS.slice(1), onRemove });
    press(() => buttonByLabel("Remove from queue: Third video")?.click());
    expect(onRemove).toHaveBeenCalledWith("item-c");
  });
});

describe("WatchQueuePanel — untrusted text", () => {
  it("renders a title containing markup as literal text", () => {
    const hostile = '<img src=x onerror="alert(1)">bad<script>alert(2)</script>';
    renderPanel({
      canControl: true,
      items: [
        {
          itemId: "item-x",
          videoId: "xxxxxxxxxxx",
          title: hostile,
          durationSeconds: 10,
          addedByName: "Someone",
        },
      ],
    });
    // The string is on screen, verbatim…
    expect(document.body.textContent).toContain(hostile);
    // …and nothing it named became a node.
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelectorAll("script").length).toBe(0);
  });

  it("renders a hostile adder name as text too", () => {
    renderPanel({
      canControl: false,
      items: [
        {
          itemId: "item-y",
          videoId: "yyyyyyyyyyy",
          title: "Fine title",
          durationSeconds: null,
          addedByName: "<script>alert(3)</script>",
        },
      ],
    });
    expect(document.querySelectorAll("script").length).toBe(0);
    expect(document.body.textContent).toContain("<script>alert(3)</script>");
  });

  it("falls back to a placeholder when a queued item has no title", () => {
    renderPanel({
      canControl: false,
      items: [
        {
          itemId: "item-z",
          videoId: "zzzzzzzzzzz",
          title: null,
          durationSeconds: null,
          addedByName: "Ali",
        },
      ],
    });
    // Never the raw 11-character id — that is not a name a human can read.
    expect(document.body.textContent).toContain("Untitled video");
    expect(document.body.textContent).not.toContain("zzzzzzzzzzz");
  });
});

describe("WatchQueuePanel — states", () => {
  it("shows a full-queue notice to whoever hit it", () => {
    renderPanel({
      canControl: true,
      notice: "The queue is full (50 videos max). Remove one to add another.",
    });
    const alert = document.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("The queue is full");
  });

  it("tells a host and a viewer different things about an empty queue", () => {
    renderPanel({ canControl: true, items: [] });
    const hostCopy = document.body.textContent ?? "";
    renderPanel({ canControl: false, items: [] });
    const viewerCopy = document.body.textContent ?? "";

    // The host is told how to fill it; the viewer is told whose job that is.
    expect(hostCopy).toContain("Press + to line up what plays next.");
    expect(viewerCopy).toContain("The host picks what plays next.");
    expect(hostCopy).not.toBe(viewerCopy);
  });

  it("shows the queue length", () => {
    renderPanel({ canControl: false });
    expect(document.body.textContent).toContain(String(ITEMS.length));
  });

  it("formats a known duration and shows nothing for an unknown one", () => {
    renderPanel({ canControl: false });
    const text = document.body.textContent ?? "";
    expect(text).toContain("4:13"); // 253s
    expect(text).toContain("1:02:05"); // 3725s
    // "Second video" has no duration: its row carries the adder and no clock.
    expect(text).toContain("added by Burak");
  });
});
