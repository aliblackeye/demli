import { describe, expect, it } from "vitest";
import { authScreenRootClass } from "./authScreenLayout";

/**
 * Regression guard for the P0 "Hesap ekle çalışmıyor" bug (ADR 0013).
 *
 * The add-account AuthScreen renders as a SIBLING of the running <AppShell/>, so
 * its root MUST be a covering overlay (`fixed inset-0`). When it was an in-flow
 * `h-screen` block it got clipped by `#root { overflow:hidden }` and vanished on
 * both desktop and web. These assertions lock that contract in.
 */
describe("authScreenRootClass", () => {
  it("makes the add-account variant a covering, out-of-flow overlay", () => {
    const cls = authScreenRootClass("add");
    expect(cls).toContain("fixed");
    expect(cls).toContain("inset-0");
    // Must NOT rely on an in-flow height — that was the clipped-off-screen bug.
    expect(cls).not.toContain("h-screen");
    // Sits above the app shell + its dialogs (z-40/z-50) yet below the call ring
    // / critical-update / switching overlays (z-[100]).
    expect(cls).toContain("z-[60]");
  });

  it("keeps the primary sign-in gate as a normal full-height block", () => {
    const cls = authScreenRootClass("primary");
    expect(cls).toContain("h-screen");
    expect(cls).not.toContain("fixed");
    expect(cls).not.toContain("inset-0");
  });

  it("shares the same centering + surface styling across both variants", () => {
    for (const variant of ["primary", "add"] as const) {
      const classes = authScreenRootClass(variant).split(/\s+/);
      expect(classes).toContain("flex");
      // SAFE centring: centred while the form fits, never clipped above the
      // viewport when it does not (the register form on a short window).
      expect(classes).toContain("items-center-safe");
      expect(classes).toContain("overflow-y-auto");
      expect(classes).toContain("justify-center");
      // An OPAQUE token surface — the add overlay must hide the running app.
      // (Koyu Masa page tone; was bg-app before the M16 surface pass.)
      expect(classes).toContain("bg-rail");
    }
  });
});
