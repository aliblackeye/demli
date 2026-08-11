"use client";

/**
 * Nav linklerindeki çift katmanlı kayan hover metni — authored:
 * Content yüksekliği 19px, kopya 23px altta, hover'da birlikte yukarı.
 * Tipografi (X7YAE preset): Inter 500, 16px (tb+) / 14px (mobil),
 * satır %120, izleme -0.02em, renk #e5e5e5.
 */
export function SlideHoverText({ label }: { label: string }) {
  const textCls =
    "text-[14px] font-medium leading-[1.2] tracking-[-0.02em] text-[#e5e5e5] tb:text-[16px]";
  return (
    <div className="relative flex h-[17px] flex-col items-start overflow-hidden tb:h-[19px]">
      <p className="flex flex-col whitespace-pre transition-transform duration-300 ease-out group-hover:-translate-y-[23px]">
        <strong className={textCls}>{label}</strong>
      </p>
      <p
        aria-hidden
        className="absolute top-[23px] flex flex-col whitespace-pre transition-transform duration-300 ease-out group-hover:-translate-y-[23px]"
      >
        <strong className={textCls}>{label}</strong>
      </p>
    </div>
  );
}
