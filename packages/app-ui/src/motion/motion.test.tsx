// @vitest-environment jsdom
/**
 * The motion layer's two promises:
 *  - every helper renders under the renderer's `<LazyMotion strict>` (a
 *    `motion.*` element there throws and white-screens the app — the negative
 *    control below proves this test would notice), and
 *  - the presets carry the authored Koyu Masa numbers, with no hover scale.
 */
import { LazyMotion, domAnimation, motion } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPRING_HOVER, SPRING_POSITION } from "@demli/ui";
import { mount } from "../test/dom";
import { MotionFade, MotionPop, MotionSheet, MotionToast } from "./components";
import { MOTION_DURATION, pressable, sheetSlide, springs, toastPop } from "./presets";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

function strict(node: JSX.Element): void {
  const mounted = mount(
    <LazyMotion features={domAnimation} strict>
      {node}
    </LazyMotion>,
  );
  cleanup = mounted.unmount;
}

describe("m.* helpers under LazyMotion strict", () => {
  it.each([
    ["MotionFade", <MotionFade key="f" data-testid="h" />],
    ["MotionPop", <MotionPop key="p" data-testid="h" />],
    ["MotionToast", <MotionToast key="t" data-testid="h" />],
    ["MotionSheet", <MotionSheet key="s" side="right" data-testid="h" />],
  ])("%s mounts", (_name, node) => {
    expect(() => strict(node)).not.toThrow();
    expect(document.querySelector('[data-testid="h"]')).not.toBeNull();
  });

  it("negative control: a motion.* element DOES throw there", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => strict(<motion.div />)).toThrow();
  });
});

describe("presets", () => {
  it("position spring is the authored one", () => {
    expect(springs.position).toEqual({ type: "spring", ...SPRING_POSITION });
    expect(springs.hover).toEqual({
      type: "spring",
      bounce: SPRING_HOVER.bounce,
      duration: SPRING_HOVER.durationMs / 1000,
    });
  });

  it("things that move ride the position spring", () => {
    expect(toastPop.animate).toMatchObject({ transition: springs.position });
    for (const side of ["right", "left", "bottom"] as const) {
      expect(sheetSlide[side].animate).toMatchObject({ transition: springs.position });
    }
  });

  it("hover is a 200ms tone change, never a scale", () => {
    expect(MOTION_DURATION.hover).toBe(0.2);
    expect("whileHover" in pressable).toBe(false);
  });
});
