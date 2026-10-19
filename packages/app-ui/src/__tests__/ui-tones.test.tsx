// @vitest-environment jsdom
/**
 * Tone steps of the Koyu Masa primitives, measured from the classes they
 * actually render and the values in tokens.css.
 *
 * Koyu Masa has no borders and no outer shadows, so a hover wash, a skeleton
 * block or a popover is visible ONLY through the tone step between it and what
 * it sits on. Several surface tokens share a value on purpose (surface,
 * overlay and hover are all #171717), which means a primitive that paints one
 * of them can be the exact colour of its container and vanish with every
 * value-level token test still green. These tests resolve the painted colour
 * of each state onto every container it can sit in and require a visible step.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  UserAvatar,
  buttonVariants,
  composite,
  contrastRatio,
  iconButtonVariants,
  parseColor,
  seedColor,
  type Rgba,
} from "@demli/ui";
import { flush, mount } from "../test/dom";

const TOKENS: Record<string, string> = (() => {
  const css = readFileSync(resolve(__dirname, "../tokens.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/--tc-([a-z0-9-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) out[name] = value.trim();
  }
  return out;
})();

const token = (name: string): string => {
  const value = TOKENS[name];
  if (!value) throw new Error(`--tc-${name} missing`);
  return value;
};

const css = ({ r, g, b }: Rgba): string => `rgb(${r} ${g} ${b})`;

/**
 * The colour a `bg-*` utility paints in one state (`""` = at rest, `"hover:"`,
 * `"active:"` …), or null when that state sets no background. `bg-x/12` is the
 * token at 12% of its own alpha, which is what Tailwind 4 compiles it to.
 */
function paintIn(classes: string, state: string): Rgba | null {
  for (const cls of classes.split(/\s+/)) {
    if (!cls.startsWith(`${state}bg-`) || cls.slice(state.length).includes(":")) continue;
    const match = /^bg-([a-z0-9-]+)(?:\/(\d+))?$/.exec(cls.slice(state.length));
    if (!match) continue;
    const name = match[1] as string;
    const pct = match[2];
    if (name === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    if (!(name in TOKENS)) continue;
    const colour = parseColor(token(name));
    return pct === undefined ? colour : { ...colour, a: colour.a * (Number(pct) / 100) };
  }
  return null;
}

/** The step a translucent-or-opaque paint makes against an opaque container. */
function step(paint: Rgba, container: string): number {
  const base = parseColor(token(container));
  return contrastRatio(css(composite(paint, base)), token(container));
}

/**
 * The faintest step the palette itself relies on to separate two neighbouring
 * surfaces (a surface-toned input on the app base). A state that moves less
 * than this is not part of the system's visible vocabulary.
 */
const MIN_STEP = contrastRatio(token("surface"), token("app"));

/** Every opaque tone a control or a placeholder can sit on. */
const CONTAINERS = ["rail", "sidebar", "app", "surface", "overlay", "raised"] as const;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("parseColor hsl()", () => {
  it.each([
    ["hsl(0 100% 50%)", [255, 0, 0]],
    ["hsl(120, 100%, 25%)", [0, 128, 0]],
    ["hsl(240 100% 50%)", [0, 0, 255]],
    ["hsl(0 0% 100%)", [255, 255, 255]],
    ["hsl(60 100% 50%)", [255, 255, 0]],
  ] as const)("%s", (input, [r, g, b]) => {
    expect(parseColor(input)).toEqual({ r, g, b, a: 1 });
  });
});

describe("tone floor", () => {
  it("is the real surface-on-app step, not an arbitrary number", () => {
    expect(MIN_STEP).toBeGreaterThan(1.05);
    expect(MIN_STEP).toBeLessThan(1.2);
  });
});

describe("ghost and outline controls", () => {
  const cases: Array<[string, string]> = [
    ["Button ghost", buttonVariants({ variant: "ghost" })],
    ["Button outline", buttonVariants({ variant: "outline" })],
    ["IconButton ghost", iconButtonVariants({ variant: "ghost" })],
  ];

  it.each(cases)("%s hover and press are visible on every container", (_, classes) => {
    const hover = paintIn(classes, "hover:");
    const press = paintIn(classes, "active:");
    expect(hover, "hover sets a background").not.toBeNull();
    expect(press, "press sets a background").not.toBeNull();
    for (const container of CONTAINERS) {
      expect(step(hover as Rgba, container), `hover on ${container}`).toBeGreaterThanOrEqual(MIN_STEP);
      expect(step(press as Rgba, container), `press on ${container}`).toBeGreaterThanOrEqual(MIN_STEP);
    }
  });

  it.each(cases)("%s press is a different tone from hover", (_, classes) => {
    const hover = paintIn(classes, "hover:") as Rgba;
    const press = paintIn(classes, "active:") as Rgba;
    for (const container of CONTAINERS) {
      const base = parseColor(token(container));
      expect(
        contrastRatio(css(composite(press, base)), css(composite(hover, base))),
        container,
      ).toBeGreaterThan(1.02);
    }
  });
});

describe("Skeleton", () => {
  it("shows on an open popover — the profile card's loading state", async () => {
    cleanup = mount(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent aria-label="profil">
          <Skeleton shape="line" height={18} />
        </PopoverContent>
      </Popover>,
    ).unmount;
    await flush();
    const card = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!card) throw new Error("popover did not open");
    const block = card.querySelector<HTMLElement>('[aria-hidden="true"]');
    if (!block) throw new Error("skeleton not rendered");

    const cardPaint = paintIn(card.className, "");
    const blockPaint = paintIn(block.className, "");
    expect(cardPaint).not.toBeNull();
    expect(blockPaint).not.toBeNull();
    const cardTone = css(composite(cardPaint as Rgba, parseColor(token("app"))));
    const blockOnCard = css(composite(blockPaint as Rgba, parseColor(cardTone)));
    expect(contrastRatio(blockOnCard, cardTone)).toBeGreaterThanOrEqual(MIN_STEP);
  });

  it("shows on every container tone", () => {
    cleanup = mount(<Skeleton />).unmount;
    const block = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    const paint = paintIn(block?.className ?? "", "");
    expect(paint).not.toBeNull();
    for (const container of CONTAINERS) {
      expect(step(paint as Rgba, container), container).toBeGreaterThanOrEqual(MIN_STEP);
    }
  });
});

describe("UserAvatar initials", () => {
  /** Seeds that drive `seedColor` through all 360 hues it can produce. */
  function seedsForEveryHue(): string[] {
    const byColour = new Map<string, string>();
    for (let i = 0; byColour.size < 360 && i < 200_000; i += 1) {
      const seed = `u${i}`;
      const colour = seedColor(seed);
      if (!byColour.has(colour)) byColour.set(colour, seed);
    }
    return [...byColour.values()];
  }

  it("read at AA (4.5:1) on every seed colour", () => {
    cleanup = mount(<UserAvatar name="Kaan Demir" src={null} size="sm" />).unmount;
    const circle = document.querySelector<HTMLElement>('span[aria-hidden="true"]');
    const ink = (circle?.className ?? "")
      .split(/\s+/)
      .map((cls) => /^text-([a-z0-9-]+)$/.exec(cls)?.[1])
      .find((name): name is string => name !== undefined && name in TOKENS);
    expect(ink, "initials ink is a palette token").toBeDefined();

    const seeds = seedsForEveryHue();
    expect(seeds).toHaveLength(360);
    const failing = seeds
      .map((seed) => seedColor(seed))
      .filter((bg) => contrastRatio(token(ink as string), bg) < 4.5);
    expect(failing).toEqual([]);
  });
});
