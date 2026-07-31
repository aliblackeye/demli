import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The narrow-viewport dialog rules, asserted against the CSS source.
 *
 * Not a stylistic preference — this file is the ONLY place the behaviour
 * exists. jsdom applies no stylesheet, evaluates no media query and has no
 * layout, so no render test in the workspace can reach these declarations, and
 * a screenshot cannot see the three that matter most:
 *
 *   - the `dvh`-after-`vh` pair. Delete the `vh` line and Safari 12 (an
 *     apps/web hard target, plugin-legacy) has no height cap at all; delete the
 *     `dvh` line and every phone gets a sheet measured against a viewport with
 *     the address bar collapsed — i.e. a footer you cannot reach.
 *   - the safe-area insets. A close button under the notch is a dialog you
 *     cannot dismiss.
 *   - `max-width: none`. Without it a `max-w-2xl` call site stays pinned
 *     mid-screen on a 375px phone, which is the bug this whole change fixes.
 *
 * Markup side (that DialogContent still emits the hooks these rules key on):
 * packages/app-ui/src/components/Dialog.responsive.test.tsx.
 */
const GLOBALS_CSS = readFileSync(
  fileURLToPath(new URL("./globals.css", import.meta.url)),
  "utf8",
);

/**
 * The `@media (max-width: 899px)` block, brace-matched so an assertion cannot
 * accidentally pass on some unrelated rule elsewhere in a 700-line stylesheet.
 */
function narrowBlock(): string {
  const start = GLOBALS_CSS.indexOf("@media (max-width: 899px)");
  expect(start, "the narrow-viewport dialog media query must exist").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = GLOBALS_CSS.indexOf("{", start); i < GLOBALS_CSS.length; i += 1) {
    if (GLOBALS_CSS[i] === "{") depth += 1;
    else if (GLOBALS_CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return GLOBALS_CSS.slice(start, i + 1);
    }
  }
  throw new Error("unterminated media query");
}

describe("narrow-viewport dialog stylesheet", () => {
  it("stays below the shell's own mobile breakpoint", () => {
    // 899 = MOBILE_MAX_WIDTH (hooks/useMediaQuery.ts) and sits under Electron's
    // 940px window minimum, so the installed desktop app can never reach these
    // rules however small the founder drags the window.
    expect(GLOBALS_CSS).toContain("@media (max-width: 899px)");
  });

  it("caps height with dvh and keeps a vh fallback for Safari 12", () => {
    const block = narrowBlock();
    const vh = block.indexOf("max-height: calc(100vh");
    const dvh = block.indexOf("max-height: calc(100dvh");
    expect(vh, "100vh fallback missing — Safari 12 has no dvh").toBeGreaterThan(-1);
    expect(dvh, "100dvh missing — 100vh alone lies under a mobile address bar").toBeGreaterThan(-1);
    // Order IS the fallback: an engine that understands dvh must see it LAST.
    expect(dvh).toBeGreaterThan(vh);
  });

  it("respects the notch and the home indicator", () => {
    const block = narrowBlock();
    expect(block).toContain("env(safe-area-inset-top");
    expect(block).toContain("padding-bottom: env(safe-area-inset-bottom");
    // The close button re-applies the right inset itself: absolute offsets are
    // measured from the padding box, so the card's own padding does not move it.
    expect(block).toMatch(/\.dialog-sheet-close\s*\{[^}]*env\(safe-area-inset-right/);
  });

  it("gives the close button a real thumb target", () => {
    expect(narrowBlock()).toMatch(/\.dialog-sheet-close\s*\{[^}]*min-height:\s*2\.75rem/);
  });

  it("lets the sheet grow by CONTENT height, not by a per-call-site prop", () => {
    const block = narrowBlock();
    // `height:auto` + a viewport cap = short content stays a small sheet, tall
    // content becomes the page. This pair IS the founder's rule, and it is why
    // 29 call sites needed no change.
    expect(block).toContain("height: auto");
    // Full-bleed: overrides the base `max-w-md` AND every call-site width.
    expect(block).toContain("max-width: none");
    // Undoes the desktop centering so the sheet grows off the bottom edge.
    // BOTH properties, and this pair is load-bearing: Tailwind v4 compiles
    // `-translate-x-1/2` to the standalone `translate` property, so clearing
    // only `transform` leaves the sheet shifted half its width off-screen.
    expect(block).toContain("translate: none");
    expect(block).toContain("transform: none");
  });

  it("keeps the inner scroll region from chaining into the page behind it", () => {
    expect(narrowBlock()).toMatch(/\.dialog-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it("slides the sheet instead of popping it, on BOTH Radix states", () => {
    const block = narrowBlock();
    expect(block).toMatch(/\.dialog-sheet\[data-state="open"\][^}]*sheet-in/);
    // Radix holds the closed node mounted until its animation ends. Without a
    // closed-state rule the sheet would replay the ENTER animation on dismiss.
    expect(block).toMatch(/\.dialog-sheet\[data-state="closed"\][^}]*sheet-out/);
    expect(GLOBALS_CSS).toContain("@keyframes sheet-in");
    expect(GLOBALS_CSS).toContain("@keyframes sheet-out");
  });

  it("leaves the wide-viewport card alone", () => {
    // Every narrow declaration lives inside the media query. If one leaks out,
    // the desktop app's centered dialogs change shape.
    const block = narrowBlock();
    const outside = GLOBALS_CSS.replace(block, "");
    expect(outside).not.toContain(".dialog-sheet {");
    expect(outside).not.toContain(".dialog-sheet-close {");
  });
});
