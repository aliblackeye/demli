// @vitest-environment jsdom
/**
 * MARKUP half of the responsive-dialog contract: a real Radix mount proving the
 * shared card still emits the hooks the stylesheet keys on, and — the part that
 * would silently rot — that a call site's own width class survives alongside
 * them. `cn()` is tailwind-merge, which DROPS an earlier conflicting utility;
 * get the argument order wrong and every `max-w-2xl` dialog quietly shrinks back
 * to `max-w-md` on desktop.
 *
 * The other half is CSS that jsdom cannot evaluate (no stylesheet, no media
 * query, no layout), so it is asserted against the source where it lives:
 * apps/desktop/src/renderer/src/styles/dialog-sheet.test.ts.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// lucide-react resolves its own React copy under the hoisted layout — see the
// sibling DOM tests. The close button's X is decoration here.
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { Dialog, DialogBody, DialogContent, DialogTitle } from "@demli/ui";
import { mount } from "../test/dom";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function open(className?: string): HTMLElement {
  const mounted = mount(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Title</DialogTitle>
        <DialogBody>body</DialogBody>
      </DialogContent>
    </Dialog>,
  );
  cleanup = mounted.unmount;
  const card = document.querySelector<HTMLElement>('[role="dialog"]');
  if (card === null) throw new Error("dialog did not render");
  return card;
}

describe("DialogContent markup", () => {
  it("carries the responsive hooks the stylesheet keys on", () => {
    const card = open();
    expect(card.className).toContain("dialog-sheet");
    expect(
      document.querySelector('[aria-label="Close"]')?.className,
      "the close button must stay reachable/thumb-sized on a phone",
    ).toContain("dialog-sheet-close");
  });

  it("keeps the wide-viewport geometry untouched", () => {
    const card = open();
    // The desktop card is exactly what it was: centered, capped at 85vh.
    for (const utility of ["fixed", "left-1/2", "top-1/2", "max-h-[85vh]", "max-w-md"]) {
      expect(card.className).toContain(utility);
    }
  });

  it("does NOT let the responsive hook eat a call site's own width", () => {
    // tailwind-merge keeps the LAST of two conflicting utilities: a call-site
    // `max-w-2xl` must still beat the base `max-w-md` on a desktop viewport.
    const card = open("max-w-2xl");
    expect(card.className).toContain("max-w-2xl");
    expect(card.className).not.toContain("max-w-md");
    expect(card.className).toContain("dialog-sheet");
  });

  it("marks the body as the sheet's scroll surface and stops scroll chaining", () => {
    open();
    const body = document.querySelector<HTMLElement>(".dialog-scroll");
    expect(body).not.toBeNull();
    expect(body?.className).toContain("overscroll-contain");
    expect(body?.className).toContain("overflow-y-auto");
  });
});

