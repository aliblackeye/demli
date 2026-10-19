/**
 * The first paint and the splash are ONE surface, painted by four files.
 *
 * Before any stylesheet exists, three places have to guess the app's colours with
 * literal values: Electron's window `backgroundColor` (painted before the first
 * renderer frame), the desktop `index.html` first-paint style, and the web
 * `index.html` pre-bundle skeleton. The React splash then takes over reading the
 * real tokens. If any literal drifts from the tokens, the user sees a colour step
 * on every launch — exactly the warm-brown flash the retired "Demli Voice v2"
 * gradient would leave over the Koyu Masa black. Nothing renders wrong in a test
 * of the component, so this test reads the four sources against globals.css.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const GLOBALS = read("../styles/globals.css");
const DESKTOP_HTML = read("../../index.html");
const WEB_HTML = read("../../../../../web/index.html");
const MAIN = read("../../../main/index.ts");
const SPLASH = read("./BootSplash.tsx");

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(GLOBALS);
  if (!match?.[1]) throw new Error(`token --color-${name} missing from globals.css`);
  return match[1].trim().toLowerCase();
}

/** `rgb(255 132 100 / 0.24)` and `rgba(255,132,100,0.24)` → "255,132,100,0.24". */
function normalizeRgb(value: string): string {
  const inner = /rgba?\(([^)]+)\)/.exec(value)?.[1] ?? "";
  return inner
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(",");
}

const GLOW_GEOMETRY = "radial-gradient(42% 32% at 50% 44%,";

describe("boot surface continuity", () => {
  const rail = token("rail");
  const glow = normalizeRgb(token("accent-glow"));

  it("the page tone is the Koyu Masa black, in every pre-stylesheet paint", () => {
    expect(rail).toBe("#000000");
    expect(MAIN).toContain(`backgroundColor: "${rail}"`);
    expect(DESKTOP_HTML).toContain(`background-color: ${rail};`);
    expect(WEB_HTML).toContain(`background-color: ${rail};`);
  });

  it("the single warm light uses the accent-glow token's exact value and geometry", () => {
    for (const html of [DESKTOP_HTML, WEB_HTML]) {
      const line = html.split("\n").find((l) => l.includes(GLOW_GEOMETRY));
      expect(line, "glow gradient missing").toBeDefined();
      expect(normalizeRgb(line ?? "")).toBe(glow);
    }
    // The React splash reads the token itself rather than re-typing it.
    expect(SPLASH).toContain(`${GLOW_GEOMETRY} var(--color-accent-glow), transparent 72%)`);
    expect(SPLASH).toContain("bg-rail");
  });

  it("the web skeleton's empty track is the splash track's tone", () => {
    const track = /\.bs-track\s*\{[^}]*background:\s*([^;]+);/.exec(WEB_HTML)?.[1] ?? "";
    expect(normalizeRgb(track)).toBe(normalizeRgb(token("wash-strong")));
    expect(SPLASH).toContain("bg-wash-strong");
  });

  it("no retired warm-ramp literal survives in any of the four", () => {
    for (const source of [DESKTOP_HTML, WEB_HTML, MAIN, SPLASH]) {
      expect(source).not.toMatch(/#2a0f07|#180806|#0c0304|248,\s*238,\s*212/i);
    }
  });
});
