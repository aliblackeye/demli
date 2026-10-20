// @vitest-environment jsdom
/**
 * UnsavedChangesBar nudge: a refused leave must not cost a keyboard user their
 * focus, and the reason must be announced by UPDATING the live region — not by
 * re-inserting it (screen readers may skip a freshly inserted region). The bar
 * used to replay its shake by re-keying the element that held both the live
 * region and the Save/Reset buttons, which remounted all of them.
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { UnsavedChangesBar } from "./settings-kit";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const render = (nudge: number): void =>
  act(() =>
    root.render(
      createElement(UnsavedChangesBar, {
        open: true,
        saving: false,
        nudge,
        message: "unsaved",
        nudgeMessage: "save or reset first",
        resetLabel: "reset",
        saveLabel: "save",
        onReset: () => undefined,
        onSave: () => undefined,
      }),
    ),
  );

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("UnsavedChangesBar — a nudge keeps focus and updates the live region in place", () => {
  it("the focused Save button and the live region survive the nudge and its end", () => {
    render(0);
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "save")!;
    const live = host.querySelector('[aria-live="polite"]')!;
    save.focus();
    expect(document.activeElement).toBe(save);
    expect(live.textContent).toBe("unsaved");

    render(1);
    expect(document.activeElement).toBe(save);
    expect(host.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toBe("save or reset first");
    expect(host.querySelector("[data-unsaved-bar]")?.getAttribute("data-alert")).toBe("true");

    act(() => vi.advanceTimersByTime(1900));
    expect(document.activeElement).toBe(save);
    expect(host.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toBe("unsaved");

    // A second refusal works the same way.
    render(2);
    expect(document.activeElement).toBe(save);
    expect(live.textContent).toBe("save or reset first");
  });
});
