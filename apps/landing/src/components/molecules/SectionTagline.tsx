"use client";

import { ShimmerText } from "../atoms/ShimmerText";

/**
 * Bölüm başı hap etiketi — ölçülen: bg #0d0d0d, radius 50px,
 * padding 12px 18px, metin Inter 500 16px #737373 + sarı shimmer.
 */
export function SectionTagline({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center rounded-[50px] bg-base px-[18px] py-3 backdrop-blur-[8px]" style={{ boxShadow: "rgba(38, 49, 64, 0.32) 0px -1px 0px 0px inset" }}>
      <ShimmerText
        text={label}
        color="#eab30a"
        className="text-[14px] font-medium leading-[16.8px] text-text-dim tb:text-[16px] tb:leading-[19.2px]"
      />
    </div>
  );
}
