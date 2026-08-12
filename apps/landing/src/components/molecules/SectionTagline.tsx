"use client";

import { ShimmerText } from "../atoms/ShimmerText";

/**
 * Bölüm başı hap etiketi — ölçülen: bg #0d0d0d, radius 50px,
 * padding 12px 18px, metin Inter 500 16px #737373 + sarı shimmer.
 */
export function SectionTagline({ label }: { label: string }) {
  return (
    // Ölçülen (390): mobil pad 8×12 (hap 33×82), tb+ 12×18
    <div className="flex items-center justify-center rounded-[50px] bg-base px-3 py-2 backdrop-blur-[8px] tb:px-[18px] tb:py-3" style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}>
      <ShimmerText
        text={label}
        color="#eab30a"
        className="text-[14px] font-medium leading-[16.8px] text-text-dim tb:text-[16px] tb:leading-[19.2px]"
      />
    </div>
  );
}
