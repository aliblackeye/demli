/**
 * Guards the properties that make the mobile theme trustworthy:
 *
 *  1. PARITY — every colour, radius, motion step and spring in `theme.ts` is the
 *     value from packages/app-ui/src/tokens.css, which the desktop
 *     design-tokens test in turn locks to the desktop/web `@theme` block. This
 *     test is what stops the RN copy from quietly drifting.
 *
 *  2. CONTRAST — the Koyu Masa accent is a LIGHT coral, which inverts the usual
 *     dark-UI reflex that foreground text is the pale one. The ratios are
 *     computed from the token values, so a palette edit that makes text
 *     unreadable fails the build.
 *
 *  3. FONTS — every registered family has its file and licence on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findSpring } from "framer-motion";
import { describe, expect, it } from "vitest";
import { MOTION_PRESETS } from "../motion-presets";
import { colors, fontFamily, motion, radius, typography } from "../theme";

/**
 * Walk up from the vitest cwd (apps/mobile) to the repo root and find the
 * stylesheet. Resolved by search rather than a fixed `../../../..` chain so
 * moving this test file cannot silently break the guard.
 */
function findUp(relative: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find ${relative} above ${process.cwd()}`);
    dir = parent;
  }
}

/** Pull the `--tc-*` custom properties out of tokens.css. */
function desktopTokens(): Record<string, string> {
  const css = readFileSync(findUp("packages/app-ui/src/tokens.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/--tc-([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) out[name] = value.replace(/\s+/g, " ").trim();
  }
  return out;
}

/** `rgba(255, 255, 255, 0.08)` and `rgba(255,255,255,0.08)` are the same colour. */
function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

// mobile token name -> `--tc-*` token name
const PARITY: ReadonlyArray<readonly [keyof typeof colors, string]> = [
  ["rail", "rail"],
  ["sidebar", "sidebar"],
  ["app", "app"],
  ["surface", "surface"],
  ["surfaceRaised", "raised"],
  ["raisedHover", "raised-hover"],
  ["raisedPressed", "raised-pressed"],
  ["overlay", "overlay"],
  ["glass", "glass"],
  ["glassStrong", "glass-strong"],
  ["veil", "veil"],
  ["scrim", "scrim"],
  ["selected", "selected"],
  ["hover", "hover"],
  ["wash", "wash"],
  ["washStrong", "wash-strong"],
  ["stroke", "stroke"],
  ["strokeStrong", "stroke-strong"],
  ["fgDisplay", "fg-display"],
  ["fg", "fg"],
  ["fgMuted", "fg-muted"],
  ["fgFaint", "fg-faint"],
  ["fgSubtle", "fg-subtle"],
  ["inverse", "inverse"],
  ["inverseHover", "inverse-hover"],
  ["inversePressed", "inverse-pressed"],
  ["onInverse", "on-inverse"],
  ["accent", "accent"],
  ["accentPressed", "accent-hover"],
  ["accentHover", "accent-hover"],
  ["accentDeep", "accent-pressed"],
  ["onAccent", "on-accent"],
  ["accentSurface", "accent-surface"],
  ["accentGlow", "accent-glow"],
  ["danger", "danger"],
  ["dangerSurface", "danger-surface"],
  ["success", "success"],
  ["warning", "warning"],
  ["online", "online"],
  ["idle", "idle"],
  ["dnd", "dnd"],
  ["offline", "offline"],
];

const tokens = desktopTokens();
const px = (name: string): number => Number.parseFloat(tokens[name] as string);

describe("palette parity with tokens.css", () => {
  it("reads the token stylesheet", () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(40);
  });

  it.each(PARITY)("colors.%s matches --tc-%s", (mobileKey, cssKey) => {
    expect(tokens[cssKey]).toBeDefined();
    expect(normalize(colors[mobileKey])).toBe(normalize(tokens[cssKey] as string));
  });

  it("every colour token in tokens.css has a mobile counterpart", () => {
    const mirrored = new Set(PARITY.map(([, css]) => css));
    const colourTokens = Object.entries(tokens)
      .filter(([, value]) => /^(#|rgba?\()/.test(value))
      .map(([name]) => name)
      .filter((name) => name !== "selection");
    expect(colourTokens.filter((name) => !mirrored.has(name))).toEqual([]);
  });
});

describe("radius, type and motion parity", () => {
  it("radius steps", () => {
    expect(radius.sm).toBe(px("radius-sm"));
    expect(radius.md).toBe(px("radius-md"));
    expect(radius.lg).toBe(px("radius-lg"));
    expect(radius.xl).toBe(px("radius-xl"));
    expect(radius.cta).toBe(px("radius-cta"));
    expect(radius.card).toBe(px("radius-card"));
    expect(radius.panel).toBe(px("radius-panel"));
  });

  it("micro-typography (rem × 16)", () => {
    expect(typography.size["2xs"]).toBe(px("text-2xs") * 16);
    expect(typography.size.badge).toBe(px("text-badge") * 16);
    expect(typography.size["3xs"]).toBe(px("text-3xs") * 16);
    expect(typography.size.label).toBe(px("text-label") * 16);
  });

  it("durations", () => {
    for (const step of ["instant", "fast", "hover", "standard", "arrival"] as const) {
      expect(`${motion.duration[step]}ms`, step).toBe(tokens[`motion-duration-${step}`]);
    }
  });

  it("easing control points", () => {
    expect(`cubic-bezier(${motion.easing.standard.join(", ")})`).toBe(
      tokens["motion-ease-standard"],
    );
    expect(`cubic-bezier(${motion.easing.arrival.join(", ")})`).toBe(
      tokens["motion-ease-arrival"],
    );
  });

  it("position spring", () => {
    expect(motion.spring.position.stiffness).toBe(Number(tokens["motion-spring-stiffness"]));
    expect(motion.spring.position.damping).toBe(Number(tokens["motion-spring-damping"]));
    expect(motion.spring.position.mass).toBe(Number(tokens["motion-spring-mass"]));
    expect(MOTION_PRESETS.position).toMatchObject(motion.spring.position);
  });

  it("hover spring, and its physical form is what framer itself solves", () => {
    expect(motion.spring.hover.bounce).toBe(Number(tokens["motion-spring-hover-bounce"]));
    expect(`${motion.spring.hover.durationMs}ms`).toBe(tokens["motion-spring-hover-duration"]);
    const solved = findSpring({
      bounce: motion.spring.hover.bounce,
      duration: motion.spring.hover.durationMs,
      mass: 1,
      velocity: 0,
    });
    expect(motion.spring.hoverPhysical.stiffness).toBeCloseTo(solved.stiffness, 3);
    expect(motion.spring.hoverPhysical.damping).toBeCloseTo(solved.damping, 3);
    expect(MOTION_PRESETS.hover).toMatchObject(motion.spring.hoverPhysical);
  });
});

describe("fonts", () => {
  const families = [...Object.values(fontFamily.body), ...Object.values(fontFamily.display)];

  it("registers Inter for body and Onest for display", () => {
    expect(Object.values(fontFamily.body).every((f) => f.startsWith("Inter-"))).toBe(true);
    expect(Object.values(fontFamily.display).every((f) => f.startsWith("Onest-"))).toBe(true);
  });

  it.each(families)("%s.ttf is on disk and is a TrueType file", (family) => {
    const file = findUp(`apps/mobile/assets/fonts/${family}.ttf`);
    const head = readFileSync(file).subarray(0, 4);
    expect([...head]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it("ships the OFL text for both families", () => {
    for (const license of ["OFL-Inter.txt", "OFL-Onest.txt"]) {
      expect(readFileSync(findUp(`apps/mobile/assets/fonts/${license}`), "utf8")).toContain(
        "SIL Open Font License, Version 1.1",
      );
    }
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

const TEXT_SURFACES = [
  ["rail", colors.rail],
  ["app", colors.app],
  ["surface", colors.surface],
  ["surfaceRaised", colors.surfaceRaised],
] as const;

describe("contrast", () => {
  // AA body text is 4.5:1 — that now holds for the faint meta step too.
  it.each([
    ["fg", colors.fg, 7],
    ["fgMuted", colors.fgMuted, 4.5],
    ["fgFaint", colors.fgFaint, 4.5],
  ])("%s reads on every surface", (_name, fg, min) => {
    for (const [surface, bg] of TEXT_SURFACES) {
      expect(contrast(fg, bg), surface).toBeGreaterThanOrEqual(min);
    }
  });

  it("fgSubtle (non-text) and the offline dot clear 3:1 on the base surfaces", () => {
    for (const bg of [colors.rail, colors.app, colors.surface]) {
      expect(contrast(colors.fgSubtle, bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.offline, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  // The whole point of `onAccent`: every LIGHT fill in the palette takes dark ink.
  it.each([
    ["accent", colors.accent],
    ["accentPressed", colors.accentPressed],
    ["accentDeep", colors.accentDeep],
    ["danger", colors.danger],
    ["success", colors.success],
    ["warning", colors.warning],
    ["online", colors.online],
    ["idle", colors.idle],
    ["dnd", colors.dnd],
  ])("onAccent ink reads on the %s fill", (_name, fill) => {
    expect(contrast(colors.onAccent, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("onInverse ink reads on the white primary button in every state", () => {
    for (const fill of [colors.inverse, colors.inverseHover, colors.inversePressed]) {
      expect(contrast(colors.onInverse, fill)).toBeGreaterThanOrEqual(7);
    }
  });

  it("light foreground would NOT read on the accent — this is why onAccent exists", () => {
    expect(contrast(colors.fg, colors.accent)).toBeLessThan(3);
  });

  it("accent and danger used as a foreground still read on dark surfaces", () => {
    for (const ink of [colors.accent, colors.danger]) {
      expect(contrast(ink, colors.app)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ink, colors.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ink, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
