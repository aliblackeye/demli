import { useCallback, useState } from "react";

/**
 * Fade a picture in once it has decoded — but NOT when it was already decoded
 * the moment it mounted.
 *
 * Message rows live in a virtualized list: scrolling unmounts and re-mounts them
 * constantly, and a cached image re-fires `load` within a frame. A plain
 * "opacity 0 → 1 on load" would therefore replay the fade on every row that
 * scrolls back into view (the same mount-replay trap the arrival motion avoids,
 * §27). The ref callback checks `complete` at attach time, BEFORE first paint,
 * and marks those pictures instant: no transition class, shown at once.
 *
 * Returns the ref to put on the <img>, its `onLoad`, whether it is visible yet,
 * and whether the reveal should animate.
 */
export function useImageReveal(): {
  ref: (img: HTMLImageElement | null) => void;
  onLoad: () => void;
  loaded: boolean;
  animate: boolean;
} {
  const [loaded, setLoaded] = useState(false);
  const [animate, setAnimate] = useState(true);
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) {
      setAnimate(false);
      setLoaded(true);
    }
  }, []);
  const onLoad = useCallback(() => setLoaded(true), []);
  return { ref, onLoad, loaded, animate };
}
