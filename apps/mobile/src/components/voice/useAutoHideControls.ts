import { useCallback, useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { animate, useReducedMotion } from "@/theme/motion";

export interface AutoHideControls {
  /** Whether the chrome is currently shown (drives `pointerEvents` on controls). */
  visible: boolean;
  /** Animated opacity for the chrome (fades in/out on native driver). */
  opacity: Animated.Value;
  /** Reveal the chrome and (re)arm the idle-hide timer. */
  reveal: () => void;
  /**
   * Reveal the chrome and keep it up with NO idle timer — for a control the
   * finger is still on (dragging the film volume). Follow with `reveal()` when
   * the interaction ends, which re-arms the timer.
   */
  hold: () => void;
  /** Hide the chrome immediately. */
  hide: () => void;
  /** Toggle the chrome (tap-to-toggle, the video-player gesture). */
  toggle: () => void;
}

/**
 * The video-player "controls" behaviour for a fullscreen viewer / video tile: show
 * the chrome (label + buttons) briefly, then FADE it out; a tap toggles it back,
 * and it auto-hides again after an idle delay. Keeps the "{name} is sharing" label
 * from being a permanent fixture on the stream (founder #1) while staying reachable
 * on demand.
 *
 * Motion: the chrome arrives on the `standard` step and leaves on the quicker
 * `fast` one (an overlay gets out of the way rather than drifting off), both
 * through the shared presets — so the OS reduce-motion switch makes it appear
 * and disappear instantly. RN `Animated` on the native driver: the consumers
 * already hold an `Animated.Value`, and opacity is all that moves.
 *
 * The `visible` flag also gates `pointerEvents` so hidden buttons never swallow a
 * tap meant to reveal them.
 */
export function useAutoHideControls(options?: { idleMs?: number }): AutoHideControls {
  const idleMs = options?.idleMs ?? 2800;
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const opacity = useRef(new Animated.Value(1)).current;
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const fadeTo = useCallback(
    (to: number): void => {
      animate(opacity, to, to > 0 ? "standard" : "fast", { reduced: reducedRef.current }).start();
    },
    [opacity],
  );

  const hide = useCallback((): void => {
    clear();
    setVisible(false);
    fadeTo(0);
  }, [clear, fadeTo]);

  const hold = useCallback((): void => {
    clear();
    setVisible(true);
    fadeTo(1);
  }, [clear, fadeTo]);

  const reveal = useCallback((): void => {
    hold();
    timer.current = setTimeout(() => {
      setVisible(false);
      fadeTo(0);
    }, idleMs);
  }, [hold, fadeTo, idleMs]);

  const toggle = useCallback((): void => {
    if (visible) hide();
    else reveal();
  }, [visible, hide, reveal]);

  // Greet on mount, then fade after the idle delay. `reveal`/`clear` are stable
  // (their deps are stable), so the greeting runs exactly once.
  useEffect(() => {
    reveal();
    return clear;
  }, [reveal, clear]);

  return { visible, opacity, reveal, hold, hide, toggle };
}
