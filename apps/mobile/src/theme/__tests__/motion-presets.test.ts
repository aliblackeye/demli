/**
 * The mobile press spring and overlay choreography are MIRRORS of the framer
 * presets in packages/app-ui/src/motion/presets.ts. They are not tokens (no
 * tokens.css entry), so this test reads the desktop source directly — editing
 * one side without the other fails here instead of drifting quietly.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION_PRESETS, OVERLAY_MOTION, PRESS, springConfigOf } from "../motion-presets";
import { motion } from "../theme";

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

const desktop = readFileSync(findUp("packages/app-ui/src/motion/presets.ts"), "utf8");

/** The `{ ... }` object literal that follows `export const <name>`. */
function block(name: string): string {
  const start = desktop.indexOf(`export const ${name}`);
  expect(start, `desktop preset ${name} exists`).toBeGreaterThan(-1);
  // The literal closes on the first column-0 brace (`};` or `} as const;`).
  const end = desktop.indexOf("\n}", start);
  expect(end, `desktop preset ${name} is closed`).toBeGreaterThan(start);
  return desktop.slice(start, end);
}

describe("press spring mirrors desktop `pressable`", () => {
  const src = block("pressable");

  it("same physical spring", () => {
    const { stiffness, damping, mass } = PRESS.spring;
    expect(src).toContain(`stiffness: ${stiffness}, damping: ${damping}, mass: ${mass}`);
  });

  it("same icon-chrome scale", () => {
    expect(src).toContain(`scale: ${PRESS.scale.icon}`);
  });

  it("the text-button step is gentler than the icon step, and nothing grows", () => {
    expect(PRESS.scale.button).toBeGreaterThan(PRESS.scale.icon);
    expect(PRESS.scale.button).toBeLessThan(1);
  });
});

describe("overlay choreography mirrors the framer variants", () => {
  it("toast lifts from 12px at 0.98 and sinks 8px on exit", () => {
    const src = block("toastPop");
    expect(src).toContain(
      `initial: { opacity: 0, y: ${OVERLAY_MOTION.toast.from.translateY}, scale: ${OVERLAY_MOTION.toast.from.scale} }`,
    );
    expect(src).toContain(`exit: { opacity: 0, y: ${OVERLAY_MOTION.toast.exitTo.translateY},`);
  });

  it("banner drops from -12px and retracts -8px", () => {
    const src = block("bannerDrop");
    expect(src).toContain(`initial: { opacity: 0, y: ${OVERLAY_MOTION.banner.from.translateY} }`);
    expect(src).toContain(`exit: { opacity: 0, y: ${OVERLAY_MOTION.banner.exitTo.translateY},`);
  });

  it("pop fades from 0.98", () => {
    const src = block("popIn");
    expect(src).toContain(`initial: { opacity: 0, scale: ${OVERLAY_MOTION.pop.from.scale} }`);
  });
});

describe("springConfigOf", () => {
  it("maps a preset onto the Reanimated triple, carrying release velocity", () => {
    expect(springConfigOf(MOTION_PRESETS.position, -820)).toEqual({
      ...motion.spring.position,
      velocity: -820,
    });
    expect(springConfigOf(MOTION_PRESETS.hover)).toEqual({
      ...motion.spring.hoverPhysical,
      velocity: 0,
    });
  });
});
