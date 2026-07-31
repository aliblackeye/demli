import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Latch `true` once the element first scrolls within `rootMargin` of the
 * viewport, then disconnect. Used to defer attachment signed-URL fetches +
 * media loads until a tile actually nears view, on top of list virtualization
 * (CLAUDE.md §27). One-shot: once seen, stays true so a re-scroll never reloads.
 */
export function useInView<T extends Element>(
  rootMargin = "300px",
): { ref: RefObject<T>; inView: boolean } {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}
