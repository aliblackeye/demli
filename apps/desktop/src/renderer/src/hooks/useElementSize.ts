import { useEffect, useRef, useState, type RefObject } from "react";

export interface Size {
  width: number;
  height: number;
}

/**
 * Track an element's content-box size via ResizeObserver. Used by the movable
 * camera PiP to clamp its drag range to the current stage bounds so it stays
 * fully visible and snaps to real corners at any window size (resolution-
 * independent positioning, see video-stage-store).
 */
export function useElementSize<T extends Element>(): {
  ref: RefObject<T>;
  size: Size;
} {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof ResizeObserver === "undefined") {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}
