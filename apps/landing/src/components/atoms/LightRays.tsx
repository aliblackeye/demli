"use client";

import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Warm light falling from above — drawn in CSS, no video.
 *
 * Two layers of soft beams (conic-gradient fans anchored at the top centre,
 * blurred) sway against each other on slow, unrelated periods, over a warm
 * core glow. The "ember" variant is a pair of drifting coral/amber blooms for
 * the footer card. Everything is transform/opacity animation, so it stays on
 * the compositor.
 *
 * Motion only runs while the element is near the viewport (IntersectionObserver
 * toggles `data-active`) and never under `prefers-reduced-motion: reduce`
 * (globals.css), where the first frame is shown still.
 */

type Beam = readonly [center: number, width: number, alpha: number];

/** Beam angles are degrees off straight-down (negative = left). */
const BEAMS_A: Beam[] = [
  [-46, 5, 0.26],
  [-31, 3, 0.52],
  [-22, 7, 0.36],
  [-9, 4, 0.78],
  [-2, 2.5, 0.57],
  [7, 6, 0.68],
  [18, 3, 0.47],
  [29, 8, 0.31],
  [43, 4, 0.42],
];
const BEAMS_B: Beam[] = [
  [-39, 9, 0.21],
  [-16, 3.5, 0.47],
  [-5, 8, 0.31],
  [12, 3, 0.62],
  [24, 6, 0.26],
  [36, 3, 0.36],
];

/** A conic fan whose 0° points straight down from the anchor. */
function fan(beams: Beam[], rgb: string): string {
  const stops = beams
    .map(([c, w, a]) => {
      const from = 180 + c - w / 2;
      const to = 180 + c + w / 2;
      return `rgba(${rgb},0) ${from}deg, rgba(${rgb},${a}) ${(from + to) / 2}deg, rgba(${rgb},0) ${to}deg`;
    })
    .join(", ");
  return `conic-gradient(from 0deg at 50% 0%, rgba(${rgb},0) 0deg, ${stops}, rgba(${rgb},0) 360deg)`;
}

const LAYER_A: CSSProperties = { backgroundImage: fan(BEAMS_A, "255, 204, 178") };
const LAYER_B: CSSProperties = { backgroundImage: fan(BEAMS_B, "255, 150, 112") };

export function LightRays({
  variant = "rays",
  className = "",
}: {
  variant?: "rays" | "ember";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) el.dataset.active = "";
          else delete el.dataset.active;
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} aria-hidden className={`light-rays light-rays--${variant} ${className}`}>
      {variant === "rays" ? (
        <>
          <i className="lr-core" />
          <i className="lr-beams lr-beams-a" style={LAYER_A} />
          <i className="lr-beams lr-beams-b" style={LAYER_B} />
        </>
      ) : (
        <>
          <i className="lr-ember lr-ember-a" />
          <i className="lr-ember lr-ember-b" />
        </>
      )}
    </div>
  );
}
