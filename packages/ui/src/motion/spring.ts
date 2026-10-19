/**
 * Spring maths shared by every Demli surface.
 *
 * Koyu Masa authors position changes as a physical spring (landing measurement:
 * stiffness 500, damping 60, mass 1). Framer (desktop/web `m.*`) and React Native
 * `Animated.spring` take those three numbers directly. CSS cannot run a spring,
 * so Radix-driven primitives in this package get the SAME curve sampled into a
 * `linear()` easing function plus the duration the spring needs to settle —
 * `springToCssLinear` is the one place that conversion happens, and a test pins
 * the values written into globals.css to its output so the two cannot drift.
 *
 * Pure module: no DOM, no React, no framer import.
 */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

/** Position spring for anything that moves: switch thumb, sheet, toast, menu. */
export const SPRING_POSITION: SpringConfig = { stiffness: 500, damping: 60, mass: 1 };

/** Duration-based hover spring (framer `{ bounce, duration }` form). */
export const SPRING_HOVER = { bounce: 0.2, durationMs: 400 } as const;

/** ζ = c / (2·√(k·m)). Above 1 the spring never overshoots. */
export function dampingRatio({ stiffness, damping, mass }: SpringConfig): number {
  return damping / (2 * Math.sqrt(stiffness * mass));
}

/**
 * Position at `t` seconds of a spring released from rest at 0 and pulled toward
 * 1 (unit step response). Closed form for all three damping regimes.
 */
export function springAt(config: SpringConfig, t: number): number {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(config.stiffness / config.mass);
  const zeta = dampingRatio(config);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    return 1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) {
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/**
 * Seconds until the spring stays within `tolerance` of its target for good.
 * Scans forward at 1ms and keeps the last moment it was still outside the band,
 * so an underdamped spring's final overshoot is not mistaken for rest.
 */
export function springSettleTime(config: SpringConfig, tolerance = 0.001): number {
  const step = 0.001;
  let lastOutside = 0;
  for (let t = 0; t <= 10; t += step) {
    if (Math.abs(1 - springAt(config, t)) > tolerance) lastOutside = t;
  }
  return lastOutside + step;
}

export interface CssSpring {
  /** A CSS `linear()` easing function tracing the spring. */
  easing: string;
  /** Settle time, rounded up to whole milliseconds. */
  durationMs: number;
}

/**
 * Sample the spring into `samples` evenly spaced stops over its settle time.
 * Values are rounded to 4 decimals, enough that the curve is visually exact.
 */
export function springToCssLinear(
  config: SpringConfig,
  { samples = 24, tolerance = 0.001 }: { samples?: number; tolerance?: number } = {},
): CssSpring {
  const settle = springSettleTime(config, tolerance);
  const durationMs = Math.ceil(settle * 1000);
  const total = durationMs / 1000;
  const stops: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const value = i === samples ? 1 : springAt(config, (total * i) / samples);
    stops.push(String(Math.round(value * 10000) / 10000));
  }
  return { easing: `linear(${stops.join(", ")})`, durationMs };
}
