"use client";

/**
 * Referanstaki çift katmanlı kayan hover metni:
 * normal metin + 23px altında hover kopyası; hover'da ikisi birlikte
 * yukarı kayar (kapsayıcı overflow-hidden, yükseklik tek satır).
 * Ölçülen: metin Inter 500 16px/19.2px ls -0.32px, kopya offset 23px.
 */
export function SlideHoverText({ label }: { label: string }) {
  return (
    <div className="relative flex h-[19px] flex-col items-start overflow-hidden">
      <p className="flex flex-col transition-transform duration-300 ease-out group-hover:-translate-y-[23px]">
        <strong className="text-[16px] font-medium leading-[19.2px] tracking-[-0.32px] text-[#e5e5e5]">
          {label}
        </strong>
      </p>
      <p
        aria-hidden
        className="absolute top-[23px] flex flex-col transition-transform duration-300 ease-out group-hover:-translate-y-[23px]"
      >
        <strong className="text-[16px] font-medium leading-[19.2px] tracking-[-0.32px] text-[#e5e5e5]">
          {label}
        </strong>
      </p>
    </div>
  );
}
