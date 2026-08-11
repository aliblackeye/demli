"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

type RevealTextProps = {
  text: string;
  /** word: kelime kelime (başlıklar) · char: karakter karakter (açıklamalar) */
  mode: "word" | "char";
  className?: string;
  as?: "span" | "p" | "h2" | "h3";
  stagger?: number;
};

/**
 * Referans deseni (ölçüldü): scroll-scrub DEĞİL — öğe görünür olunca
 * BİR KEZ oynayan kademeli opacity açılımı. Kelime adımı ~0.03s,
 * karakter adımı ~0.008s; parça başlangıcı opacity 0.001.
 * Boşluklar parçaların İÇİNDE kalır (normal U+0020) — satır kırma korunur.
 */
export function RevealText({ text, mode, className = "", as = "span", stagger }: RevealTextProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parts = el.querySelectorAll<HTMLElement>("[data-reveal-part]");
    gsap.set(parts, { opacity: 0.001 });
    const tween = gsap.to(parts, {
      opacity: 1,
      duration: 0.35,
      ease: "none",
      stagger: stagger ?? (mode === "word" ? 0.03 : 0.008),
      scrollTrigger: {
        trigger: el,
        start: "top 90%",
        once: true,
      },
    });
    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, [mode, stagger, text]);

  const Tag = as as "span";
  const pieces = mode === "word" ? text.split(/(?<= )/) : [...text];

  return (
    <Tag ref={ref as never} className={className} aria-label={text}>
      {pieces.map((p, i) => (
        <span key={i} aria-hidden data-reveal-part style={{ opacity: 0.001 }}>
          {p}
        </span>
      ))}
    </Tag>
  );
}
