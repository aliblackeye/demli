"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useIsMobile } from "./CardReveal";

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
  /** Ölçülen: kart başlıkları blur(10px)+y10 ile kelime kelime açılır */
  blurlu?: boolean;
  delay?: number;
};

/**
 * Referans deseni (ölçüldü): scroll-scrub DEĞİL — öğe görünür olunca
 * BİR KEZ oynayan kademeli opacity açılımı. Kelime adımı ~0.03s,
 * karakter adımı ~0.008s; parça başlangıcı opacity 0.001.
 * Boşluklar parçaların İÇİNDE kalır (normal U+0020) — satır kırma korunur.
 */
export function RevealText({ text, mode, className = "", as = "span", stagger, blurlu, delay }: RevealTextProps) {
  const ref = useRef<HTMLElement | null>(null);
  // Ölçülen: ref mobilde metin reveal'i YOK — düz RichText basıyor
  const mobil = useIsMobile();

  useEffect(() => {
    if (mobil) return;
    const el = ref.current;
    if (!el) return;
    const parts = el.querySelectorAll<HTMLElement>("[data-reveal-part]");
    if (blurlu) {
      // Ölçülen (kart başlığı): kelime başına blur(10px)+y10+opacity,
      // süre ~0.5, kademe ~70ms, başlangıç ~150ms
      gsap.set(parts, { opacity: 0.001, y: 10, filter: "blur(10px)" });
      const tween = gsap.to(parts, {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: 0.5,
        ease: "power2.out",
        delay: delay ?? 0.15,
        stagger: stagger ?? 0.07,
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
      return () => {
        tween.scrollTrigger?.kill();
        tween.kill();
      };
    }
    gsap.set(parts, { opacity: 0.001 });
    const tween = gsap.to(parts, {
      opacity: 1,
      duration: 0.35,
      ease: "none",
      delay: delay ?? 0,
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
  }, [mode, stagger, text, mobil, blurlu, delay]);

  const Tag = as as "span";
  // '\n' = yazarın satır kırılımı (ref RichText'inde var) — <br> olarak basılır
  const satirlar = text.split("\n");

  // Ölçülen: ref h3/desc white-space NORMAL (pre-wrap yalnız H2'lerde)
  if (mobil) {
    return (
      <Tag ref={ref as never} className={className}>
        {satirlar.map((s, i) => (
          <span key={i} className="contents">
            {i > 0 ? <br /> : null}
            {s}
          </span>
        ))}
      </Tag>
    );
  }

  let anahtar = 0;
  return (
    <Tag ref={ref as never} className={className} aria-label={text}>
      {satirlar.map((satir, si) => {
        const pieces = mode === "word" ? satir.split(/(?<= )/) : [...satir];
        return (
          <span key={si} className="contents">
            {si > 0 ? <br /> : null}
            {pieces.map((p) => (
              <span key={anahtar++} aria-hidden data-reveal-part style={{ opacity: 0.001 }}>
                {p}
              </span>
            ))}
          </span>
        );
      })}
    </Tag>
  );
}
