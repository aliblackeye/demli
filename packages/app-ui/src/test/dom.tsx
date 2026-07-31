/**
 * The minimal DOM harness for app-ui's `// @vitest-environment jsdom` tests.
 *
 * Deliberately hand-rolled on `react-dom/client` + React 18's own `act` rather
 * than @testing-library/react: the monorepo hoists two React majors (packages/ui
 * pulls react-dom 19 for its own primitives), and a testing-library install
 * nests a SECOND react-dom copy, which makes every hook call throw
 * "Cannot read properties of null (reading 'useState')". Mounting through the
 * package's own react-dom keeps exactly one React instance in play.
 *
 * Scope: this exists for the small number of interaction bugs that pure logic
 * tests cannot see — Radix menus, popovers, focus restoration, the composer's
 * insert→serialize path. Model code stays in fast node-environment tests.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

declare global {
  // React 18 reads this to decide whether `act` is legal.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * Teach jsdom the handful of browser APIs Radix's popper/dismiss machinery calls
 * unconditionally. Without these a popover throws before the behaviour under
 * test is even reached. Each is `??=` so a real implementation always wins.
 */
export function installDomStubs(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  globalThis.DOMRect ??= class DOMRectStub {
    readonly top = 0;
    readonly left = 0;
    readonly right = 0;
    readonly bottom = 0;
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
    static fromRect(init?: DOMRectInit): DOMRectStub {
      return new DOMRectStub(init?.x, init?.y, init?.width, init?.height);
    }
    toJSON(): unknown {
      return {};
    }
  } as unknown as typeof DOMRect;

  // jsdom ships no PointerEvent; Radix menus/items listen for pointerdown/up.
  globalThis.PointerEvent ??= class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  } as unknown as typeof PointerEvent;

  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  // jsdom has no layout, so every rect is zero — enough for Radix's positioning.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  };
}

let warningSilenced = false;

/**
 * React warns about a `document.body` root because third-party scripts mutate
 * body in a real page. Here that is exactly the point (see {@link mount}), the
 * choice is deliberate, and the warning would otherwise drown the output of
 * every DOM test. Only this one message is dropped.
 */
function silenceBodyRootWarning(): void {
  if (warningSilenced) return;
  warningSilenced = true;
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === "string" && args[0].includes("Creating roots directly with document.body")) {
      return;
    }
    original(...args);
  };
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
}

/**
 * Mount a tree with `document.body` as the React ROOT container.
 *
 * The body — not a nested div — on purpose. React 18 delegates events to the
 * root container, and Radix portals its menus/popovers into `document.body`. A
 * nested root would leave every portalled node OUTSIDE the delegation root, so
 * React synthetic handlers inside a menu or popover would silently never fire.
 * That is not how the app behaves (its root is `#root`, and portals land inside
 * `<body>` alongside it, still reachable) — and a harness that drops portal
 * events invents dismiss bugs that do not exist.
 */
export function mount(element: ReactElement): Mounted {
  installDomStubs();
  silenceBodyRootWarning();
  // One root per body: a test that forgot to unmount must not leave React
  // warning about a container it already owns (or leak listeners into the next).
  if (activeRoot) {
    act(() => activeRoot?.unmount());
    activeRoot = null;
  }
  document.body.innerHTML = "";
  const root = createRoot(document.body);
  activeRoot = root;
  act(() => {
    root.render(element);
  });
  return {
    container: document.body,
    root,
    unmount: () => {
      act(() => root.unmount());
      if (activeRoot === root) activeRoot = null;
      document.body.innerHTML = "";
    },
  };
}

let activeRoot: Root | null = null;

/** Flush React work plus any `setTimeout(…, 0)` Radix scheduled (focus restore). */
export async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Run a synchronous interaction inside `act`. */
export function press(fn: () => void): void {
  act(() => {
    fn();
  });
}

/**
 * DEEPEST element in the document whose trimmed text equals `text` — deepest,
 * because every ancestor of a lone text node matches too, and dispatching a
 * click on the portal wrapper instead of the menu item silently does nothing.
 */
export function findByText(text: string, selector = "body *"): HTMLElement | null {
  let match: HTMLElement | null = null;
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (node.textContent?.trim() !== text) continue;
    if (!match || match.contains(node)) match = node;
  }
  return match;
}

/** The menu row carrying `text` (role-scoped, so it is never a portal wrapper). */
export function findMenuItem(text: string): HTMLElement | null {
  return findByText(text, "[role='menuitem'], [role='menuitemcheckbox']");
}

/** Dispatch a full mouse "activate" sequence Radix menu items listen for. */
export function clickMenuItem(node: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, button: 0 };
  node.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
  node.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
  node.dispatchEvent(new MouseEvent("click", opts));
}
