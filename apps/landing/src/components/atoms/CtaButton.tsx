"use client";

import type { ReactNode } from "react";

type CtaButtonProps = {
  /** Yüzen CTA: mobilde 16px metin (ölçülen 177×57 yerine ~197) */
  mobileSmall?: boolean;
  href: string;
  label: string;
  /** primary: beyaz zemin koyu metin · secondary: #262626 zemin açık metin */
  variant: "primary" | "secondary";
  /** Sol tarafa ikon (ör. play) */
  icon?: ReactNode;
};

/**
 * Ölçülen: radius 18px, padding 16px 32px (ikonluda sol 24px), metin
 * Inter 500 18px/25.2px; kayan hover kopyası 29px altta.
 */
export function CtaButton({ href, label, variant, icon, mobileSmall }: CtaButtonProps) {
  return (
    <a
      href={href}
      className={
        "group flex w-full items-center justify-center gap-2 rounded-[18px] py-4 tb:w-auto " +
        (icon ? "pl-6 pr-8 " : "px-8 ") +
        (variant === "primary" ? "bg-white" : "bg-surface-2")
      }
    >
      {icon}
      <div className="relative flex h-[25px] flex-col items-start overflow-hidden">
        <div className="flex flex-col transition-transform duration-300 ease-out group-hover:-translate-y-[29px]">
          <strong
            className={
              (mobileSmall ? "whitespace-nowrap text-[16px] font-medium leading-[1.4] tb:text-[18px] " : "whitespace-nowrap text-[18px] font-medium leading-[1.4] ") +
              (variant === "primary" ? "text-surface" : "text-text-primary")
            }
          >
            {label}
          </strong>
        </div>
        <div
          aria-hidden
          className="absolute top-[29px] flex flex-col transition-transform duration-300 ease-out group-hover:-translate-y-[29px]"
        >
          <strong
            className={
              (mobileSmall ? "whitespace-nowrap text-[16px] font-medium leading-[1.4] tb:text-[18px] " : "whitespace-nowrap text-[18px] font-medium leading-[1.4] ") +
              (variant === "primary" ? "text-surface" : "text-text-primary")
            }
          >
            {label}
          </strong>
        </div>
      </div>
    </a>
  );
}
