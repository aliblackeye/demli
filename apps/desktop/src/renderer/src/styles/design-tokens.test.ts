import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  composite,
  hueDistance,
  parseColor,
  visionDistance,
  type VisionType,
} from "../../../../../../packages/ui/src/lib/color";
import {
  SPRING_HOVER,
  SPRING_POSITION,
  springToCssLinear,
} from "../../../../../../packages/ui/src/motion/spring";

/**
 * The desktop + web token seam, checked against the neutral token file and
 * against the rules that make the palette usable.
 *
 * globals.css `@theme` is what actually paints desktop and web (every semantic
 * utility compiles to var(--color-*)). packages/app-ui/src/tokens.css is not
 * imported by either, but the mobile theme is locked to it — so without THIS
 * test the desktop palette could drift away from mobile with every gate green.
 * Contrast is computed from the values, never eyeballed.
 */
const GLOBALS_CSS = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");
const TOKENS_URL = new URL("../../../../../../packages/app-ui/src/tokens.css", import.meta.url);
const TOKENS_CSS = readFileSync(fileURLToPath(TOKENS_URL), "utf8");

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  expect(start, `${opener} must exist`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${opener}`);
}

/** Custom properties declared directly in a block (comments stripped). */
function properties(css: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(new RegExp(`${prefix}([a-z0-9-]+):\\s*([^;]+);`, "g"))) {
    const [, name, value] = match;
    if (name && value) out[name] = value.replace(/\s+/g, " ").trim();
  }
  return out;
}

const THEME = block(GLOBALS_CSS, "@theme {");
const ROOT = block(GLOBALS_CSS, ":root {");
const desktopColors = properties(THEME, "--color-");
const desktopRadius = properties(THEME, "--radius-");
const desktopRoot = properties(ROOT, "--");
const tc = properties(TOKENS_CSS, "--tc-");

const COLOR_NAMES = Object.keys(desktopColors);

function sameColor(a: string, b: string): boolean {
  const x = parseColor(a);
  const y = parseColor(b);
  return x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 1e-9;
}

describe("globals.css @theme ⇄ tokens.css", () => {
  it("declares the full Koyu Masa palette", () => {
    expect(COLOR_NAMES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(COLOR_NAMES)("--color-%s has the same value as --tc-%s", (name) => {
    expect(tc[name], `tokens.css is missing --tc-${name}`).toBeDefined();
    expect(sameColor(desktopColors[name] as string, tc[name] as string)).toBe(true);
  });

  it("tokens.css declares no colour the desktop theme lacks", () => {
    const tcColours = Object.entries(tc)
      .filter(([, value]) => /^(#|rgba?\()/.test(value))
      .map(([name]) => name);
    expect(tcColours.filter((name) => !(name in desktopColors))).toEqual([]);
  });

  it("radius steps resolve to the same pixels", () => {
    const base = Number.parseFloat(desktopRoot.radius ?? "NaN");
    const resolve = (value: string): number => {
      const calc = /^calc\(var\(--radius\)\s*([+-])\s*(\d+)px\)$/.exec(value);
      if (calc) return calc[1] === "+" ? base + Number(calc[2]) : base - Number(calc[2]);
      if (value === "var(--radius)") return base;
      return Number.parseFloat(value);
    };
    expect(base).toBe(Number.parseFloat(tc.radius as string));
    for (const step of ["sm", "md", "lg", "xl", "cta", "card", "panel", "pill"]) {
      expect(resolve(desktopRadius[step] as string), `--radius-${step}`).toBe(
        Number.parseFloat(tc[`radius-${step}`] as string),
      );
    }
    expect([8, 10, 12, 16, 18, 24, 32, 50]).toEqual(
      ["sm", "md", "lg", "xl", "cta", "card", "panel", "pill"].map((s) =>
        resolve(desktopRadius[s] as string),
      ),
    );
  });

  it("motion ramp matches", () => {
    for (const step of ["instant", "fast", "hover", "standard", "arrival"]) {
      expect(desktopRoot[`motion-duration-${step}`], step).toBe(tc[`motion-duration-${step}`]);
    }
    expect(desktopRoot["motion-ease-standard"]).toBe(tc["motion-ease-standard"]);
    expect(desktopRoot["motion-ease-arrival"]).toBe(tc["motion-ease-arrival"]);
    expect(desktopRoot["motion-duration-hover"]).toBe("200ms");
  });

  it("font stacks match and lead with Inter / Onest", () => {
    const fonts = properties(THEME, "--font-");
    expect(fonts.sans).toBe(tc["font-sans"]);
    expect(fonts.display).toBe(tc["font-display"]);
    expect(fonts.sans?.startsWith('"Inter"')).toBe(true);
    expect(fonts.display?.startsWith('"Onest"')).toBe(true);
  });
});

describe("position spring", () => {
  it("tokens.css carries the authored numbers", () => {
    expect(Number(tc["motion-spring-stiffness"])).toBe(SPRING_POSITION.stiffness);
    expect(Number(tc["motion-spring-damping"])).toBe(SPRING_POSITION.damping);
    expect(Number(tc["motion-spring-mass"])).toBe(SPRING_POSITION.mass);
    expect(Number(tc["motion-spring-hover-bounce"])).toBe(SPRING_HOVER.bounce);
    expect(tc["motion-spring-hover-duration"]).toBe(`${SPRING_HOVER.durationMs}ms`);
  });

  it("the CSS linear() curve is exactly the sampled spring", () => {
    const expected = springToCssLinear(SPRING_POSITION, { tolerance: 0.005 });
    expect(desktopRoot["motion-ease-spring"]).toBe(expected.easing);
    expect(desktopRoot["motion-duration-spring"]).toBe(`${expected.durationMs}ms`);
  });
});

describe("self-hosted fonts", () => {
  const faces = [...GLOBALS_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string);

  it("declares Inter and Onest, latin + latin-ext each", () => {
    const families = faces.map((f) => /font-family:\s*"([^"]+)"/.exec(f)?.[1]);
    expect(families.filter((f) => f === "Inter")).toHaveLength(2);
    expect(families.filter((f) => f === "Onest")).toHaveLength(2);
    expect(families.every((f) => f === "Inter" || f === "Onest")).toBe(true);
  });

  it("covers the Turkish letters across the two subsets", () => {
    for (const family of ["Inter", "Onest"]) {
      const ranges = faces
        .filter((f) => f.includes(`"${family}"`))
        .flatMap((f) => (/unicode-range:\s*([^;]+);/.exec(f)?.[1] ?? "").split(","))
        .map((r) => r.trim().replace(/^U\+/, ""))
        .map((r) => r.split("-").map((h) => Number.parseInt(h, 16)) as [number, number?]);
      for (const ch of "ıİğĞşŞçÇöÖüÜ") {
        const cp = ch.codePointAt(0) as number;
        const covered = ranges.some(([lo, hi]) => cp >= lo && cp <= (hi ?? lo));
        expect(covered, `${family} misses ${ch}`).toBe(true);
      }
    }
  });

  it("every referenced font file and its OFL text is on disk", () => {
    const urls = [...GLOBALS_CSS.matchAll(/url\("(\.\.\/assets\/fonts\/[^"]+)"\)/g)].map(
      (m) => m[1] as string,
    );
    expect(urls).toHaveLength(4);
    for (const rel of urls) {
      expect(existsSync(fileURLToPath(new URL(rel, import.meta.url))), rel).toBe(true);
    }
    for (const license of ["OFL-Inter.txt", "OFL-Onest.txt"]) {
      const path = fileURLToPath(new URL(`../assets/fonts/${license}`, import.meta.url));
      expect(readFileSync(path, "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
  });

  it("no retired face is still referenced", () => {
    expect(GLOBALS_CSS).not.toMatch(/Instrument Sans|Space Grotesk|Stack Sans/);
    expect(TOKENS_CSS).not.toMatch(/Instrument Sans|Space Grotesk|Stack Sans/);
  });
});

const c = (name: string): string => {
  const value = desktopColors[name];
  if (!value) throw new Error(`--color-${name} missing`);
  return value;
};

/** Opaque surfaces text sits on, darkest to lightest. */
const TEXT_SURFACES = ["rail", "sidebar", "app", "surface", "raised"] as const;

describe("contrast (WCAG 2.x)", () => {
  it.each([
    ["fg", 7],
    ["fg-muted", 4.5],
    ["fg-faint", 4.5],
  ] as const)("%s text reads on every surface (≥ %s:1)", (token, min) => {
    for (const surface of TEXT_SURFACES) {
      expect(contrastRatio(c(token), c(surface)), `${token} on ${surface}`).toBeGreaterThanOrEqual(
        min,
      );
    }
  });

  it("fg-subtle (non-text) clears 3:1 on the base surfaces", () => {
    for (const surface of ["rail", "sidebar", "app", "surface"]) {
      expect(contrastRatio(c("fg-subtle"), c(surface)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("the offline presence dot is visible against its avatar ring", () => {
    for (const surface of ["sidebar", "app"]) {
      expect(contrastRatio(c("offline"), c(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it("selected and hover rows keep body text readable", () => {
    const selected = composite(parseColor(c("selected")), parseColor(c("sidebar")));
    const hex = `rgb(${selected.r} ${selected.g} ${selected.b})`;
    expect(contrastRatio(c("fg"), hex)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c("accent-hover"), hex)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c("fg-muted"), c("hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["accent", "accent-hover", "accent-pressed", "danger", "success", "warning", "online", "idle", "dnd"])(
    "dark ink reads on the %s fill",
    (fill) => {
      expect(contrastRatio(c("on-accent"), c(fill))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("white is NOT used on the light fills — that is why on-accent exists", () => {
    expect(contrastRatio("#ffffff", c("accent"))).toBeLessThan(3);
    expect(contrastRatio("#ffffff", c("danger"))).toBeLessThan(3);
  });

  it("primary (inverse) button ink reads in every state", () => {
    for (const fill of ["inverse", "inverse-hover", "inverse-pressed"]) {
      expect(contrastRatio(c("on-inverse"), c(fill))).toBeGreaterThanOrEqual(7);
    }
  });

  it("accent and danger work as text on the dark surfaces and on their soft washes", () => {
    for (const token of ["accent", "danger"]) {
      for (const surface of ["rail", "app", "surface", "raised"]) {
        expect(contrastRatio(c(token), c(surface)), `${token} on ${surface}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
    for (const [ink, wash] of [
      ["danger", "danger-surface"],
      ["accent-hover", "accent-surface"],
    ] as const) {
      const flat = composite(parseColor(c(wash)), parseColor(c("app")));
      expect(
        contrastRatio(c(ink), `rgb(${flat.r} ${flat.g} ${flat.b})`),
        `${ink} on ${wash}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("danger stays recognisable next to the coral accent", () => {
  it("is at least 30° of hue away from the accent", () => {
    expect(hueDistance(c("danger"), c("accent"))).toBeGreaterThanOrEqual(30);
  });

  it.each(["normal", "protan", "deutan"] as const)(
    "is clearly different from the accent for %s vision (ΔE2000 ≥ 20)",
    (vision: VisionType) => {
      expect(visionDistance(c("danger"), c("accent"), vision)).toBeGreaterThanOrEqual(20);
    },
  );

  it.each(["normal", "protan", "deutan"] as const)(
    "dnd and online presence dots stay apart for %s vision (ΔE2000 ≥ 20)",
    (vision: VisionType) => {
      expect(visionDistance(c("dnd"), c("online"), vision)).toBeGreaterThanOrEqual(20);
    },
  );
});
