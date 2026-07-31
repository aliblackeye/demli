/**
 * Guards the two properties that make the mobile theme trustworthy:
 *
 *  1. PARITY — every colour in `theme.ts` is byte-for-byte the desktop/web value
 *     from packages/app-ui/src/tokens.css. That file is the single source; this
 *     test is what stops the RN copy from quietly drifting, which is exactly how
 *     the app ended up with a stale blurple and a pre-Catppuccin gray hiding in
 *     components.
 *
 *  2. CONTRAST — the "Demli Voice v2" accent is a LIGHT orange, which inverts the
 *     usual dark-UI reflex that foreground text is the pale one. Rather than
 *     eyeballing it, the ratios are computed from the token values here, so a
 *     future palette edit that makes text unreadable fails the build.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { colors } from "../theme";

/**
 * Walk up from the vitest cwd (apps/mobile) to the repo root and find the
 * single-source stylesheet. Resolved by search rather than a fixed `../../../..`
 * chain so moving this test file cannot silently break the guard.
 */
function findTokensCss(): string {
  const relative = "packages/app-ui/src/tokens.css";
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find ${relative} above ${process.cwd()}`);
    dir = parent;
  }
}

/** Pull the `--tc-*` custom properties out of the single-source stylesheet. */
function desktopTokens(): Record<string, string> {
  const css = readFileSync(findTokensCss(), "utf8");
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/--tc-([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) out[name] = value.trim();
  }
  return out;
}

/** `rgba(248, 238, 212, 0.09)` and `rgba(248,238,212,0.09)` are the same colour. */
function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

// mobile token name -> desktop `--tc-*` token name
const PARITY: ReadonlyArray<readonly [keyof typeof colors, string]> = [
  ["rail", "rail"],
  ["sidebar", "sidebar"],
  ["app", "app"],
  ["surface", "surface"],
  ["surfaceRaised", "raised"],
  ["overlay", "overlay"],
  ["selected", "selected"],
  ["hover", "hover"],
  ["stroke", "stroke"],
  ["strokeStrong", "stroke-strong"],
  ["fg", "fg"],
  ["fgMuted", "fg-muted"],
  ["fgFaint", "fg-faint"],
  ["accent", "accent"],
  ["accentPressed", "accent-hover"],
  ["accentHover", "accent-hover"],
  ["onAccent", "on-accent"],
  ["accentSurface", "accent-surface"],
  ["danger", "danger"],
  ["dangerSurface", "danger-surface"],
  ["success", "success"],
  ["warning", "warning"],
  ["online", "online"],
  ["idle", "idle"],
  ["dnd", "dnd"],
  ["offline", "offline"],
];

describe("palette parity with the desktop/web token source", () => {
  const tokens = desktopTokens();

  it("reads the single-source stylesheet", () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(20);
  });

  it.each(PARITY)("colors.%s matches --tc-%s", (mobileKey, cssKey) => {
    expect(tokens[cssKey]).toBeDefined();
    expect(normalize(colors[mobileKey])).toBe(normalize(tokens[cssKey] as string));
  });
});

/** sRGB channel -> linear light, per WCAG 2.x. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast", () => {
  // Text on the app backdrop. AA body text is 4.5:1; the faint step is only ever
  // used for de-emphasised meta, so it is held to the 3:1 large/incidental bar.
  it.each([
    ["fg", colors.fg, 7],
    ["fgMuted", colors.fgMuted, 4.5],
    ["fgFaint", colors.fgFaint, 3],
  ])("%s reads on the app backdrop", (_name, fg, min) => {
    expect(contrast(fg, colors.app)).toBeGreaterThanOrEqual(min);
  });

  it("muted text still reads on the darkest and lightest surfaces", () => {
    expect(contrast(colors.fgMuted, colors.rail)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.fgMuted, colors.overlay)).toBeGreaterThanOrEqual(4.5);
  });

  // The whole point of `onAccent`: every LIGHT fill in the palette takes dark ink.
  it.each([
    ["accent", colors.accent],
    ["accentPressed", colors.accentPressed],
    ["danger", colors.danger],
    ["success", colors.success],
    ["warning", colors.warning],
    ["online", colors.online],
    ["idle", colors.idle],
    ["dnd", colors.dnd],
  ])("onAccent ink reads on the %s fill", (_name, fill) => {
    expect(contrast(colors.onAccent, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("cream foreground would NOT read on the accent — this is why onAccent exists", () => {
    expect(contrast(colors.fg, colors.accent)).toBeLessThan(3);
  });

  it("accent used as a foreground still reads on dark surfaces", () => {
    expect(contrast(colors.accent, colors.app)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.accent, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
