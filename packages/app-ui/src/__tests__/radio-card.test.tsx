// @vitest-environment jsdom
/**
 * RadioCard — the preset-card shape of a RadioGroup option (M16 Dalga 3:
 * quality tiers, frame rates, channel type, bitrate). It must keep the SAME
 * group contract as RadioItem — one tab stop, arrows move AND select, disabled
 * options skipped — and draw selection as a shape change (inner trace), not
 * colour alone.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// lucide-react resolves its own React copy under the hoisted layout — see the
// sibling DOM tests. Icons are decoration here.
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { RadioCard, RadioGroup, RadioItem } from "@demli/ui";
import { mount, press } from "../test/dom";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const radios = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
const checked = (): string | undefined =>
  radios().find((r) => r.getAttribute("aria-checked") === "true")?.dataset.value;
const key = (target: Element, k: string): void =>
  press(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });

function renderCards(onChange?: (v: string) => void): void {
  cleanup = mount(
    <RadioGroup aria-label="Çözünürlük" defaultValue="720p" onValueChange={onChange} className="grid grid-cols-4">
      <RadioCard value="480p" label="480p" detail="~1 Mbps" data-value="480p" />
      <RadioCard value="720p" label="720p" detail="~2.5 Mbps" data-value="720p" />
      <RadioCard value="1080p" label="1080p" detail="~4 Mbps" data-value="1080p" disabled />
      <RadioCard value="1440p" label="2K" detail="~8 Mbps" data-value="1440p" />
    </RadioGroup>,
  ).unmount;
}

describe("RadioCard", () => {
  it("is a single tab stop on the selected card", () => {
    renderCards();
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("arrows move and select, skipping a disabled card; reports the value", () => {
    const changes: string[] = [];
    renderCards((v) => changes.push(v));
    key(radios()[1] as HTMLElement, "ArrowRight");
    expect(checked()).toBe("1440p");
    expect(document.activeElement).toBe(radios()[3]);
    key(radios()[3] as HTMLElement, "Home");
    expect(checked()).toBe("480p");
    expect(changes).toEqual(["1440p", "480p"]);
  });

  it("marks selection with an inner trace, not colour alone", () => {
    renderCards();
    const selected = radios()[1] as HTMLElement;
    const other = radios()[0] as HTMLElement;
    expect(selected.className).toContain("shadow-[inset_0_0_0_1px");
    expect(other.className).not.toContain("shadow-[inset_0_0_0_1px");
  });

  it("shares one group with RadioItem rows", () => {
    cleanup = mount(
      <RadioGroup aria-label="Tür" defaultValue="text">
        <RadioCard value="text" label="Metin" data-value="text" />
        <RadioItem value="voice" label="Ses" data-value="voice" />
      </RadioGroup>,
    ).unmount;
    key(radios()[0] as HTMLElement, "ArrowDown");
    expect(checked()).toBe("voice");
  });
});
