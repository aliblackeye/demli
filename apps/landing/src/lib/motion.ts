/**
 * Landing-page motion plumbing.
 *
 * Three hooks, one IntersectionObserver each, and nothing else. No animation
 * library (the page ships 205 kB of JS and that number is not allowed to move),
 * no `scroll` listener, no React state that re-renders while the page moves.
 * Every actual animation lives in the stylesheet on `transform` and `opacity`;
 * these hooks only decide WHEN a class is on an element.
 *
 * ── Progressive enhancement is the contract, not a footnote ─────────────────
 * Nothing here may leave content invisible. `js-motion` lands on <html> only
 * when this module runs AND IntersectionObserver exists, and the stylesheet is
 * written so that `opacity: 0` is reachable only under that class. JS off, an
 * engine without IntersectionObserver, a bundle that fails to execute: the page
 * paints in its final state every time. The same rule is why the looping
 * animations are declared unconditionally and merely PAUSED under `js-motion` —
 * without JS they simply run, which is the old behaviour, not a blank box.
 *
 * ── Why one-shot reveals ────────────────────────────────────────────────────
 * A scroll animation that replays every time the section passes the fold is the
 * most irritating thing a landing page can do, so `useRevealOnce` disconnects
 * its observer inside the first callback that fires. Scroll up, scroll down: the
 * block stays where it landed.
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Root class every JS-driven effect in globals.css keys off. */
const MOTION_CLASS = "js-motion";
/** One-shot: "this block arrived, bring it in, then leave it alone forever". */
const IN_CLASS = "is-in";
/** Toggled: "this loop is on screen, let it run". */
const LIVE_CLASS = "is-live";

function hasObserver(): boolean {
  return typeof window !== "undefined" && typeof window.IntersectionObserver === "function";
}

/**
 * Marks the document as motion-capable. Called from main.tsx BEFORE the first
 * render so the reveal targets are already hidden on their first paint and never
 * flash in at full opacity and then jump.
 */
export function enableMotionEnhancements(): void {
  if (!hasObserver()) return;
  document.documentElement.classList.add(MOTION_CLASS);
}

/**
 * Reveals an element (or, with `.reveal-group`, its children in sequence) the
 * first time it crosses into view, then stops observing.
 *
 * The trigger is the element's top edge crossing 88% of the viewport height
 * rather than a percentage of the element itself: a `threshold` fires late for
 * anything taller than the screen, and on a 390px phone the bento is taller than
 * the screen.
 */
export function useRevealOnce<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (!hasObserver()) {
      // The stylesheet never hid it (no `js-motion`), so there is nothing to
      // reveal — but set the class anyway so the two paths cannot diverge.
      node.classList.add(IN_CLASS);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add(IN_CLASS);
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "0px 0px -12% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return ref;
}

/**
 * Runs a looping animation only while its element is on screen.
 *
 * The page has exactly two loops — the hero's sonar rings and the audio level
 * strip in the voice tile — and they sit in different sections, so gating both
 * means at most ONE loop is ever running and a backgrounded or scrolled-past
 * page costs nothing.
 */
export function useLiveWhileVisible<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (!hasObserver()) {
      node.classList.add(LIVE_CLASS);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle(LIVE_CLASS, entry.isIntersecting);
        }
      },
      { threshold: 0 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return ref;
}

/**
 * Watches a zero-width sentinel pinned to the top of the page and writes
 * `data-scrolled` onto <html> when it leaves the viewport, which is what lets
 * the sticky header sit transparent over the hero and pick up its own surface
 * once real content is passing underneath it.
 *
 * A sentinel rather than a scroll handler: the browser reports the crossing
 * once, off the main thread, instead of the page doing arithmetic on every
 * frame of every scroll.
 */
export function useScrollSentinel<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasObserver()) return;

    const root = document.documentElement;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) delete root.dataset.scrolled;
          else root.dataset.scrolled = "true";
        }
      },
      { threshold: 0 },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
      delete root.dataset.scrolled;
    };
  }, []);

  return ref;
}
