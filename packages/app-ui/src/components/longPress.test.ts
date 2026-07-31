import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLongPress,
  DEFAULT_LONG_PRESS_MS,
  DEFAULT_MOVE_THRESHOLD,
  type LongPressPoint,
} from "./longPress";

/**
 * The touch/coarse-pointer trigger path of ActionMenu. Deterministic (fake
 * timers) so the timing + cancel rules are locked without a DOM harness — this
 * package is node-only by design (see vitest.config.ts).
 */

function touch(x: number, y: number): { pointerType: "touch"; clientX: number; clientY: number } {
  return { pointerType: "touch", clientX: x, clientY: y };
}
function mouse(x: number, y: number): { pointerType: "mouse"; clientX: number; clientY: number } {
  return { pointerType: "mouse", clientX: x, clientY: y };
}

describe("createLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after the hold duration on a still touch press, at the press point", () => {
    const fired: LongPressPoint[] = [];
    const lp = createLongPress({ onLongPress: (p) => fired.push(p) });

    lp.onPointerDown(touch(30, 40));
    // Not yet — a beat before the threshold.
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS - 1);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ clientX: 30, clientY: 40 }]);
  });

  it("never arms for a mouse (right-click stays the pure Radix path)", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(mouse(10, 10));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS * 3);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the finger travels past the move threshold (scroll/drag)", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(touch(0, 0));
    lp.onPointerMove(touch(0, DEFAULT_MOVE_THRESHOLD + 1)); // scrolled down
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("tolerates sub-threshold jitter and still fires", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(touch(0, 0));
    lp.onPointerMove(touch(2, 2)); // within the 10px tolerance
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointer up before the hold completes", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(touch(5, 5));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS - 50);
    lp.onPointerUp(touch(5, 5));
    vi.advanceTimersByTime(200);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on pointer cancel", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(touch(5, 5));
    lp.onPointerCancel(touch(5, 5));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancel() clears a pending press", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ onLongPress });

    lp.onPointerDown(touch(1, 1));
    lp.cancel();
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a fresh press restarts the timer from the new point", () => {
    const fired: LongPressPoint[] = [];
    const lp = createLongPress({ onLongPress: (p) => fired.push(p) });

    lp.onPointerDown(touch(1, 1));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS - 100);
    lp.onPointerDown(touch(9, 9)); // second finger-down before the first resolved
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS - 1);
    expect(fired).toHaveLength(0); // the first timer was replaced
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ clientX: 9, clientY: 9 }]);
  });

  it("honors a custom duration and threshold", () => {
    const onLongPress = vi.fn();
    const lp = createLongPress({ durationMs: 1000, moveThreshold: 4, onLongPress });

    lp.onPointerDown(touch(0, 0));
    lp.onPointerMove(touch(3, 0)); // within 4px → tolerated
    vi.advanceTimersByTime(999);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
