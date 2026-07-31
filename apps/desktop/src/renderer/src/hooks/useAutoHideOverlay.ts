import { useCallback, useEffect, useRef, useState } from "react";

export interface AutoHideOverlayHandlers {
  onPointerEnter: () => void;
  onPointerMove: () => void;
  onPointerLeave: () => void;
}

export interface AutoHideOverlay {
  /** Whether the overlay chrome (label/controls) should currently be shown. */
  visible: boolean;
  /** Pointer handlers to spread onto the surface that reveals the overlay on hover. */
  handlers: AutoHideOverlayHandlers;
  /** Imperatively reveal the overlay and restart the idle timer. */
  reveal: () => void;
}

/**
 * The video-player "controls" pattern for an overlay chip/toolbar: show it briefly
 * on mount, then FADE it out; reveal it again on pointer activity over the surface,
 * hiding once more after the pointer goes idle or leaves.
 *
 * Used by the screen-share tiles so the "{name} is sharing" label is not a
 * permanent fixture on the stream (the founder's gripe) — it greets you for a
 * couple of seconds, disappears, and comes back with a hover, exactly like a media
 * player's chrome. Purely presentational timing state; it never touches the video
 * track, so revealing/hiding never re-attaches or re-subscribes anything (§27).
 */
export function useAutoHideOverlay(options?: {
  /** How long the overlay stays up after mount / a pointer nudge (ms). */
  idleMs?: number;
  /** How long after the pointer LEAVES before it hides (ms). */
  leaveMs?: number;
}): AutoHideOverlay {
  const idleMs = options?.idleMs ?? 2600;
  const leaveMs = options?.leaveMs ?? 700;
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hideAfter = useCallback(
    (ms: number): void => {
      clear();
      timer.current = setTimeout(() => setVisible(false), ms);
    },
    [clear],
  );

  const reveal = useCallback((): void => {
    setVisible(true);
    hideAfter(idleMs);
  }, [hideAfter, idleMs]);

  // Initial greeting: show on mount, fade after the idle delay.
  useEffect(() => {
    hideAfter(idleMs);
    return clear;
  }, [hideAfter, idleMs, clear]);

  const onPointerLeave = useCallback((): void => hideAfter(leaveMs), [hideAfter, leaveMs]);

  return {
    visible,
    reveal,
    handlers: {
      onPointerEnter: reveal,
      onPointerMove: reveal,
      onPointerLeave,
    },
  };
}
