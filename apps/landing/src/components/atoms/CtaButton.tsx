"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { SLIDE_SPRING, slideVariants } from "./SlideHoverText";

type CtaButtonProps = {
  /** Yüzen CTA: mobilde 16px metin (ölçülen 177 genişlik) */
  mobileSmall?: boolean;
  href: string;
  label: string;
  /** primary: beyaz zemin koyu metin · secondary: #262626 zemin açık metin */
  variant: "primary" | "secondary";
  /** Sol tarafa ikon (ör. play) */
  icon?: ReactNode;
  /** Dış bağlantı: yeni sekmede açılır */
  external?: boolean;
};

/**
 * Ölçülen: radius 18px, padding 16px 32px (ikonluda sol 24px), metin
 * Inter 500 18px/25.2px; kayan hover kopyası 29px altta —
 * authored hover geçişi spring { bounce .2, duration .4 }.
 */
export function CtaButton({ href, label, variant, icon, mobileSmall, external }: CtaButtonProps) {
  // Ölçülen (390): CTA metni mobilde 16px/24 (tb+ 18px/25.2)
  const textCls =
    (mobileSmall
      ? "whitespace-nowrap text-[16px] font-medium leading-[1.4] tb:text-[18px] "
      : "whitespace-nowrap text-[16px] font-medium leading-[24px] tb:text-[18px] tb:leading-[25.2px] ") +
    (variant === "primary" ? "text-surface" : "text-text-primary");
  return (
    <motion.a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      initial="rest"
      animate="rest"
      whileHover="hover"
      className={
        "group flex w-full items-center justify-center gap-2 rounded-[18px] py-4 tb:w-auto " +
        (icon ? "pl-6 pr-8 " : "px-8 ") +
        (variant === "primary" ? "bg-white" : "bg-surface-2")
      }
    >
      {icon}
      <div className={"relative flex flex-col items-start overflow-hidden " + (mobileSmall ? "h-[25px]" : "h-6 tb:h-[25px]")}>
        <motion.div variants={slideVariants(29)} transition={SLIDE_SPRING} className="flex flex-col">
          <strong className={textCls}>{label}</strong>
        </motion.div>
        <motion.div
          aria-hidden
          variants={slideVariants(29)}
          transition={SLIDE_SPRING}
          className="absolute top-[29px] flex flex-col"
        >
          <strong className={textCls}>{label}</strong>
        </motion.div>
      </div>
    </motion.a>
  );
}
