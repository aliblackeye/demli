"use client";

import type { CSSProperties } from "react";

/**
 * Referanstaki shimmer: normal metnin üstünde renksiz bir kopya;
 * kopyanın zemini 90° gradyan (transparent 41% → renk 50% → transparent 59%),
 * background-size 200% 200%, background-clip: text, 3s linear infinite
 * background-position kaydırması.
 */
export function ShimmerText({
  text,
  color,
  className = "",
  style,
}: {
  text: string;
  color: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={"relative inline-block " + className} style={style}>
      <span>{text}</span>
      <span
        aria-hidden
        className="shimmer-overlay pointer-events-none absolute inset-0 z-[1] text-transparent"
        style={{
          background: `linear-gradient(90deg, transparent 0%, transparent 41%, ${color} 50%, transparent 59%, transparent 100%)`,
          backgroundSize: "200% 200%",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          backgroundRepeat: "no-repeat",
        }}
      >
        {text}
      </span>
    </span>
  );
}
