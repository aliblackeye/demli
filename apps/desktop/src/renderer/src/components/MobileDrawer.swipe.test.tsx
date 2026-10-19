// @vitest-environment jsdom
/**
 * Swipe-to-close on the narrow web drawer. It used to read pointer events, but a
 * real phone browser claims a moving finger as a pan and fires `pointercancel`,
 * so `pointerup` never came and the drawer stayed open (audit: CDP touch probe).
 * It now reads touch events, which keep arriving through a browser pan. These
 * tests dispatch the same native event sequence a phone produces — including
 * the `pointercancel` in the middle — against the real component.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileDrawer } from "./MobileDrawer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(side: "left" | "right", onClose: () => void): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MobileDrawer side={side} open onClose={onClose} label="Gezinme">
        <nav style={{ overflowY: "auto" }}>
          <button type="button">#sohbet</button>
        </nav>
      </MobileDrawer>,
    );
  });
  const panel = host.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error("drawer panel not rendered");
  return panel;
}

interface Point {
  x: number;
  y: number;
}

/** A native touch event carrying one touch (jsdom has no `Touch` constructor). */
function touch(target: Element, type: "touchstart" | "touchend", at: Point, active: boolean): void {
  const point = { identifier: 7, clientX: at.x, clientY: at.y, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: active ? [point] : [] });
  Object.defineProperty(event, "targetTouches", { value: active ? [point] : [] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  act(() => {
    target.dispatchEvent(event);
  });
}

function pointerCancel(target: Element): void {
  act(() => {
    target.dispatchEvent(new Event("pointercancel", { bubbles: true }));
  });
}

/** The phone's sequence for a swipe: touchstart → (browser pan) pointercancel → touchend. */
function swipe(panel: HTMLElement, from: Point, to: Point): void {
  const inner = panel.querySelector("button") ?? panel;
  touch(inner, "touchstart", from, true);
  pointerCancel(inner);
  touch(inner, "touchend", to, false);
}

describe("MobileDrawer swipe-to-close", () => {
  it("closes the left drawer on a leftward swipe, even though the browser cancelled the pointer", () => {
    const onClose = vi.fn();
    const panel = mount("left", onClose);
    swipe(panel, { x: 220, y: 400 }, { x: 120, y: 410 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the right drawer on a rightward swipe", () => {
    const onClose = vi.fn();
    const panel = mount("right", onClose);
    swipe(panel, { x: 200, y: 300 }, { x: 300, y: 296 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for a vertical scroll of the channel list", () => {
    const onClose = vi.fn();
    const panel = mount("left", onClose);
    swipe(panel, { x: 200, y: 500 }, { x: 150, y: 260 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open for a short horizontal nudge under the threshold", () => {
    const onClose = vi.fn();
    const panel = mount("left", onClose);
    swipe(panel, { x: 200, y: 400 }, { x: 160, y: 402 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open for a swipe AWAY from the drawer's edge", () => {
    const onClose = vi.fn();
    const panel = mount("left", onClose);
    swipe(panel, { x: 100, y: 400 }, { x: 220, y: 400 });
    expect(onClose).not.toHaveBeenCalled();
  });
});
