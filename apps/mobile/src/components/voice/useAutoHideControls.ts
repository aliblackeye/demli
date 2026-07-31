import { useCallback, useEffect, useRef, useState } from "react";
import { Animated } from "react-native";

export interface AutoHideControls {
  /** Whether the chrome is currently shown (drives `pointerEvents` on controls). */
  visible: boolean;
  /** Animated opacity for the chrome (fades in/out on native driver). */
  opacity: Animated.Value;
  /** Reveal the chrome and (re)arm the idle-hide timer. */
  reveal: () => void;
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
 * RN-only + `Animated` (opacity → native driver), so no new dependency and fully
 * OTA-safe. The `visible` flag also gates `pointerEvents` so hidden buttons never
 * swallow a tap meant to reveal them.
 */
export function useAutoHideControls(options?: { idleMs?: number }): AutoHideControls {
  const idleMs = options?.idleMs ?? 2800;
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
      Animated.timing(opacity, { toValue: to, duration: 220, useNativeDriver: true }).start();
    },
    [opacity],
  );

  const hide = useCallback((): void => {
    clear();
    setVisible(false);
    fadeTo(0);
  }, [clear, fadeTo]);

  const reveal = useCallback((): void => {
    clear();
    setVisible(true);
    fadeTo(1);
    timer.current = setTimeout(() => {
      setVisible(false);
      fadeTo(0);
    }, idleMs);
  }, [clear, fadeTo, idleMs]);

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

  return { visible, opacity, reveal, hide, toggle };
}
